import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPortal } from '../server/app.mjs';

test('existing email accounts receive stable unique login IDs', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-user-migrate-'));
  const legacy = new DatabaseSync(join(dataDir, 'portal.sqlite'));
  legacy.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)");
  legacy.prepare("INSERT INTO users(name,email,password,role,created_at) VALUES(?,?,?,?,?)").run('관리자 A', 'admin@one.test', 'unused', 'admin', '2026-01-01');
  legacy.prepare("INSERT INTO users(name,email,password,role,created_at) VALUES(?,?,?,?,?)").run('관리자 B', 'admin@two.test', 'unused', 'admin', '2026-01-01');
  legacy.close();
  const portal = createPortal({ dataDir });
  try { assert.deepEqual(portal.db.prepare('SELECT username FROM users ORDER BY id').all().map(row => row.username), ['admin', 'admin-2']); }
  finally { portal.db.close(); }
  const reopened = createPortal({ dataDir });
  try { assert.deepEqual(reopened.db.prepare('SELECT username FROM users ORDER BY id').all().map(row => row.username), ['admin', 'admin-2']); }
  finally { reopened.db.close(); }
});

test('ID login and sorting apply to the full paginated result', async () => {
  const origin = 'http://localhost:3199';
  const portal = createPortal({ dataDir: mkdtempSync(join(tmpdir(), 'portal-listing-')), origin });
  const server = portal.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  try {
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'portal-admin', email: 'admin@example.test', password: 'test-password-1234' });
    assert.equal(setup.status, 201);
    cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/auth/login', 'POST', { username: 'PORTAL-ADMIN', password: 'test-password-1234' })).status, 200);
    assert.equal((await request('/auth/login', 'POST', { email: 'admin@example.test', password: 'test-password-1234' })).status, 400);
    assert.equal((await request('/users', 'POST', { name: '중복', username: 'PORTAL-ADMIN', email: 'other@example.test', role: 'viewer', password: 'test-password-1234' })).status, 409);
    const insert = portal.db.prepare('INSERT INTO installations(name,customer,installed_on,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    for (let n = 1; n <= 75; n++) insert.run(`제품-${String(n).padStart(3, '0')}`, '테스트 고객', '2026-10-01', 'installed', 1, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
    const first = await request('/installations?sort=name&direction=asc&page_size=70&page=1');
    assert.equal(first.data.installations.length, 70);
    assert.equal(first.data.installations[0].name, '제품-001');
    const second = await request('/installations?sort=name&direction=asc&page_size=70&page=2');
    assert.equal(second.data.installations.length, 5);
    assert.equal(second.data.installations[0].name, '제품-071');
    assert.equal((await request('/installations?sort=name&direction=desc&page_size=100')).data.installations[0].name, '제품-075');
    assert.equal((await request('/installations?page_size=71')).status, 400);
    assert.equal((await request('/installations?sort=invalid')).status, 400);
    assert.equal((await request('/items?page_size=70')).data.page_size, 70);
    assert.equal((await request('/library?page_size=100')).data.page_size, 100);
    assert.equal((await request('/work-logs?page_size=25')).data.page_size, 25);
    assert.equal((await request('/items?sort=file_count&direction=desc')).status, 200);
    assert.equal((await request('/library?sort=type&direction=asc')).status, 200);
    assert.equal((await request('/work-logs?sort=customer&direction=asc')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
});
