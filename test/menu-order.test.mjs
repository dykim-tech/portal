import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('menu order is saved on the user account and survives logout', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-menu-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await call('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    let login = await call('/auth/login', 'POST', { username: 'admin', password: 'test-password-1234' });
    assert.equal(login.data.user.menu_order, null);
    const order = ['dashboard', 'outlook', 'library', 'settings'];
    assert.equal((await call('/auth/menu-order', 'PUT', { order }, login.cookie)).status, 200);
    assert.equal((await call('/auth/logout', 'POST', {}, login.cookie)).status, 200);
    login = await call('/auth/login', 'POST', { username: 'admin', password: 'test-password-1234' });
    assert.deepEqual(login.data.user.menu_order, order, 'login returns the saved order');
    assert.deepEqual((await call('/auth/me', 'GET', undefined, login.cookie)).data.user.menu_order, order);
    for (const bad of [['dashboard', 'dashboard'], ['<script>'], 'dashboard', [1, 2]]) assert.equal((await call('/auth/menu-order', 'PUT', { order: bad }, login.cookie)).status, 400, JSON.stringify(bad));
    assert.equal((await call('/auth/menu-order', 'PUT', { order: null }, login.cookie)).status, 200);
    assert.equal((await call('/auth/me', 'GET', undefined, login.cookie)).data.user.menu_order, null);
    assert.equal((await call('/auth/menu-order', 'PUT', { order })).status, 401);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
