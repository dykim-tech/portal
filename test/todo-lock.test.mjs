import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { koreaDate } from '../server/db.mjs';

test('todo memos keep a free position and can be locked with their own password', async () => {
  const origin = 'http://localhost:3000', dataDir = mkdtempSync(join(tmpdir(), 'portal-todo-lock-'));
  const portal = createPortal({ dataDir, origin, selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  try {
    const admin = (await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).cookie;
    const placed = await request('/todos', 'POST', { title: '', body: '자리 지정', target_date: koreaDate(), pos_x: 320, pos_y: 40 }, admin);
    assert.equal(placed.status, 201); assert.equal(placed.data.todo.pos_x, 320); assert.equal(placed.data.todo.pos_y, 40); assert.equal(placed.data.todo.locked, false);
    const id = placed.data.todo.id, before = placed.data.todo.updated_at;

    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request(`/todos/${id}/position`, 'PUT', { x: 15, y: 260 }, admin)).status, 200);
    assert.equal((await request(`/todos/${id}/position`, 'PUT', { x: -1, y: 0 }, admin)).status, 400);
    assert.equal((await request(`/todos/${id}/position`, 'PUT', { x: 1.5, y: 0 }, admin)).status, 400);
    let row = (await request('/todos', 'GET', undefined, admin)).data.todos.find(t => t.id === id);
    assert.deepEqual([row.pos_x, row.pos_y], [15, 260]);
    assert.equal(row.updated_at, before, 'moving a memo does not change its updated time');
    assert.ok(!('lock_hash' in row));

    const attachment = new FormData(); attachment.append('file', new Blob(['secret file']), 'secret.txt');
    const fileId = (await (await fetch(`${base}/api/todos/${id}/files`, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: admin }, body: attachment })).json()).id;

    assert.equal((await request(`/todos/${id}/lock`, 'POST', { password: '123' }, admin)).status, 400);
    const locked = await request(`/todos/${id}/lock`, 'POST', { password: 'memo-pass' }, admin);
    assert.equal(locked.status, 200); assert.equal(locked.data.todo.locked, true); assert.equal(locked.data.todo.body, ''); assert.ok(!('lock_hash' in locked.data.todo));

    row = (await request('/todos', 'GET', undefined, admin)).data.todos.find(t => t.id === id);
    assert.equal(row.body, ''); assert.equal(row.locked, true); assert.deepEqual(row.files, []);
    assert.equal((await request('/todos?q=' + encodeURIComponent('자리'), 'GET', undefined, admin)).data.todos.length, 0, 'search does not match locked content');
    const dashboard = (await request('/dashboard', 'GET', undefined, admin)).data.openTodos.find(t => t.id === id);
    assert.equal(dashboard.body, ''); assert.equal(dashboard.locked, 1);
    assert.equal((await request(`/todos/${id}`, 'PUT', { title: '', body: '바꾸기', target_date: koreaDate() }, admin)).status, 423);
    assert.equal((await fetch(`${base}/api/todo-files/${fileId}/download`, { headers: { Cookie: admin } })).status, 404);
    assert.equal((await request(`/todo-files/${fileId}`, 'DELETE', undefined, admin)).status, 404);
    assert.equal((await request(`/todos/${id}/lock`, 'POST', { password: 'another' }, admin)).status, 423);
    assert.equal((await request(`/todos/${id}/position`, 'PUT', { x: 30, y: 30 }, admin)).status, 200, 'locked memos can still be moved');

    assert.equal((await request(`/todos/${id}/unlock`, 'POST', { password: 'wrong' }, admin)).status, 403);
    const opened = await request(`/todos/${id}/unlock`, 'POST', { password: 'memo-pass' }, admin);
    assert.equal(opened.status, 200); assert.equal(opened.data.todo.locked, false); assert.equal(opened.data.todo.body, '자리 지정'); assert.equal(opened.data.todo.files[0].name, 'secret.txt');
    assert.equal(await (await fetch(`${base}/api/todo-files/${fileId}/download`, { headers: { Cookie: admin } })).text(), 'secret file');

    // 5번 틀리면 1분 동안 잠금 해제를 막는다.
    await request(`/todos/${id}/lock`, 'POST', { password: 'memo-pass' }, admin);
    for (let i = 0; i < 5; i++) assert.equal((await request(`/todos/${id}/unlock`, 'POST', { password: 'nope' + i }, admin)).status, 403);
    assert.equal((await request(`/todos/${id}/unlock`, 'POST', { password: 'memo-pass' }, admin)).status, 429);

    // 다른 사용자는 내 메모를 옮기거나 풀 수 없다.
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' }, admin);
    const viewer = (await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;
    assert.equal((await request(`/todos/${id}/position`, 'PUT', { x: 0, y: 0 }, viewer)).status, 404);
    assert.equal((await request(`/todos/${id}/unlock`, 'POST', { password: 'memo-pass' }, viewer)).status, 404);
    assert.equal((await request(`/todos/${id}`, 'DELETE', undefined, admin)).status, 200, 'a locked memo can still be deleted by its owner');
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
