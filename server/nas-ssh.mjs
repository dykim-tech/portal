import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// 공유 볼륨별 사용량(2026-10-27): OMV 관리 기능(RPC)은 폴더별 용량을 주지 않으므로,
// 포털 전용 SSH 키로 NAS에 접속해 공유 폴더마다 `du -s -B1`(읽기 전용, 낮은 우선순위)로 크기를 잰다.
// 키는 데이터 폴더 nas-ssh/에 만들고(Windows에서는 현재 사용자만 읽도록 권한 제한), 공개키는 사용자가
// OMV 사용자 설정(SSH 공개 키)에 직접 등록한다. 결과는 app_settings 'nas_share_sizes'에 저장해 두고
// 6시간마다(그리고 '지금 계산'을 누르면) 다시 잰다. 비밀번호는 쓰지 않는다(BatchMode).

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
export const MEASURE_EVERY_MS = 6 * 3600_000;
const MEASURE_TIMEOUT_MS = 30 * 60_000;

const run = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

// 셸에 넘길 경로는 작은따옴표로 감싼다. OMV가 준 절대 경로만 허용한다.
export function shellQuote(path) {
  const value = String(path);
  if (!value.startsWith('/') || /[\n\r\0]/.test(value) || value.length > 1000) throw fail(400, `잴 수 없는 경로입니다: ${value}`);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function duCommand(paths) {
  return `LC_ALL=C nice -n 19 ionice -c3 du -s -B1 -- ${paths.map(shellQuote).join(' ')}`;
}

// du 출력: "<바이트>\t<경로>" 줄. 경로 끝의 / 유무와 관계없이 맞춘다.
export function parseDu(stdout) {
  const sizes = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match) sizes[match[2].replace(/\/+$/, '')] = Number(match[1]);
  }
  return sizes;
}

export function validateSshSettings(body) {
  const user = String(body?.user ?? '').trim(), port = Number(body?.port ?? 22);
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw fail(400, 'SSH 사용자 이름을 확인해 주세요(영문·숫자·_.-).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, 'SSH 포트를 확인해 주세요.');
  return { user, port };
}

export function createShareSizer({ dataDir, runner = run, platform = process.platform, sshPath, keygenPath }) {
  const dir = join(dataDir, 'nas-ssh'), keyPath = join(dir, 'id_ed25519'), knownHosts = join(dir, 'known_hosts');
  const windowsSsh = 'C:\\Windows\\System32\\OpenSSH\\';
  const ssh = sshPath ?? (platform === 'win32' && existsSync(windowsSsh + 'ssh.exe') ? windowsSsh + 'ssh.exe' : 'ssh');
  const keygen = keygenPath ?? (platform === 'win32' && existsSync(windowsSsh + 'ssh-keygen.exe') ? windowsSsh + 'ssh-keygen.exe' : 'ssh-keygen');
  const publicKey = () => { try { return readFileSync(keyPath + '.pub', 'utf8').trim(); } catch { return ''; } };

  async function createKey(force = false) {
    if (publicKey() && !force) return publicKey();
    mkdirSync(dir, { recursive: true });
    rmSync(keyPath, { force: true }); rmSync(keyPath + '.pub', { force: true });
    const made = await runner(keygen, ['-t', 'ed25519', '-N', '', '-C', 'dykim-portal-nas-usage', '-f', keyPath, '-q']);
    if (made.error || !publicKey()) throw fail(500, 'SSH 키를 만들지 못했습니다' + (made.stderr ? `: ${made.stderr.trim().slice(0, 200)}` : '. OpenSSH(ssh-keygen)가 설치되어 있는지 확인해 주세요.'));
    // Windows의 OpenSSH는 다른 사용자도 읽을 수 있는 개인키를 거부하므로 현재 사용자만 읽게 한다.
    if (platform === 'win32') {
      const who = await runner('whoami', []);
      const user = who.stdout.trim() || (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME);
      const acl = await runner('icacls', [keyPath, '/inheritance:r', '/grant:r', `${user}:F`]);
      if (acl.error) throw fail(500, '개인키 권한을 제한하지 못했습니다: ' + (acl.stderr || acl.stdout).trim().slice(0, 200));
    }
    return publicKey();
  }

  async function measure({ host, user, port, paths }) {
    if (!publicKey()) throw fail(409, '먼저 SSH 키를 만들고 NAS에 공개키를 등록해 주세요.');
    if (!paths.length) return { sizes: {}, partial: false, warnings: [] };
    const started = Date.now();
    const args = ['-i', keyPath, '-p', String(port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`, `${user}@${host}`, duCommand(paths)];
    const result = await runner(ssh, args, { timeout: MEASURE_TIMEOUT_MS });
    const sizes = parseDu(result.stdout);
    const warnings = result.stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^Warning: Permanently added/.test(line));
    if (!Object.keys(sizes).length) {
      const reason = warnings.find(line => /Permission denied|Connection|timed out|Host key|No route|refused|not found/i.test(line)) ?? warnings[0] ?? (result.error?.killed ? '시간 초과' : '응답 없음');
      throw fail(502, 'NAS에 SSH로 접속해 용량을 재지 못했습니다: ' + reason.slice(0, 300));
    }
    return { sizes, partial: warnings.some(line => /Permission denied|cannot read|cannot access/i.test(line)), warnings: warnings.slice(0, 5), duration_ms: Date.now() - started };
  }

  return { createKey, publicKey, measure, keyPath };
}
