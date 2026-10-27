import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShareSizer, validateSshSettings, MEASURE_EVERY_MS } from './nas-ssh.mjs';

// NAS 현황: openmediavault(OMV) 관리 화면이 쓰는 JSON-RPC(/rpc.php)로
// 파일시스템 사용량, 공유 폴더, 사용자 목록을 읽어 대시보드에 보여준다(읽기 전용).
// 사용하는 RPC 메서드는 OMV 6.x·7.x·master 소스에서 확인한 것이다.
//   Session.login {username,password} / Session.logout
//   FileSystemMgmt.enumerateMountedFilesystems {includeroot:true}
//   ShareMgmt.enumerateSharedFolders (매개변수 없음)
//   UserMgmt.getUserList {start:0,limit:-1} → {total,data}
// NAS 관리자 비밀번호는 데이터 폴더의 키 파일(nas-secret.key)로 AES-256-GCM 암호화해 저장하고,
// API 응답으로는 절대 돌려주지 않는다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const CACHE_MS = 60_000;
const DEFAULT_URL = 'http://100.116.94.33:8088';

export function validateNasSettings(body, current = {}) {
  const url = String(body?.url ?? '').trim().replace(/\/+$/, '');
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!url && !username && !password) return { url: '', username: '', password: null, clear: true };
  let parsed;
  try { parsed = new URL(url); } catch { throw fail(400, 'NAS 주소를 http:// 또는 https:// 로 시작하는 전체 주소로 입력해 주세요.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || url.length > 300 || parsed.username || parsed.password) throw fail(400, 'NAS 주소를 http:// 또는 https:// 로 시작하는 전체 주소로 입력해 주세요.');
  if (!username || username.length > 100) throw fail(400, 'NAS 관리자 아이디를 100자 이내로 입력해 주세요.');
  if (password.length > 256) throw fail(400, '비밀번호가 너무 깁니다.');
  // 비밀번호 칸을 비워 두면 같은 주소·아이디일 때 저장된 비밀번호를 그대로 쓴다.
  if (!password && !(current.secret && current.url === url && current.username === username)) throw fail(400, 'NAS 관리자 비밀번호를 입력해 주세요.');
  return { url: parsed.origin + parsed.pathname.replace(/\/+$/, ''), username, password: password || null, clear: false };
}

function secretKey(dataDir) {
  const path = join(dataDir, 'nas-secret.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return key;
}

export function encryptSecret(dataDir, text) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey(dataDir), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(dataDir, value) {
  const [version, iv, tag, data] = String(value ?? '').split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('bad secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(dataDir), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const number = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
};
const list = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const text = value => value == null ? '' : String(value);

// OMV는 한글 볼륨 라벨을 'cat -v' 표기(예: 'M-lM-^CM-^H M-kM-3M-<M-kM-%M-(' = '새 볼륨')로 돌려줄 때가 있다.
// 이 표기를 원래 UTF-8 글자로 되돌리고, 깨끗하게 되돌릴 수 없으면 받은 그대로 둔다.
export function decodeCatV(value) {
  const input = text(value);
  if (!/M-/.test(input)) return input;
  const bytes = [];
  for (let i = 0; i < input.length;) {
    let high = 0;
    if (input.startsWith('M-', i)) { high = 0x80; i += 2; }
    if (input[i] === '^' && i + 1 < input.length && (high || /[@A-Z[\\\]^_?]/.test(input[i + 1]))) { const c = input[i + 1]; bytes.push(high | (c === '?' ? 0x7f : c.charCodeAt(0) ^ 0x40)); i += 2; continue; }
    const code = input.charCodeAt(i);
    if (code > 0x7f) return input;
    bytes.push(high | code); i++;
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  return decoded.includes('\uFFFD') ? input : decoded;
}

// 디스크 별칭: 마운트 위치(없으면 장치 파일)로 구분한다. 예: '/' → '로컬 SSD (450GB)'.
export const filesystemKey = fs => fs.mountpoint || fs.device || fs.uuid || '';
export function validateAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '별칭 형식을 확인해 주세요.');
  const entries = Object.entries(value);
  if (entries.length > 30) throw fail(400, '별칭은 30개까지 저장할 수 있습니다.');
  const result = {};
  for (const [key, alias] of entries) {
    const k = String(key).trim(), a = String(alias ?? '').trim();
    if (!k || k.length > 300) throw fail(400, '별칭 대상을 확인해 주세요.');
    if (a.length > 50) throw fail(400, '별칭은 50자 이내로 입력해 주세요.');
    if (a) result[k] = a;
  }
  return result;
}
export function applyAliases(value, aliases = {}) {
  if (!value?.filesystems?.items) return value;
  const filesystems = value.filesystems.items.map(fs => ({ ...fs, key: filesystemKey(fs), alias: aliases[filesystemKey(fs)] ?? '' }));
  const byMount = new Map(filesystems.filter(fs => fs.mountpoint).map(fs => [fs.mountpoint.replace(/\/+$/, '') || '/', fs]));
  const shares = value.shares?.items ? { ...value.shares, items: value.shares.items.map(share => { const fs = share.mount ? byMount.get(share.mount.replace(/\/+$/, '') || '/') : null; return { ...share, fs_key: fs?.key ?? '', fs_alias: fs?.alias ?? '' }; }) } : value.shares;
  return { ...value, filesystems: { ...value.filesystems, items: filesystems }, shares };
}

export function parseFilesystems(value) {
  return list(value).map(fs => {
    const size = number(fs.size), available = number(fs.available), usedNumber = number(fs.used);
    const used = usedNumber != null && usedNumber >= 0 ? usedNumber : null;
    // OMV는 used를 "1.50 GiB" 같은 글자로 돌려준다. 그대로 표시용으로 둔다.
    const usedText = used == null && typeof fs.used === 'string' && fs.used !== '-1' ? fs.used : '';
    const pct = number(fs.percentage);
    return {
      name: decodeCatV(fs.label) || text(fs.devicefile) || text(fs.devicename) || text(fs.mountpoint),
      label: decodeCatV(fs.label), uuid: text(fs.uuid), device: text(fs.devicefile), type: text(fs.type), mountpoint: text(fs.mountpoint), comment: text(fs.comment),
      size: size != null && size >= 0 ? size : null, available: available != null && available >= 0 ? available : null,
      used, used_text: usedText, percentage: pct != null && pct >= 0 ? pct : null,
      warn: number(fs.usagewarnthreshold)
    };
  });
}

export function parseShares(value) {
  return list(value).map(share => ({
    name: text(share.name), comment: text(share.comment), device: decodeCatV(share.device), mount: text(share.mntent?.dir),
    path: text(share.absdirpath) || [text(share.mntent?.dir), text(share.reldirpath)].filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    filesystem: text(share.mntent?.type), status: text(share.status) || 'OK', in_use: Boolean(share._used)
  }));
}

export function parseUsers(value) {
  return list(value).map(user => ({
    name: text(user.name), comment: text(user.comment), email: text(user.email),
    groups: Array.isArray(user.groups) ? user.groups.map(text) : [], uid: number(user.uid)
  }));
}

export function createOmvClient({ url, username, password, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const endpoint = `${url}/rpc.php`;
  let cookie = '';
  async function call(service, method, params = null) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify({ service, method, params, options: null })
      });
    } catch (error) {
      throw fail(502, error?.name === 'TimeoutError' ? 'NAS 응답 시간이 초과되었습니다.' : 'NAS에 연결하지 못했습니다. 주소와 네트워크(Tailscale) 연결을 확인해 주세요.');
    }
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) cookie = cookies.map(c => c.split(';')[0]).join('; ');
    let body;
    try { body = await response.json(); } catch { throw fail(502, `NAS 응답을 해석하지 못했습니다(HTTP ${response.status}).`); }
    if (body?.error) throw fail(502, text(body.error.message) || `NAS 오류(HTTP ${response.status})`);
    if (!response.ok) throw fail(502, `NAS 오류(HTTP ${response.status})`);
    return body?.response;
  }
  return {
    async login() {
      try { await call('Session', 'login', { username, password }); }
      catch (error) { throw fail(502, `NAS 로그인 실패: ${error.message}`); }
    },
    call,
    async logout() { try { await call('Session', 'logout', null); } catch {} }
  };
}

