import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { decodeCatV, decryptSecret, encryptSecret, parseFilesystems, parseShares, parseUsers, validateNasSettings } from '../server/nas.mjs';

// openmediavault rpc.php 흉내: 응답 형식과 필드는 OMV 소스(engined/rpc/*.inc)의 반환값을 따른다.
function fakeOmv({ password = 'nas-pass-1234', failShares = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const { service, method, params } = JSON.parse(raw), key = `${service}.${method}`; calls.push(key);
      const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      const error = (status, message) => send(status, { response: null, error: { code: status, message } });
      if (key === 'Session.login') {
        if (params?.username !== 'admin' || params?.password !== password) return error(400, 'Incorrect username or password.');
        return send(200, { response: { authenticated: true, username: 'admin' }, error: null }, { 'Set-Cookie': 'X-OPENMEDIAVAULT-SESSIONID=abc123; path=/; HttpOnly' });
      }
      if (req.headers.cookie !== 'X-OPENMEDIAVAULT-SESSIONID=abc123') return error(401, 'Session not authenticated.');
      if (key === 'Session.logout') return send(200, { response: null, error: null });
      if (key === 'FileSystemMgmt.enumerateMountedFilesystems') {
        assert.deepEqual(params, { includeroot: true });
        return send(200, { response: [
          { devicefile: '/dev/sda1', label: '', type: 'ext4', mountpoint: '/', size: '62000000000', available: '50000000000', used: '9.50 GiB', percentage: 17, comment: '', usagewarnthreshold: 85 },
          { devicefile: '/dev/md0', label: 'data', type: 'ext4', mountpoint: '/srv/dev-disk-by-uuid-1', size: '4000000000000', available: '1000000000000', used: '2.73 TiB', percentage: 75, comment: '', usagewarnthreshold: 85 }
        ], error: null });
      }
      if (key === 'ShareMgmt.enumerateSharedFolders') {
        if (failShares) return error(500, 'Failed to read shares.');
        return send(200, { response: [
          { uuid: 'u1', name: 'photos', comment: '사진', reldirpath: 'photos/', device: 'data', absdirpath: '/srv/dev-disk-by-uuid-1/photos/', status: 'OK', _used: true, mntent: { dir: '/srv/dev-disk-by-uuid-1', type: 'ext4' } },
          { uuid: 'u2', name: 'backup', comment: '', reldirpath: 'backup/', device: '', absdirpath: '', status: 'ENOENT_DB_MNTENT', _used: false, mntent: { dir: '', type: '' } }
        ], error: null });
      }
      if (key === 'UserMgmt.getUserList') {
        assert.deepEqual(params, { start: 0, limit: -1 });
        return send(200, { response: { total: 1, data: [{ name: 'dykim', uid: 1000, comment: '김동엽', email: 'dykim@example.test', groups: ['users', 'sambashare'], system: false }] }, error: null });
      }
      return error(500, `unknown ${key}`);
    });
  });
  return { server, calls };
}

