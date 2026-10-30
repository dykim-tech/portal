import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { removeStalePartials, STALE_PARTIAL_MS } from '../server/backups.mjs';

test('dashboard memo notes: up to 4 per user, autosave with version check, migration from the single note', async () => {
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
    // 예전 한 장짜리 메모는 첫 메모로 옮겨진다
    const adminId = portal.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    portal.db.prepare("INSERT INTO user_notes(user_id, body, version, updated_at) VALUES(?, '예전 메모', 3, '2026-10-29T00:00:00.000Z')").run(adminId);
    const first = (await call('/dashboard-notes', 'GET', undefined, admin)).data;
    assert.equal(first.max, 4); assert.equal(first.notes.length, 1); assert.equal(first.notes[0].body, '예전 메모');
    const id1 = first.notes[0].id;
    const saved = (await call('/dashboard-notes/' + id1, 'PUT', { body: '오늘 할 일\n- 견적 회신', version: 1 }, admin)).data.note;
    assert.equal(saved.body, '오늘 할 일\n- 견적 회신'); assert.equal(saved.version, 2); assert.ok(saved.updated_at);
    // 다른 창의 옛 버전으로 저장하면 덮어쓰지 않는다
    const stale = await call('/dashboard-notes/' + id1, 'PUT', { body: '옛 내용', version: 1 }, admin);
    assert.equal(stale.status, 409); assert.equal(stale.data.note.body, '오늘 할 일\n- 견적 회신');
    // 최대 4장
    for (let i = 0; i < 3; i++) assert.equal((await call('/dashboard-notes', 'POST', {}, admin)).status, 201);
    assert.equal((await call('/dashboard-notes', 'POST', {}, admin)).status, 409);
    const four = (await call('/dashboard-notes', 'GET', undefined, admin)).data.notes;
    assert.equal(four.length, 4);
    // 조회자도 자기 메모를 쓰고, 사용자끼리 섞이지 않는다
    const vnotes = (await call('/dashboard-notes', 'GET', undefined, viewer)).data.notes;
    assert.equal(vnotes.length, 1); assert.equal(vnotes[0].body, '');
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 'x', version: 2 }, viewer)).status, 404);
    assert.equal((await call('/dashboard-notes/' + id1, 'DELETE', undefined, viewer)).status, 404);
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 'x'.repeat(5001), version: 2 }, admin)).status, 400);
    assert.equal((await call('/dashboard-notes/' + id1, 'PUT', { body: 1, version: 2 }, admin)).status, 400);
    // 삭제: 모두 지우면 빈 메모 1장이 다시 생긴다
    for (const note of four.slice(1)) await call('/dashboard-notes/' + note.id, 'DELETE', undefined, admin);
    const last = (await call('/dashboard-notes/' + id1, 'DELETE', undefined, admin)).data.notes;
    assert.equal(last.length, 1); assert.equal(last[0].body, ''); assert.notEqual(last[0].id, id1);
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