export async function readNas(client) {
  await client.login();
  const sections = {};
  const steps = [
    ['filesystems', () => client.call('FileSystemMgmt', 'enumerateMountedFilesystems', { includeroot: true }), parseFilesystems],
    ['shares', () => client.call('ShareMgmt', 'enumerateSharedFolders', null), parseShares],
    ['users', () => client.call('UserMgmt', 'getUserList', { start: 0, limit: -1 }), parseUsers]
  ];
  try {
    // OMV 세션은 PHP 세션 잠금을 쓰므로 차례대로 부른다.
    for (const [key, run, parse] of steps) {
      try { sections[key] = { items: parse(await run()) }; }
      catch (error) { sections[key] = { items: [], error: error.expose ? error.message : '읽지 못했습니다.' }; }
    }
  } finally { await client.logout(); }
  return sections;
}

// 공유 볼륨 크기(SSH du 결과)를 붙인다: 크기와 그 디스크 전체 용량 대비 비율(%).
export function applyShareSizes(value, stored = {}) {
  if (!value?.shares?.items) return value;
  const sizes = stored.sizes ?? {}, disks = new Map((value.filesystems?.items ?? []).filter(fs => fs.mountpoint).map(fs => [fs.mountpoint.replace(/\/+$/, '') || '/', fs]));
  const items = value.shares.items.map(share => {
    const size = sizes[(share.path || '').replace(/\/+$/, '')];
    const disk = share.mount ? disks.get(share.mount.replace(/\/+$/, '') || '/') : null;
    return { ...share, size: Number.isFinite(size) ? size : null, size_pct: Number.isFinite(size) && disk?.size ? Math.round(size / disk.size * 1000) / 10 : null, disk_size: disk?.size ?? null };
  });
  const { sizes: _omit, ...meta } = stored;
  return { ...value, shares: { ...value.shares, items }, share_sizes: meta };
}

