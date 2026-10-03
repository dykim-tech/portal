import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('two-level library, editing and legacy migration preserve documents', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-library-'));
  const origin = 'http://localhost:3100';
  let portal = createPortal({ dataDir, origin });
  let server = portal.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let base = 'http://127.0.0.1:' + server.address().port;
  let cookie;
  async function request(path, method = 'GET', body, session = cookie) {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: session ?? '', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  }
  function upload() {
    const form = new FormData();
    form.append('file', new Blob(['원본 자료 본문']), '설치.txt');
    return form;
  }
  try {
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' });
    cookie = setup.headers.get('set-cookie').split(';')[0];
    const major = (await request('/folders', 'POST', { name: 'FortiGate' })).data.id;
    const middle = (await request('/folders', 'POST', { name: 'VPN', parent_id: major })).data.id;
    const other = (await request('/folders', 'POST', { name: '일반', parent_id: major })).data.id;
    let fileId;
    await t.test('enforces two levels and requires a middle category before upload', async () => {
      assert.equal((await request('/folders', 'POST', { name: '하위', parent_id: middle })).status, 400);
      for (const path of ['/manuals', '/manuals?folder=' + major, '/manuals?folder=999999']) {
        assert.ok([400, 404].includes((await request(path, 'POST', upload())).status));
      }
      assert.deepEqual(readdirSync(join(dataDir, 'upload-tmp')), []);
      const result = await request('/manuals?folder=' + middle, 'POST', upload());
      assert.equal(result.status, 201);
      fileId = result.data.id;
    });
    await t.test('renames either category and updates tree, breadcrumbs and searches', async () => {
      assert.equal((await request('/folders/' + major, 'PUT', { name: '보안 장비' })).status, 200);
      assert.equal((await request('/folders/' + middle, 'PUT', { name: 'VPN 연결' })).status, 200);
      const listing = (await request('/library?folder=' + middle)).data;
      assert.deepEqual(listing.breadcrumbs.map(row => row.name), ['보안 장비', 'VPN 연결']);
      assert.equal(listing.tree.find(row => row.id === middle).name, 'VPN 연결');
      assert.equal(listing.files[0].id, fileId);
      assert.equal((await request('/library?folder=' + major + '&q=' + encodeURIComponent('연결'))).data.folders.length, 1);
      assert.equal((await request('/folders/' + middle, 'PUT', { name: '일반' })).status, 409);
      for (const name of ['', '../bad', 'bad\nname', 'x'.repeat(101)]) {
        assert.equal((await request('/folders/' + middle, 'PUT', { name })).status, 400);
      }
      assert.equal((await request('/folders/999999', 'PUT', { name: '없음' })).status, 404);
    });
    await t.test('renames and moves a file without altering download bytes or preview', async () => {
      const before = (await request('/manuals/' + fileId)).data.file;
      assert.equal((await request('/manuals/' + fileId, 'PUT', { name: '수정한 설치 안내.txt', folder_id: other })).status, 200);
      const after = (await request('/manuals/' + fileId)).data.file;
      assert.equal(after.folder_id, other);
      assert.equal(after.size, before.size);
      assert.equal(after.created_at, before.created_at);
      assert.equal(after.preview_type, before.preview_type);
      assert.equal((await request('/library?folder=' + middle)).data.total, 0);
      assert.equal((await request('/library?folder=' + other + '&q=' + encodeURIComponent('수정한'))).data.total, 1);
      const downloaded = await request('/manuals/' + fileId + '/download');
      assert.equal(downloaded.data, '원본 자료 본문');
      assert.ok(downloaded.headers.get('content-disposition').includes(encodeURIComponent(after.name)));
      assert.equal((await request('/manuals/' + fileId + '/preview')).data, downloaded.data);
      for (const name of ['', 'changed.pdf', '../bad.txt', 'bad\u0000.txt', 'x'.repeat(241) + '.txt']) {
        assert.equal((await request('/manuals/' + fileId, 'PUT', { name })).status, 400);
      }
      for (const folder_id of [major, null, 999999]) {
        assert.ok([400, 404].includes((await request('/manuals/' + fileId, 'PUT', { name: '안내.txt', folder_id })).status));
      }
      assert.equal((await request('/manuals/999999', 'PUT', { name: '안내.txt' })).status, 404);
      assert.equal((await request('/manuals/' + fileId)).data.file.name, after.name);
    });
    await t.test('editor can edit but viewer cannot change files or folders', async () => {
      for (const role of ['viewer', 'editor']) {
        await request('/users', 'POST', { name: role, username: role, email: role + '@example.test', password: 'test-password-1234', role });
        const login = await request('/auth/login', 'POST', { username: role, password: 'test-password-1234' });
        const session = login.headers.get('set-cookie').split(';')[0];
        const expected = role === 'viewer' ? 403 : 200;
        assert.equal((await request('/folders/' + other, 'PUT', { name: '일반 자료' }, session)).status, expected);
        assert.equal((await request('/manuals/' + fileId, 'PUT', { name: '최종 안내.txt' }, session)).status, expected);
      }
      assert.equal((await request('/manuals/' + fileId, 'PUT', { name: '안내.txt' }, '')).status, 401);
    });
    await t.test('restart flattens legacy categories with collisions, preserving IDs and both storage formats', async () => {
      const stamp = new Date().toISOString();
      const insertFolder = (parent, name) => Number(portal.db.prepare('INSERT INTO folders(parent_id,name,created_at) VALUES(?,?,?)').run(parent, name, stamp).lastInsertRowid);
      const collision = insertFolder(major, 'VPN 연결 · StrongSwan');
      const leaf = insertFolder(middle, 'StrongSwan');
      const deeper = insertFolder(leaf, '추가');
      portal.db.prepare('UPDATE manuals SET folder_id=? WHERE id=?').run(leaf, fileId);
      const legacy = Number(portal.db.prepare('INSERT INTO manuals(folder_id,name,size,bytes,preview_type,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(deeper, 'legacy.txt', 6, Buffer.from('legacy'), 'text/plain; charset=utf-8', 1, stamp).lastInsertRowid);
      const foldersBefore = portal.db.prepare('SELECT COUNT(*) n FROM folders').get().n;
      async function restart() {
        await new Promise(resolve => server.close(resolve));
        portal.db.close();
        portal = createPortal({ dataDir, origin });
        server = portal.app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = 'http://127.0.0.1:' + server.address().port;
      }
      await restart();
      const tree = (await request('/library')).data.tree;
      assert.equal(tree.length, foldersBefore);
      assert.equal(tree.find(row => row.id === leaf).parent_id, major);
      assert.equal(tree.find(row => row.id === leaf).name, 'VPN 연결 · StrongSwan (2)');
      assert.equal(tree.find(row => row.id === collision).name, 'VPN 연결 · StrongSwan');
      assert.equal(tree.find(row => row.id === deeper).name, 'VPN 연결 · StrongSwan · 추가');
      assert.equal(tree.find(row => row.id === deeper).parent_id, major);
      assert.equal((await request('/library?folder=' + leaf)).data.files[0].id, fileId);
      assert.equal((await request('/manuals/' + fileId + '/download')).data, '원본 자료 본문');
      assert.equal((await request('/manuals/' + legacy + '/download')).data, 'legacy');
      await restart();
      assert.deepEqual((await request('/library')).data.tree, tree);
      // Old uncategorized documents remain readable and can be renamed or assigned.
      portal.db.prepare('UPDATE manuals SET folder_id=NULL WHERE id=?').run(legacy);
      assert.equal((await request('/manuals/' + legacy, 'PUT', { name: '이름 변경.txt', folder_id: '' })).status, 200);
      assert.equal((await request('/manuals/' + legacy, 'PUT', { name: '이름 변경.txt', folder_id: middle })).status, 200);
      assert.equal((await request('/manuals/' + legacy + '/download')).data, 'legacy');
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
});
