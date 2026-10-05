import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('library stores web links in folders and lists them with folders and files', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-links-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const login = async (username, password) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  try {
    assert.equal((await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = await login('admin', 'test-password-1234');
    assert.equal((await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin)).status, 201);
    const viewer = await login('viewer', 'test-password-1234');
    const folder = (await request('/folders', 'POST', { name: 'SGA', parent_id: null }, admin)).data;
    const folderId = folder.id ?? folder.folder?.id;

    // 주소만 넣으면 https://를 붙이고 이름은 주소로 채운다.
    const created = await request('/library-links', 'POST', { url: 'www.example.com/docs', name: '', folder_id: folderId }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.link.url, 'https://www.example.com/docs');
    assert.equal(created.data.link.name, 'www.example.com/docs');
    const named = (await request('/library-links', 'POST', { url: 'https://vendor.example/manual?id=1', name: '제품 매뉴얼', folder_id: folderId }, admin)).data.link;

    // 실행형 주소와 잘못된 주소는 거부한다.
    for (const url of ['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,hi', 'https://', '']) assert.equal((await request('/library-links', 'POST', { url, folder_id: folderId }, admin)).status, 400, url);
    assert.equal((await request('/library-links', 'POST', { url: 'https://a.example', folder_id: 999 }, admin)).status, 404);
    assert.equal((await request('/library-links', 'POST', { url: 'https://a.example' }, viewer)).status, 403);

    const listed = (await request('/library?folder=' + folderId, 'GET', undefined, viewer)).data;
    assert.deepEqual(listed.links.map(link => link.name), ['www.example.com/docs', '제품 매뉴얼']);
    assert.equal((await request('/library?folder=' + folderId + '&q=vendor', 'GET', undefined, admin)).data.links.length, 1, 'search matches the address too');

    // 수정·이동
    assert.equal((await request('/library-links/' + named.id, 'PUT', { name: '매뉴얼', url: 'vendor.example/v2' }, admin)).data.link.url, 'https://vendor.example/v2');
    assert.equal((await request('/library-links/' + named.id, 'PUT', { folder_id: null }, admin)).data.link.folder_id, null);
    assert.equal((await request('/library?folder=', 'GET', undefined, admin)).data.links[0].name, '매뉴얼');
    assert.equal((await request('/library-links/' + named.id, 'PUT', { url: 'javascript:void(0)' }, admin)).status, 400);

    // 링크가 남은 폴더는 비어 있지 않으므로 삭제할 수 없다.
    assert.equal((await request('/folders/' + folderId, 'DELETE', undefined, admin)).status, 409);
    assert.equal((await request('/library-links/' + created.data.link.id, 'DELETE', undefined, viewer)).status, 403);
    assert.equal((await request('/library-links/' + created.data.link.id, 'DELETE', undefined, admin)).status, 200);
    assert.equal((await request('/folders/' + folderId, 'DELETE', undefined, admin)).status, 200);
    assert.equal((await request('/library-links/' + created.data.link.id, 'DELETE', undefined, admin)).status, 404);
  } finally {
    await new Promise(r => server.close(r)); portal.db.close();
  }
});
