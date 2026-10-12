import { DatabaseSync } from 'node:sqlite';

// 데이터베이스 감시: 디스크 I/O 오류처럼 다시 시작해야 풀리는 SQLite 오류를 감지하면 복구한다.
// 2026-10-11 절전 해제 직후 F: 드라이브 접근이 잠시 끊겨 기존 연결이 3분 동안 'disk I/O error'를 냈고, 재시작 후에야 풀렸다.
// 그래서 오류가 나면 새 연결로 파일을 열어 보고, 새 연결은 되면(이 프로세스의 연결만 망가진 경우) 바로 재시작한다.
// 새 연결도 안 되면(드라이브가 아직 준비 안 됨) 20초마다 다시 확인하고 3회 연속 실패하면 재시작한다.
// 감독 프로세스(windows-start.mjs)가 곧바로 다시 띄워 새 연결로 복구한다.
export const FATAL_SQLITE = /disk I\/O error|database disk image is malformed|unable to open database file/i;

export function freshConnectionWorks(path) {
  try {
    const probe = new DatabaseSync(path, { readOnly: true });
    try { probe.exec('PRAGMA busy_timeout=2000'); probe.prepare('SELECT id FROM users LIMIT 1').get(); return true; } finally { probe.close(); }
  } catch { return false; }
}

export function createDatabaseMonitor({ db, path, supervised, exit, restoring = () => false, recheckMs = 20000, probe = freshConnectionWorks, log = console }) {
  let failures = 0, lastFailureAt = 0, recheckTimer = null;
  function check(error) {
    if (error && !FATAL_SQLITE.test(String(error.message))) return;
    if (!error) {
      try { db().prepare('SELECT id FROM users LIMIT 1').get(); } catch (checkError) { error = checkError; }
    }
    if (!error || !FATAL_SQLITE.test(String(error.message))) { failures = 0; return; }
    failures++; lastFailureAt = Date.now();
    log.error(`Database check failed (${failures}/3)`, error);
    // 감독 프로세스 아래에서 실행될 때만(또는 명시적으로 켠 경우) 종료해 재시작하게 한다. npm start로 직접 실행했다면 오류만 기록한다.
    if (!supervised()) return;
    if (probe(path)) { log.error('Database opens fine from a new connection; restarting now to replace the broken connection'); exit(75); return; }
    if (failures >= 3) { log.error('Database unavailable after 3 checks; exiting so the supervisor restarts the portal'); exit(75); return; }
    if (!recheckTimer) recheckTimer = setTimeout(() => { recheckTimer = null; if (!restoring()) check(); }, recheckMs);
  }
  // 요청 처리 중 생긴 같은 종류의 오류도 바로 점검한다(5초에 한 번까지).
  function report(error) {
    if (!FATAL_SQLITE.test(String(error?.message)) || restoring() || Date.now() - lastFailureAt < 5000) return;
    try { check(error); } catch (checkError) { log.error('Database check failed', checkError); }
  }
  return { check, report, failures: () => failures, stop: () => { clearTimeout(recheckTimer); recheckTimer = null; } };
}
