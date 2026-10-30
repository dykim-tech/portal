import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { validateEvent, todoText } from '../server/calendar.mjs';

test('calendar event validation and todo label', () => {
  assert.deepEqual(validateEvent({ date: '2026-10-30', time: '09:30', title: ' 회의 ' }), { date: '2026-10-30', time: '09:30', title: '회의' });
  assert.deepEqual(validateEvent({ date: '2026-10-30', title: '종일' }), { date: '2026-10-30', time: '', title: '종일' });
  assert.throws(() => validateEvent({ date: '2026-02-30', title: 'x' }), /날짜/);
  assert.throws(() => validateEvent({ date: '2026-10-30', time: '24:00', title: 'x' }), /시각/);
  assert.throws(() => validateEvent({ date: '2026-10-30', title: '  ' }), /내용/);
  assert.throws(() => validateEvent({ date: '2026-10-30', title: 'x'.repeat(101) }), /100자/);
  assert.equal(todoText({ title: '', body: '\n  GYSMONi 설계도 확인\nGYSMONi Request' }), 'GYSMONi 설계도 확인');
  assert.equal(todoText({ title: '제목', body: '내용' }), '제목');
  assert.equal(todoText({ title: '', body: '' }), '(내용 없음)');
});

test('calendar events are per user and the calendar shows own TO-DO items by target date', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-cal-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin, selfCheck: false, draftMailPollMs: 0, nasMeasureCheckMs: 0, holidayFetch: null });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    await call('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' });
    const admin = (await call('/auth/login', 'POST', { username: 'admin', password: 'test-password-1234' })).cookie;
    await call('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin);
    const viewer = (await call('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;
    const range = '/calendar-events?from=2026-10-01&to=2026-10-31';

    assert.equal((await call(range)).status, 401);
    assert.equal((await call('/calendar-events?from=2026-10-31&to=2026-10-01', 'GET', undefined, admin)).status, 400);
    assert.equal((await call('/calendar-events?from=2026-01-01&to=2027-12-31', 'GET', undefined, admin)).status, 400);
    const a = (await call('/calendar-events', 'POST', { date: '2026-10-30', time: '14:00', title: '고객 미팅' }, admin));
    assert.equal(a.status, 201);
    await call('/calendar-events', 'POST', { date: '2026-10-30', title: '휴가 신청' }, admin);
    await call('/calendar-events', 'POST', { date: '2026-11-02', title: '다음 달 일정' }, admin);
    assert.equal((await call('/calendar-events', 'POST', { date: '2026-10-30', title: '' }, admin)).status, 400);

    // TO-DO 메모: 목표 날짜에 표시, 잠긴 메모는 내용 없이
    const todo = (await call('/todos', 'POST', { title: '', body: '견적서 회신\n세부 내용', target_date: '2026-10-30' }, admin)).data.todo;
    portal.db.prepare("INSERT INTO todos(user_id,title,body,target_date,created_at,updated_at,lock_hash) VALUES(?,'비밀','비밀 내용','2026-10-30',?,?,'x')").run(todo.user_id, todo.created_at, todo.created_at);

    const month = (await call(range, 'GET', undefined, admin)).data;
    assert.deepEqual(month.events.map(e => [e.date, e.time, e.title]), [['2026-10-30', '', '휴가 신청'], ['2026-10-30', '14:00', '고객 미팅']]);
    assert.deepEqual(month.todos.map(t => [t.date, t.text, t.locked, t.done]), [['2026-10-30', '견적서 회신', false, false], ['2026-10-30', '', true, false]]);
    assert.equal(JSON.stringify(month.todos).includes('비밀'), false);

    // 다른 사용자에게는 보이지 않고, 지우거나 고칠 수 없다
    const other = (await call(range, 'GET', undefined, viewer)).data;
    assert.deepEqual([other.events.length, other.todos.length], [0, 0]);
    assert.equal((await call('/calendar-events/' + a.data.event.id, 'DELETE', undefined, viewer)).status, 404);
    assert.equal((await call('/calendar-events/' + a.data.event.id, 'PUT', { date: '2026-10-30', title: 'x' }, viewer)).status, 404);

    assert.equal((await call('/calendar-events/' + a.data.event.id, 'PUT', { date: '2026-10-31', time: '', title: '미팅 연기' }, admin)).data.event.date, '2026-10-31');
    assert.equal((await call('/calendar-events/' + a.data.event.id, 'DELETE', undefined, admin)).status, 200);
    assert.equal((await call(range, 'GET', undefined, admin)).data.events.length, 1);

    // 통합 검색에도 본인 일정만 나온다
    const found = (await call('/search?q=' + encodeURIComponent('다음 달'), 'GET', undefined, admin)).data.groups.find(g => g.id === 'events');
    assert.equal(found.rows[0].date, '2026-11-02');
    assert.equal((await call('/search?q=' + encodeURIComponent('다음 달'), 'GET', undefined, viewer)).data.total, 0);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
