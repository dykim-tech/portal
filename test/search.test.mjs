import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { parseQuery, snippet } from '../server/search.mjs';
import { parseIcsHolidays } from '../server/holidays.mjs';

async function start(options = {}) {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-search-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin, selfCheck: false, draftMailPollMs: 0, nasMeasureCheckMs: 0, holidayFetch: null, ...options });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await call('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
  const admin = (await call('/auth/login', 'POST', { username: 'admin', password: 'test-password-1234' })).cookie;
  await call('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin);
  const viewer = (await call('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;
  const stop = async () => { await new Promise(r => server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); };
  return { portal, call, admin, viewer, stop };
}

test('search helpers: query terms and snippet', () => {
  assert.throws(() => parseQuery('  '), /검색어/);
  assert.throws(() => parseQuery('x'.repeat(101)), /100자/);
  assert.deepEqual(parseQuery(' 서버  점검 서버 ').terms, ['서버', '점검']);
  assert.equal(snippet('앞 내용 ' + 'a'.repeat(100) + ' 서버 점검 결과', ['점검'], 10), '…aaaaaa 서버 점검 결과');
  assert.equal(snippet('없는 내용', ['점검']), '');
});

test('portal-wide search finds records, contents and attachment names; respects todo owner and lock', async () => {
  const { portal, call, admin, viewer, stop } = await start();
  try {
    const db = portal.db, now = '2026-10-28T00:00:00.000Z';
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    const draft = db.prepare("INSERT INTO drafts(title,draft_date,drafter,content,created_by,updated_by,created_at,updated_at,doc_no) VALUES('장비 구매','2026-10-28','김동엽','서버 점검용 스위치 구매 요청',?,?,?,?,'GRACECNS-RQ-261028-1')").run(adminId, adminId, now, now).lastInsertRowid;
    const meeting = db.prepare("INSERT INTO meetings(title,meeting_date,content,decisions,created_by,updated_by,created_at,updated_at) VALUES('주간 회의','2026-10-27','진행 상황 공유','다음 주 서버 교체',?,?,?,?)").run(adminId, adminId, now, now).lastInsertRowid;
    db.prepare("INSERT INTO meeting_actions(meeting_id,task,created_at) VALUES(?,'백업 점검 일정 잡기',?)").run(meeting, now);
    db.prepare("INSERT INTO todos(user_id,title,body,target_date,created_at,updated_at) VALUES(?,'서버 점검 메모','',?,?,?)").run(adminId, '2026-10-28', now, now);
    db.prepare("INSERT INTO todos(user_id,title,body,target_date,created_at,updated_at,lock_hash) VALUES(?,'잠긴 서버 메모','',?,?,?,'x')").run(adminId, '2026-10-28', now, now);
    const folder = db.prepare("INSERT INTO folders(name,created_at) VALUES('서버 매뉴얼',?)").run(now).lastInsertRowid;
    db.prepare("INSERT INTO manuals(folder_id,name,size,bytes,preview_type,uploaded_by,created_at) VALUES(?,'서버_설치_가이드.pdf',3,?, 'pdf',?,?)").run(folder, Buffer.from('abc'), adminId, now);
    db.prepare("INSERT INTO library_links(folder_id,name,url,created_by,created_at,updated_at) VALUES(?,'OMV 문서','https://docs.openmediavault.org/',?,?,?)").run(folder, adminId, now, now);
    db.prepare("INSERT INTO draft_files(draft_id,name,size,bytes,uploaded_by,created_at) VALUES(?,'서버_견적서.xlsx',3,?,?,?)").run(draft, Buffer.from('abc'), adminId, now);

    assert.equal((await call('/search?q=', 'GET', undefined, admin)).status, 400);
    assert.equal((await call('/search?q=서버')).status, 401);

    const all = (await call('/search?q=' + encodeURIComponent('서버'), 'GET', undefined, admin)).data;
    const byId = Object.fromEntries(all.groups.map(g => [g.id, g]));
    assert.equal(byId.drafts.rows[0].id, Number(draft));
    assert.match(byId.drafts.rows[0].snippet, /서버 점검용/);
    assert.equal(byId.meetings.rows[0].id, Number(meeting));
    assert.equal(byId.todos.total, 1, '잠긴 메모는 찾지 않는다');
    assert.equal(byId.folders.rows[0].title, '서버 매뉴얼');
    assert.equal(byId.manuals.rows[0].folder_id, Number(folder));
    assert.equal(byId.manuals.rows[0].preview_type, 'pdf');
    assert.deepEqual(byId.attachments.rows.map(r => [r.kind, r.parent_id, r.title]), [['drafts', Number(draft), '서버_견적서.xlsx']]);

    // 모든 낱말이 들어 있어야 한다(회의 할 일 + 결정 사항)
    const both = (await call('/search?q=' + encodeURIComponent('백업 교체'), 'GET', undefined, admin)).data;
    assert.deepEqual(both.groups.map(g => g.id), ['meetings']);
    // LIKE 특수문자는 글자 그대로 찾는다
    assert.equal((await call('/search?q=' + encodeURIComponent('%'), 'GET', undefined, admin)).data.total, 0);
    // 링크 주소
    assert.equal((await call('/search?q=openmediavault', 'GET', undefined, admin)).data.groups[0].rows[0].url, 'https://docs.openmediavault.org/');

    // 다른 사용자의 TO-DO는 보이지 않는다
    const other = (await call('/search?q=' + encodeURIComponent('서버'), 'GET', undefined, viewer)).data;
    assert.equal(other.groups.some(g => g.id === 'todos'), false);
    assert.equal(other.groups.some(g => g.id === 'drafts'), true);
  } finally { await stop(); }
});

test('quick menu chips are portal-wide and admin-only', async () => {
  const { call, admin, viewer, stop } = await start();
  try {
    assert.deepEqual((await call('/auth/me', 'GET', undefined, viewer)).data.user.quick_menus, ['drafts', 'meetings', 'library', 'work']);
    assert.equal((await call('/menu-settings/quick', 'PUT', { ids: ['nas-site'] }, viewer)).status, 403);
    assert.equal((await call('/menu-settings/quick', 'PUT', { ids: ['Bad id'] }, admin)).status, 400);
    assert.equal((await call('/menu-settings/quick', 'PUT', { ids: ['a', 'a'] }, admin)).status, 400);
    assert.deepEqual((await call('/menu-settings/quick', 'PUT', { ids: ['drafts', 'nas-site', 'nasadmin'] }, admin)).data, { ids: ['drafts', 'nas-site', 'nasadmin'] });
    assert.deepEqual((await call('/auth/me', 'GET', undefined, viewer)).data.user.quick_menus, ['drafts', 'nas-site', 'nasadmin']);
    assert.deepEqual((await call('/menu-settings/quick', 'PUT', { ids: [] }, admin)).data, { ids: [] });
    assert.deepEqual((await call('/auth/me', 'GET', undefined, viewer)).data.user.quick_menus, []);
  } finally { await stop(); }
});

const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261003', 'DESCRIPTION:공휴일', 'SUMMARY:개천절', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261001', 'DESCRIPTION:기념일\\n기념일을 숨기려면', 'SUMMARY:국군의 날', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261005', 'DESCRIPTION:공휴일', 'SUMMARY:대체 공휴일 ', ' (개천절)', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270101', 'DESCRIPTION:공휴일', 'SUMMARY:신정', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('holiday ICS parsing keeps public holidays only', () => {
  assert.deepEqual(parseIcsHolidays(ics), [{ date: '2026-10-03', name: '개천절' }, { date: '2026-10-05', name: '대체 공휴일 (개천절)' }, { date: '2027-01-01', name: '신정' }]);
});

test('holidays API fetches once, caches, filters by year and reports failures', async () => {
  let calls = 0;
  const { call, admin, stop } = await start({ holidayFetch: async url => { calls++; assert.match(url, /south_korea/); return new Response(ics, { status: 200 }); } });
  try {
    const first = (await call('/holidays?year=2026', 'GET', undefined, admin)).data;
    assert.deepEqual(first.holidays.map(h => h.date), ['2026-10-03', '2026-10-05']);
    assert.match(first.source, /Google/);
    assert.ok(first.fetched_at);
    assert.equal((await call('/holidays', 'GET', undefined, admin)).data.holidays.length, 3);
    assert.equal(calls, 1);
  } finally { await stop(); }
  const failing = await start({ holidayFetch: async () => new Response('', { status: 503 }) });
  try {
    const data = (await failing.call('/holidays', 'GET', undefined, failing.admin)).data;
    assert.deepEqual(data.holidays, []);
    assert.match(data.error, /HTTP 503/);
  } finally { await failing.stop(); }
});
