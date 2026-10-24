import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('admin hides menus for every user; settings cannot be hidden', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-menus-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin, selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await call('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = await call('/auth/login', 'POST', { username: 'admin', password: 'test-password-1234' });
    assert.deepEqual(admin.data.user.hidden_menus, []);
    await call('/users', 'POST', { name: '편집자', username: 'editor', email: 'editor@example.test', role: 'editor', password: 'test-password-1234' }, admin.cookie);
    const editor = await call('/auth/login', 'POST', { username: 'editor', password: 'test-password-1234' });

    assert.equal((await call('/menu-settings', 'PUT', { hidden: ['meetings'] }, editor.cookie)).status, 403);
    assert.equal((await call('/menu-settings', 'PUT', { hidden: ['settings'] }, admin.cookie)).status, 400);
    assert.equal((await call('/menu-settings', 'PUT', { hidden: ['Bad id'] }, admin.cookie)).status, 400);
    assert.equal((await call('/menu-settings', 'PUT', { hidden: 'meetings' }, admin.cookie)).status, 400);
    assert.deepEqual((await call('/menu-settings', 'PUT', { hidden: ['meetings', 'nasadmin'] }, admin.cookie)).data, { hidden: ['meetings', 'nasadmin'] });

    // 모든 사용자에게 같은 설정이 적용된다: 로그인·me 응답과 조회 API
    assert.deepEqual((await call('/menu-settings', 'GET', undefined, editor.cookie)).data, { hidden: ['meetings', 'nasadmin'] });
    assert.deepEqual((await call('/auth/me', 'GET', undefined, editor.cookie)).data.user.hidden_menus, ['meetings', 'nasadmin']);
    const again = await call('/auth/login', 'POST', { username: 'editor', password: 'test-password-1234' });
    assert.deepEqual(again.data.user.hidden_menus, ['meetings', 'nasadmin']);
    assert.equal((await call('/menu-settings', 'GET')).status, 401);

    assert.deepEqual((await call('/menu-settings', 'PUT', { hidden: [] }, admin.cookie)).data, { hidden: [] });
    assert.deepEqual((await call('/auth/me', 'GET', undefined, editor.cookie)).data.user.hidden_menus, []);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
