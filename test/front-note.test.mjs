import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { removeStalePartials, STALE_PARTIAL_MS } from '../server/backups.mjs';

test('dashboard memo notes: always two per user, autosave with version check, migration and tidy-up', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-note-'));
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

    assert.equal((await call('/dashboard-notes')).status, 401);
    // 예전 한 장짜리 메모는 첫 메모로 옮겨지고, 메모장은 항상 2장이다
    const adminId = portal.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    portal.db.prepare("INSERT INTO user_notes(user_id, body, version, updated_at) VALUES(?, '예전 메모', 3, '2026-10-29T00:00:00.000Z')").run(adminId);
    const first = (await call('/dashboard-notes', 'GET', undefined, admin)).data;
    assert.equal(first.max, 2); assert.deepEqual(first.notes.map(n => n.body), ['예전 메모', '']);
    const [id1, id2] = first.notes.map(n => n.id);
    const saved = (await call('/dashboard-notes/' + id1, 'PUT', { body: '오늘 할 일\n- 견적 회신', version: 1 }, admin)).data.note;
    assert.equal(saved.body, '오늘 할 일\n- 견적 회신'); assert.equal(saved.version, 2); assert.ok(saved.updated_at);
    assert.equal((await call('/dashboard-notes/' + id2, 'PUT', { body: '둘째', version: 1 }, admin)).data.note.body, '둘째');
    // 다른 창의 옛 버전으로 저장하면 덮어쓰지 않는다
    const stale = await call('/dashboard-notes/' + id1, 'PUT', { body: '옛 내용', version: 1 }, admin);
    assert.equal(stale.status, 409); assert.equal(stale.data.note.body, '오늘 할 일\n- 견적 회신');
    // 추가 기능은 없다
    assert.equal((await call('/dashboard-notes', 'POST', {}, admin)).status, 404);
    // 예전에 4장까지 만들었던 경우: 빈 메모는 정리하고 내용이 있는 메모는 남긴다
    const now = new Date().toISOString();
    portal.db.prepare("INSERT INTO dashboard_notes(user_id, body, created_at) VALUES(?, '', ?)").run(adminId, now);
    const kept = portal.db.prepare("INSERT INTO dashboard_notes(user_id, body, created_at) VALUES(?, '남길 내용', ?)").run(adminId, now).lastInsertRowid;
    portal.db.prepare("INSERT INTO dashboard_notes(user_id, body, created_at) VALUES(?, '  ', ?)").run(adminId, now);
    const tidy = (await call('/dashboard-notes', 'GET', undefined, admin)).data.notes;
    assert.deepEqual(tidy.map(n => n.body), ['오늘 할 일\n- 견적 회신', '둘째', '남길 내용']);
    // 남은 3번째 메모를 지우면 2장이 된다
    assert.equal((await call('/dashboard-notes/' + kept, 'DELETE', undefined, admin)).data.notes.length, 2);
    // 조회자도 자기 메모장 2장을 쓰고, 사용자끼리 섞이지 않는다
    const vnotes = (await call('/dashboard-notes', 'GET', undefined, viewer)).data.notes;
    assert.deepEqual(vnotes.map(n => n.body), ['', '']);
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 'x', version: 2 }, viewer)).status, 404);
    assert.equal((await call('/dashboard-notes/' + id1, 'DELETE', undefined, viewer)).status, 404);
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 'x'.repeat(5001), version: 2 }, admin)).status, 400);
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 1, version: 2 }, admin)).status, 400);
    // 2장 중 하나를 지워도 빈 메모로 다시 2장이 된다
    const after = (await call('/dashboard-notes/' + id2, 'DELETE', undefined, admin)).data.notes;
    assert.equal(after.length, 2); assert.equal(after[1].body, '');
  } finally { await new Promise(r => server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('stale .partial backups left by an interrupted backup are removed; recent ones are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-partial-'));
  try {
    const old = join(dir, 'portal-2026-10-27T13-36-45-445Z-869bcb.sqlite.partial'), recent = join(dir, 'portal-2026-10-28T00-00-55-543Z-f5252b.sqlite.partial'), keep = join(dir, 'portal-2026-10-26T11-37-44-751Z-a3dfbd.sqlite');
    for (const path of [old, old + '-journal', recent, keep]) writeFileSync(path, 'x');
    const now = Date.now(), past = (now - STALE_PARTIAL_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    assert.equal(removeStalePartials(dir, now), 2);
    assert.equal(existsSync(old), false); assert.equal(existsSync(old + '-journal'), false);
    assert.equal(existsSync(recent), true, '진행 중일 수 있는 최근 .partial은 남긴다');
    assert.equal(existsSync(keep), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