export function registerNas(app, { db, requireRole, dataDir, fetchImpl, sshRunner, sshPlatform, measureCheckMs }) {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const admin = requireRole(['admin']);
  const settings = () => { try { return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='nas'").get()?.value ?? '{}'); } catch { return {}; } };
  let cache = null, pending = null, generation = 0;
  async function load(force) {
    const s = settings();
    if (!s.url || !s.username || !s.secret) return { configured: false };
    const base = { configured: true, url: s.url, username: s.username };
    if (!force && cache && cache.generation === generation && Date.now() - cache.at < CACHE_MS) return cache.value;
    if (!pending || pending.generation !== generation) {
      const current = { generation, promise: (async () => {
        let password;
        try { password = decryptSecret(dataDir, s.secret); }
        catch { return { ...base, error: '저장된 NAS 비밀번호를 읽지 못했습니다. 설정 → NAS 연동에서 비밀번호를 다시 저장해 주세요.' }; }
        try {
          const sections = await readNas(createOmvClient({ url: s.url, username: s.username, password, fetchImpl }));
          return { ...base, checked_at: new Date().toISOString(), ...sections };
        } catch (error) { return { ...base, checked_at: new Date().toISOString(), error: error.expose ? error.message : 'NAS 정보를 읽지 못했습니다.' }; }
      })() };
      pending = current;
      current.promise.then(value => { if (current.generation === generation) cache = { generation: current.generation, at: Date.now(), value }; })
        .finally(() => { if (pending === current) pending = null; });
    }
    return pending.promise;
  }
  // 공유 볼륨 크기(SSH): 설정 'nas'.ssh = {user, port}, 결과 'nas_share_sizes'
  const sizer = createShareSizer({ dataDir, ...(sshRunner ? { runner: sshRunner } : {}), ...(sshPlatform ? { platform: sshPlatform } : {}) });
  const readSizes = () => { try { return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='nas_share_sizes'").get()?.value ?? '{}'); } catch { return {}; } };
  const writeSizes = value => db.prepare("INSERT INTO app_settings(key,value) VALUES('nas_share_sizes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  let measuring = null;
  async function measureShares() {
    if (measuring) return measuring;
    measuring = (async () => {
      const s = settings(), previous = readSizes();
      if (!s.ssh?.user) throw fail(409, 'SSH 사용자를 먼저 저장해 주세요.');
      const nas = await load(true);
      if (nas.error || !nas.shares?.items) throw fail(502, nas.error || nas.shares?.error || '공유 볼륨 목록을 읽지 못했습니다.');
      const paths = [...new Set(nas.shares.items.map(share => share.path).filter(path => path?.startsWith('/')))];
      const started = new Date().toISOString();
      try {
        const result = await sizer.measure({ host: new URL(s.url).hostname, user: s.ssh.user, port: s.ssh.port ?? 22, paths });
        const value = { measured_at: new Date().toISOString(), started_at: started, sizes: result.sizes, partial: result.partial, warnings: result.warnings, duration_ms: result.duration_ms, error: '' };
        if (db.isOpen) writeSizes(value);
        return value;
      } catch (error) {
        const value = { ...previous, error: error.expose ? error.message : '용량을 재지 못했습니다.', failed_at: new Date().toISOString() };
        if (db.isOpen) writeSizes(value);
        throw error;
      }
    })();
    try { return await measuring; } finally { measuring = null; }
  }
  // 6시간마다 자동으로 다시 잰다(키와 SSH 사용자가 있을 때만). 서버 시작 직후에는 2분 뒤 처음 확인한다.
  const due = () => { const s = settings(), last = readSizes(); const at = Date.parse(last.measured_at ?? last.failed_at ?? 0) || 0; return Boolean(s.url && s.secret && s.ssh?.user && sizer.publicKey()) && Date.now() - at > MEASURE_EVERY_MS; };
  if (measureCheckMs !== 0) {
    const tick = () => { if (!db.isOpen || measuring || !due()) return; measureShares().catch(error => console.error('NAS share size:', error.message)); };
    const first = setTimeout(tick, 120_000); first.unref?.();
    const timer = setInterval(tick, measureCheckMs ?? 600_000); timer.unref?.();
  }
  app.get('/api/nas/ssh', admin, (_req, res) => { const s = settings(); res.json({ user: s.ssh?.user ?? 'dykim', port: s.ssh?.port ?? 22, saved: Boolean(s.ssh?.user), public_key: sizer.publicKey(), host: s.url ? new URL(s.url).hostname : '', running: Boolean(measuring), last: (({ sizes, ...meta }) => meta)(readSizes()) }); });
  app.put('/api/nas/ssh', admin, (req, res) => {
    const ssh = validateSshSettings(req.body), current = settings();
    db.prepare("INSERT INTO app_settings(key,value) VALUES('nas',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...current, ssh }));
    res.json(ssh);
  });
  app.post('/api/nas/ssh/key', admin, async (req, res) => res.json({ public_key: await sizer.createKey(req.body?.force === true) }));
  // 크기 재기는 몇 분 걸릴 수 있어 20초까지만 기다린다. 그 안에 끝나면 결과를, 아니면 '재는 중'을 돌려준다(오류는 바로 보임).
  app.post('/api/nas/ssh/measure', admin, async (_req, res) => {
    const job = measureShares();
    job.catch(error => console.error('NAS share size:', error.message));
    const value = await Promise.race([job, new Promise(resolve => { const t = setTimeout(() => resolve(null), 20_000); t.unref?.(); })]);
    if (!value) return res.status(202).json({ running: true });
    const { sizes, ...meta } = value; res.json({ ...meta, count: Object.keys(sizes).length });
  });

  // 별칭·공유 볼륨 크기는 캐시와 상관없이 응답할 때마다 붙여, 바꾸면 바로 보이게 한다.
  app.get('/api/nas', admin, async (req, res) => res.json(applyShareSizes(applyAliases(await load(req.query.refresh === '1'), settings().aliases), { ...readSizes(), running: Boolean(measuring) })));
  app.put('/api/nas/aliases', admin, (req, res) => {
    const aliases = validateAliases(req.body?.aliases), current = settings();
    db.prepare("INSERT INTO app_settings(key,value) VALUES('nas',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...current, aliases }));
    res.json({ aliases });
  });
  app.get('/api/nas/settings', admin, (_req, res) => {
    const s = settings();
    res.json({ url: s.url ?? DEFAULT_URL, username: s.username ?? '', has_password: Boolean(s.secret), configured: Boolean(s.url && s.username && s.secret) });
  });
  app.put('/api/nas/settings', admin, (req, res) => {
    const current = settings(), value = validateNasSettings(req.body, current);
    const stored = value.clear ? {} : { url: value.url, username: value.username, secret: value.password ? encryptSecret(dataDir, value.password) : current.secret, ...(current.aliases ? { aliases: current.aliases } : {}), ...(current.ssh ? { ssh: current.ssh } : {}) };
    db.prepare("INSERT INTO app_settings(key,value) VALUES('nas',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(stored));
    generation++; cache = null;
    res.json({ url: stored.url ?? DEFAULT_URL, username: stored.username ?? '', has_password: Boolean(stored.secret), configured: !value.clear });
  });
}
