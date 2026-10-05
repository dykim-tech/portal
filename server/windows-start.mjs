// Windows 예약 작업이 실행하는 시작 파일.
// 감독 프로세스(기본): 실제 포털(작업 프로세스)을 띄우고, 비정상 종료되면 자동으로 다시 띄운다.
// 작업 프로세스(--worker): 로그를 data/server.log에 기록하며 index.mjs를 실행한다.
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dataDir = resolve(process.env.DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, 'server.log');
const isWorker = process.argv.includes('--worker');

function log(level, values) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${format(...values)}\n`);
}

// 로그가 5MB를 넘거나 예전 PowerShell 방식(UTF-16)으로 기록된 내용이 섞여 있으면 새 파일로 시작한다. 지난 로그는 5개까지 보관한다.
const LOG_LIMIT = 5 * 1024 * 1024, LOG_KEEP = 5;
function rotateLog() {
  if (!existsSync(logPath)) return;
  let utf16 = false;
  const fd = openSync(logPath, 'r');
  try { const head = Buffer.alloc(2); utf16 = readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0xff && head[1] === 0xfe; } finally { closeSync(fd); }
  if (!utf16 && statSync(logPath).size < LOG_LIMIT) return;
  renameSync(logPath, join(dataDir, `server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`));
  const old = readdirSync(dataDir).filter(name => /^server-\d{4}-.+\.log$/.test(name)).sort();
  for (const name of old.slice(0, Math.max(0, old.length - LOG_KEEP))) rmSync(join(dataDir, name), { force: true });
}

if (isWorker) {
  console.log = (...values) => log('INFO', values);
  console.warn = (...values) => log('WARN', values);
  console.error = (...values) => log('ERROR', values);
  process.on('warning', warning => console.warn(warning.stack ?? warning.message));
  process.on('uncaughtException', error => { console.error(error); process.exit(1); });
  process.on('unhandledRejection', error => { console.error(error); process.exit(1); });
  try {
    await import('./index.mjs');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  try { rotateLog(); } catch (error) { log('WARN', ['Log rotation failed:', error]); }
  const script = fileURLToPath(import.meta.url);
  const restarts = [];
  // 시험용으로만 바꾸는 값: 재시작 기본 대기(2초)와 반복 장애 시 쉬는 시간(5분)
  const baseDelay = Number(process.env.PORTAL_RESTART_BASE_MS) || 2000;
  const cooldown = Number(process.env.PORTAL_RESTART_COOLDOWN_MS) || 5 * 60 * 1000;
  let child = null, stopping = false;
  const start = () => {
    // ipc 채널: 감독 프로세스가 강제 종료되면 작업 프로세스도 연결이 끊겨 스스로 종료한다(포트 3000이 남지 않도록).
    child = spawn(process.execPath, [...process.execArgv, script, '--worker'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    log('INFO', [`Supervisor started portal worker (pid ${child.pid})`]);
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping || code === 0) { log('INFO', [`Portal worker stopped (code ${code ?? signal})`]); process.exit(0); }
      const now = Date.now();
      while (restarts.length && now - restarts[0] > 10 * 60 * 1000) restarts.shift();
      restarts.push(now);
      // 10분 안에 5번 넘게 멈추면 같은 문제가 반복되는 것이므로 5분 쉬었다가 다시 시도한다.
      // (감독까지 종료하면 예약 작업 재시작 3회가 끝난 뒤에는 다음 로그인 때까지 포털이 꺼진 채로 남는다.)
      if (restarts.length > 5) {
        restarts.length = 0;
        log('ERROR', [`Portal worker failed repeatedly; retrying in ${cooldown / 1000}s`]);
        setTimeout(() => { if (!stopping) start(); }, cooldown);
        return;
      }
      const delay = Math.min(30000, baseDelay * restarts.length);
      log('WARN', [`Portal worker exited (code ${code ?? signal}); restarting in ${delay / 1000}s`]);
      setTimeout(() => { if (!stopping) start(); }, delay);
    });
  };
  const stop = () => { stopping = true; if (child) child.kill(); else process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  start();
}
