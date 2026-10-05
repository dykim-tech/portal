import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('dashboard lists open todos and recent projects; usage is admin-only', async t => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-dashboard-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, method = 'GET', body, cookie = '') {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null) };
  }
  async function login(username, password) {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return response.headers.get('set-cookie').split(';')[0];
  }
  try {
    assert.equal((await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = await login('admin', 'test-password-1234');
    assert.equal((await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin)).status, 201);
    const viewer = await login('viewer', 'test-password-1234');

    await t.test('dashboard shows only the signed-in user\'s unfinished todos', async () => {
      const open = (await request('/todos', 'POST', { title: '', body: '미완료 메모' }, admin)).data.todo.id;
      const done = (await request('/todos', 'POST', { title: '', body: '완료 메모' }, admin)).data.todo.id;
      assert.equal((await request('/todos/' + done, 'PATCH', { done: true }, admin)).status, 200);
      await request('/todos', 'POST', { title: '', body: '다른 사용자 메모' }, viewer);
      const dashboard = (await request('/dashboard', 'GET', undefined, admin)).data;
      assert.deepEqual(dashboard.openTodos.map(row => row.id), [open]);
      assert.equal(dashboard.openTodoCount, 1);
    });

    await t.test('dashboard shows the three most recently updated projects', async () => {
      const ids = [];
      for (const name of ['P1', 'P2', 'P3', 'P4']) {
        const created = await request('/projects', 'POST', { name, kind: 'other', phase: 'before', status: 'planned' }, admin);
        assert.equal(created.status, 201, JSON.stringify(created.data));
        ids.push(created.data.id ?? created.data.project?.id);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const dashboard = (await request('/dashboard', 'GET', undefined, admin)).data;
      assert.deepEqual(dashboard.recentProjects.map(row => row.name), ['P4', 'P3', 'P2']);
    });

    await t.test('usage reports drive, data files and attachment totals to admins only', async () => {
      const form = new FormData(); form.append('file', new Blob(['12345']), 'usage.txt');
      assert.equal((await request('/manuals?folder=', 'POST', form, admin)).status, 201);
      const usage = await request('/usage', 'GET', undefined, admin);
      assert.equal(usage.status, 200);
      assert.ok(usage.data.drives.length >= 1);
      assert.ok(usage.data.drives[0].total > 0 && usage.data.drives[0].free >= 0);
      assert.ok(usage.data.storage.find(row => row.key === 'database').size > 0);
      assert.deepEqual(usage.data.attachments.find(row => row.key === 'manuals'), { key: 'manuals', label: '자료 관리', count: 1, size: 5 });
      assert.equal((await request('/usage', 'GET', undefined, viewer)).status, 403);
      assert.equal((await request('/usage')).status, 401);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
});

test('operator manual is listed in operations and downloads as a PDF for admins only', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-manual-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, cookie = '') => fetch(base + '/api' + path, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/auth/setup', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = (await post('/auth/login', { username: 'admin', password: 'test-password-1234' })).headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/users', { name: '편집자', username: 'editor', email: 'editor@example.test', role: 'editor', password: 'test-password-1234' }, admin)).status, 201);
    const editor = (await post('/auth/login', { username: 'editor', password: 'test-password-1234' })).headers.get('set-cookie').split(';')[0];
    const operations = await (await fetch(base + '/api/operations', { headers: { Cookie: admin } })).json();
    const manual = operations.documents.find(doc => doc.name === 'OPERATOR_MANUAL.md');
    assert.equal(manual.title, '운영자 매뉴얼');
    assert.equal(manual.pdf, '/api/operations/manual.pdf');
    assert.match(manual.content, /서비스 기동 절차/);
    assert.match(manual.content, /메뉴별 사용법/);
    const pdf = await fetch(base + '/api/operations/manual.pdf', { headers: { Cookie: admin } });
    if (pdf.status === 503) { assert.match((await pdf.json()).error, /글꼴/); return; }
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/octet-stream');
    assert.match(pdf.headers.get('content-disposition'), /attachment/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(bytes.length > 10000);
    assert.equal((await fetch(base + '/api/operations/manual.pdf', { headers: { Cookie: editor } })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
});