test('NAS settings validation and secret encryption', () => {
  assert.throws(() => validateNasSettings({ url: 'ftp://nas', username: 'admin', password: 'x' }), /http/);
  assert.throws(() => validateNasSettings({ url: 'http://nas:8088', username: '', password: 'x' }), /아이디/);
  assert.throws(() => validateNasSettings({ url: 'http://nas:8088', username: 'admin', password: '' }), /비밀번호/);
  assert.equal(validateNasSettings({ url: 'http://nas:8088/', username: 'admin', password: '' }, { url: 'http://nas:8088', username: 'admin', secret: 'v1:x' }).password, null);
  assert.equal(validateNasSettings({ url: 'http://nas:8088/#/system', username: 'admin', password: 'p' }).url, 'http://nas:8088');
  assert.equal(validateNasSettings({ url: '', username: '', password: '' }).clear, true);
  const dir = mkdtempSync(join(tmpdir(), 'portal-nas-key-'));
  try {
    const secret = encryptSecret(dir, '비밀-1234');
    assert.ok(!secret.includes('비밀'));
    assert.equal(decryptSecret(dir, secret), '비밀-1234');
    assert.throws(() => decryptSecret(dir, secret.replace(/.$/, c => c === 'A' ? 'B' : 'A')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OMV responses are parsed tolerantly', () => {
  // OMV가 cat -v 표기로 돌려준 한글 라벨('새 볼륨')을 되돌린다
  assert.equal(decodeCatV('M-lM-^CM-^H M-kM-3M-<M-kM-%M-('), '새 볼륨');
  assert.equal(decodeCatV('/dev/sda1'), '/dev/sda1');
  assert.equal(decodeCatV('M-zz'), 'M-zz');
  assert.equal(parseFilesystems([{ label: 'M-lM-^CM-^H M-kM-3M-<M-kM-%M-(', devicefile: '/dev/sdb1', uuid: '9CF6' }])[0].name, '새 볼륨');
  assert.equal(parseShares([{ name: 's', device: 'M-lM-^CM-^H M-kM-3M-<M-kM-%M-(', mntent: { dir: '/srv/a' } }])[0].device, '새 볼륨');
  const [fs] = parseFilesystems([{ devicefile: '/dev/md0', label: 'data', size: '100', available: '40', used: '60.00 B', percentage: 60 }]);
  assert.deepEqual([fs.name, fs.size, fs.available, fs.used, fs.used_text, fs.percentage], ['data', 100, 40, null, '60.00 B', 60]);
  assert.equal(parseFilesystems({ data: [{ size: '-1', available: '-1', used: '-1', percentage: -1 }] })[0].size, null);
  assert.equal(parseShares([{ name: 's', mntent: { dir: '/srv/a' }, reldirpath: 'b/' }])[0].path, '/srv/a/b/');
  assert.deepEqual(parseUsers({ total: 1, data: [{ name: 'u', groups: ['users'] }] })[0].groups, ['users']);
  assert.deepEqual(parseUsers(null), []);
});

test('NAS API is admin-only, hides the password and reads OMV', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-nas-'));
  const omv = fakeOmv(); omv.server.listen(0, '127.0.0.1'); await new Promise(r => omv.server.once('listening', r));
  const nasUrl = 'http://127.0.0.1:' + omv.server.address().port;
  let portal, server;
  try {
    portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin, selfCheck: false });
  } catch (error) { await new Promise(r => omv.server.close(r)); throw error; }
  server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null), text: '' }; };
  const login = async username => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-password-1234' }) })).headers.get('set-cookie').split(';')[0];
  try {
    assert.equal((await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = await login('admin');
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin);
    const viewer = await login('viewer');
    assert.deepEqual((await request('/nas', 'GET', undefined, admin)).data, { configured: false });
    assert.equal((await request('/nas/settings', 'GET', undefined, viewer)).status, 403);
    assert.equal((await request('/nas', 'GET', undefined, viewer)).status, 403);
    assert.equal((await request('/nas/settings', 'PUT', { url: nasUrl, username: 'admin', password: 'nas-pass-1234' }, viewer)).status, 403);

    // 틀린 비밀번호: 로그인 실패 메시지
    assert.equal((await request('/nas/settings', 'PUT', { url: nasUrl, username: 'admin', password: 'wrong' }, admin)).status, 200);
    assert.match((await request('/nas?refresh=1', 'GET', undefined, admin)).data.error, /NAS 로그인 실패: Incorrect username or password/);

    const saved = await request('/nas/settings', 'PUT', { url: nasUrl, username: 'admin', password: 'nas-pass-1234' }, admin);
    assert.deepEqual(saved.data, { url: nasUrl, username: 'admin', has_password: true, configured: true });
    const settings = (await request('/nas/settings', 'GET', undefined, admin)).data;
    assert.ok(!JSON.stringify(settings).includes('nas-pass') && !('secret' in settings) && !('password' in settings));
    const stored = portal.db.prepare("SELECT value FROM app_settings WHERE key='nas'").get().value;
    assert.ok(!stored.includes('nas-pass-1234'));

    omv.calls.length = 0;
    const nas = (await request('/nas', 'GET', undefined, admin)).data;
    assert.equal(nas.error, undefined);
    assert.deepEqual(omv.calls, ['Session.login', 'FileSystemMgmt.enumerateMountedFilesystems', 'ShareMgmt.enumerateSharedFolders', 'UserMgmt.getUserList', 'Session.logout']);
    assert.deepEqual(nas.filesystems.items.map(f => [f.name, f.size, f.available, f.percentage, f.used_text]), [['/dev/sda1', 62000000000, 50000000000, 17, '9.50 GiB'], ['data', 4000000000000, 1000000000000, 75, '2.73 TiB']]);
    assert.deepEqual(nas.shares.items.map(s => [s.name, s.path, s.status]), [['photos', '/srv/dev-disk-by-uuid-1/photos/', 'OK'], ['backup', 'backup/', 'ENOENT_DB_MNTENT']]);
    // 디스크 별칭: 관리자만, 마운트 위치로 구분, 공유 볼륨에도 같은 별칭
    assert.deepEqual(nas.filesystems.items.map(f => [f.key, f.alias]), [['/', ''], ['/srv/dev-disk-by-uuid-1', '']]);
    assert.equal((await request('/nas/aliases', 'PUT', { aliases: { '/': 'x' } }, viewer)).status, 403);
    assert.equal((await request('/nas/aliases', 'PUT', { aliases: { '/': 'x'.repeat(51) } }, admin)).status, 400);
    assert.deepEqual((await request('/nas/aliases', 'PUT', { aliases: { '/': ' 로컬 SSD (450GB) ', '/srv/dev-disk-by-uuid-1': 'USB HDD (2.7TB)', '/none': '' } }, admin)).data, { aliases: { '/': '로컬 SSD (450GB)', '/srv/dev-disk-by-uuid-1': 'USB HDD (2.7TB)' } });
    const aliased = (await request('/nas', 'GET', undefined, admin)).data;
    assert.deepEqual(aliased.filesystems.items.map(f => f.alias), ['로컬 SSD (450GB)', 'USB HDD (2.7TB)']);
    assert.deepEqual(aliased.shares.items.map(s => [s.name, s.fs_alias, s.fs_key]), [['photos', 'USB HDD (2.7TB)', '/srv/dev-disk-by-uuid-1'], ['backup', '', '']]);
    // 비밀번호를 다시 저장해도 별칭은 유지
    await request('/nas/settings', 'PUT', { url: nasUrl, username: 'admin', password: '' }, admin);
    assert.equal((await request('/nas', 'GET', undefined, admin)).data.filesystems.items[1].alias, 'USB HDD (2.7TB)');
    assert.deepEqual(nas.users.items.map(u => [u.name, u.comment, u.email, u.groups]), [['dykim', '김동엽', 'dykim@example.test', ['users', 'sambashare']]]);
    assert.ok(!JSON.stringify(nas).includes('nas-pass'));

    // 1분 캐시: 다시 불러도 NAS를 호출하지 않고, refresh=1이면 다시 읽는다.
    omv.calls.length = 0;
    await request('/nas', 'GET', undefined, admin);
    assert.equal(omv.calls.length, 0);
    await request('/nas?refresh=1', 'GET', undefined, admin);
    assert.equal(omv.calls[0], 'Session.login');

    // 비밀번호를 비워 저장하면 기존 비밀번호 유지
    assert.equal((await request('/nas/settings', 'PUT', { url: nasUrl, username: 'admin', password: '' }, admin)).status, 200);
    assert.equal((await request('/nas?refresh=1', 'GET', undefined, admin)).data.error, undefined);
    // 다른 아이디로 바꾸면서 비밀번호를 비우면 거부
    assert.equal((await request('/nas/settings', 'PUT', { url: nasUrl, username: 'other', password: '' }, admin)).status, 400);

    // 연결 실패
    await request('/nas/settings', 'PUT', { url: 'http://127.0.0.1:1', username: 'admin', password: 'nas-pass-1234' }, admin);
    assert.match((await request('/nas', 'GET', undefined, admin)).data.error, /연결하지 못했습니다|로그인 실패/);

    assert.equal((await request('/nas/settings', 'PUT', { url: '', username: '', password: '' }, admin)).status, 200);
    assert.deepEqual((await request('/nas', 'GET', undefined, admin)).data, { configured: false });
  } finally { await new Promise(r => server.close(r)); await new Promise(r => omv.server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('one failing OMV section does not hide the others', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-nas2-'));
  const omv = fakeOmv({ failShares: true }); omv.server.listen(0, '127.0.0.1'); await new Promise(r => omv.server.once('listening', r));
  const { readNas, createOmvClient } = await import('../server/nas.mjs');
  try {
    const result = await readNas(createOmvClient({ url: 'http://127.0.0.1:' + omv.server.address().port, username: 'admin', password: 'nas-pass-1234' }));
    assert.equal(result.filesystems.items.length, 2);
    assert.match(result.shares.error, /Failed to read shares/);
    assert.equal(result.users.items.length, 1);
    assert.equal(omv.calls.at(-1), 'Session.logout');
  } finally { await new Promise(r => omv.server.close(r)); rmSync(dataDir, { recursive: true, force: true }); }
});
