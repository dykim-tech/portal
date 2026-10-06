// 자체 점검: GitHub Actions가 하던 문법 검사·자동 테스트·보안 점검을 이 PC에서 실행하고
// 결과를 data/check-log.jsonl에 남긴다(운영관리 → 점검 로그). 메일은 보내지 않는다.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEEP = 50, OUTPUT_LIMIT = 30000;

export function currentCommit(dir = root) {
  try {
    const git = join(dir, '.git'), head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(4).trim(), file = join(git, ref);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim().slice(0, 7);
    const packed = readFileSync(join(git, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(' ' + ref));
    return packed ? packed.slice(0, 7) : null;
  } catch { return null; }
}

function run(args, { timeout = 600000, env } = {}) {
  return new Promise(done => {
    const started = Date.now(); let output = '';
    const child = spawn(process.execPath, args, { cwd: root, env: env ?? process.env, windowsHide: true });
    const add = chunk => { output += chunk; if (output.length > OUTPUT_LIMIT * 4) output = output.slice(-OUTPUT_LIMIT * 2); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { output += `\n[점검 시간 초과: ${timeout / 1000}초]`; child.kill(); }, timeout);
    child.on('error', error => { clearTimeout(timer); done({ code: -1, output: output + String(error), ms: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); done({ code, output, ms: Date.now() - started }); });
  });
}
const tail = text => text.length > OUTPUT_LIMIT ? '…\n' + text.slice(-OUTPUT_LIMIT) : text;

// 1) 문법 검사: package.json의 check 스크립트에 적힌 파일을 node --check로 확인한다.
async function syntaxStep() {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.check ?? '';
  const files = [...script.matchAll(/node --check (\S+)/g)].map(match => match[1]);
  const started = Date.now(), failed = [];
  for (const file of files) { const result = await run(['--check', file], { timeout: 60000 }); if (result.code !== 0) failed.push(`${file}\n${result.output.trim()}`); }
  return { key: 'syntax', name: '문법 검사', status: failed.length ? 'fail' : 'ok', summary: failed.length ? `${files.length}개 중 ${failed.length}개 오류` : `${files.length}개 파일 정상`, ms: Date.now() - started, output: failed.length ? tail(failed.join('\n\n')) : '' };
}

// 2) 자동 테스트: test 폴더의 *.test.mjs 전체. 운영 서버 설정(DATA_DIR 등)은 넘기지 않고, 테스트가 띄우는 포털이 다시 점검을 돌리지 않게 막는다.
async function testStep() {
  const files = readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'test/' + name);
  const env = { ...process.env, NODE_ENV: '', SELF_CHECK: 'off' };
  for (const key of ['DATA_DIR', 'BACKUP_DIR', 'PORT', 'HOST', 'APP_ORIGIN']) delete env[key];
  const result = await run(['--test', '--test-reporter=tap', ...files], { env });
  const count = name => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(result.output)?.[1] ?? NaN);
  const tests = count('tests'), pass = count('pass'), fail = count('fail');
  const ok = result.code === 0 && fail === 0;
  return { key: 'test', name: '자동 테스트', status: ok ? 'ok' : 'fail', summary: Number.isFinite(tests) ? `${tests}개 중 ${pass}개 통과${fail ? `, ${fail}개 실패` : ''}` : '결과를 읽지 못함', ms: result.ms, output: ok ? '' : tail(result.output) };
}

// 3) 보안 점검: npm audit(운영 의존성, 높음 이상). 인터넷이나 npm이 없으면 '확인 불가'로 남긴다.
export async function auditStep() {
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && /npm-cli\.js$/.test(path) && existsSync(path));
  if (!npm) return { key: 'audit', name: '보안 점검', status: 'skip', summary: 'npm을 찾지 못해 확인 불가', ms: 0, output: '' };
  const result = await run([npm, 'audit', '--omit=dev', '--json'], { timeout: 120000 });
  let report; try { report = JSON.parse(result.output.slice(result.output.indexOf('{'))); } catch {}
  const counts = report?.metadata?.vulnerabilities;
  if (!counts) return { key: 'audit', name: '보안 점검', status: 'skip', summary: '확인 불가(인터넷 연결 확인)', ms: result.ms, output: tail(result.output) };
  const serious = (counts.high ?? 0) + (counts.critical ?? 0), total = counts.total ?? 0;
  return { key: 'audit', name: '보안 점검', status: serious ? 'fail' : 'ok', summary: total ? `취약점 ${total}개(높음 이상 ${serious}개)` : '취약점 없음', ms: result.ms, output: serious ? tail(result.output) : '' };
}

syntaxStep.label = '문법 검사'; testStep.label = '자동 테스트'; auditStep.label = '보안 점검';

export function createSelfCheck({ dataDir, steps = [syntaxStep, testStep, auditStep] }) {
  const logPath = join(dataDir, 'check-log.jsonl');
  let current = null, running = null;
  const logs = () => {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).reverse();
    } catch { return []; }
  };
  const save = entry => {
    const kept = [entry, ...logs()].slice(0, KEEP).reverse();
    const temp = `${logPath}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temp, kept.map(row => JSON.stringify(row)).join('\n') + '\n');
    renameSync(temp, logPath);
  };
  function start(trigger) {
    if (running) return current;
    current = { id: `${Date.now()}-${randomBytes(3).toString('hex')}`, trigger, commit: currentCommit(), node: process.version, started_at: new Date().toISOString(), status: 'running', steps: [] };
    running = (async () => {
      try {
        for (const step of steps) {
          current.step = step.label ?? step.name ?? '';
          try { current.steps.push(await step()); }
          catch (error) { current.steps.push({ key: step.name, name: step.label ?? '점검', status: 'fail', summary: error.message, ms: 0, output: String(error.stack ?? error) }); }
        }
        current.status = current.steps.some(step => step.status === 'fail') ? 'fail' : 'ok';
      } finally {
        delete current.step;
        current.finished_at = new Date().toISOString();
        try { save(current); } catch (error) { console.error('Self-check log could not be saved', error); }
        if (current.status === 'fail') console.warn(`Self-check failed (${current.commit ?? 'no commit'}): ${current.steps.filter(step => step.status === 'fail').map(step => `${step.name} ${step.summary}`).join(', ')}`);
        running = null;
      }
    })();
    return current;
  }
  // 코드가 바뀐 뒤(새 커밋) 아직 점검하지 않았으면 한 번 실행한다. GitHub에 올릴 때마다 돌던 점검을 대신한다.
  function runIfCodeChanged() {
    if (running || process.env.SELF_CHECK === 'off') return false;
    const commit = currentCommit();
    if (!commit || logs()[0]?.commit === commit) return false;
    start('코드 변경 감지');
    return true;
  }
  return { start, runIfCodeChanged, logs, status: () => running ? current : null, wait: () => running ?? Promise.resolve() };
}
