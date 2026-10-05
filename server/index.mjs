import { createPortal } from './app.mjs';
import { createBackup, prepareRestoreSource, restoreDatabaseFile, latestBackupTime } from './backups.mjs';
import { existsSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recordActivity } from './activity.mjs';

const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const backupDir = resolve(process.env.BACKUP_DIR ?? './backups');
let portal, server, restoring = false;

function listen() {
  return new Promise((resolveListen, reject) => {
    const running = portal.app.listen(port, host);
    running.once('error', reject);
    running.requestTimeout = 0; // 대용량 파일 업로드가 Node 기본 5분 요청 제한에 끊기지 않도록 해제
    running.once('listening', () => { server = running; resolveListen(); });
  });
}

async function restoreInPlace({ path, restoreId }) {
  if (restoring) return;
  restoring = true;
  let oldClosed = false, newOpened = false, previous = null, prepared = null;
  try {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    const safety = await createBackup(portal.db, backupDir, 'portal-pre-restore');
    console.log('Before-restore backup:', safety.name);
    prepared = prepareRestoreSource(path, dataDir, stagingDir => {
      const stagedPortal = createPortal({ dataDir: stagingDir, backupDir: join(stagingDir, 'backups') });
      stagedPortal.db.close();
    });
    portal.db.close();
    oldClosed = true;
    previous = restoreDatabaseFile(dataDir, prepared.path);
    portal = createPortal({ dataDir, backupDir, onRestore: restoreInPlace, restoreResult: { id: restoreId, ok: true } });
    newOpened = true;
    recordActivity(portal.db, { scope: 'backups', action: 'restore', title: '백업/복구 · 시점 복구 완료', detail: path.split(/[\\/]/).at(-1), key: `restore:${restoreId}` });
    await listen();
    try { rmSync(previous, { force: true }); } catch (error) { console.warn('Previous database cleanup failed:', error); }
    console.log('Portal restored from:', path);
  } catch (error) {
    console.error('Portal restore failed:', error);
    try {
      if (newOpened) portal.db.close();
      if (previous && existsSync(previous)) {
        const live = join(dataDir, 'portal.sqlite'), failed = live + '.failed-' + restoreId;
        for (const extension of ['-wal', '-shm']) rmSync(live + extension, { force: true });
        if (existsSync(live)) renameSync(live, failed);
        renameSync(previous, live);
        rmSync(failed, { force: true });
      }
      if (oldClosed) portal = createPortal({ dataDir, backupDir, onRestore: restoreInPlace, restoreResult: { id: restoreId, ok: false } });
      else portal.maintenance.restoring = false;
      await listen();
    } catch (recoveryError) {
      console.error('Portal restore recovery failed:', recoveryError);
      process.exitCode = 1;
    }
  } finally { prepared?.cleanup(); restoring = false; }
}

portal = createPortal({ dataDir, backupDir, onRestore: restoreInPlace });
portal.pruneBackups();
await listen();
console.log(`Portal: ${process.env.APP_ORIGIN ?? 'http://localhost:3000'}`);
console.log(`First-run setup code, if needed: ${portal.tokenPath}`);
// 데이터베이스 감시: 디스크 I/O 오류처럼 다시 시작해야 풀리는 SQLite 오류가 3분(3회) 연속되면 종료한다.
// 감독 프로세스(windows-start.mjs)가 곧바로 다시 띄워 새 연결로 복구한다.
const FATAL_SQLITE = /disk I\/O error|database disk image is malformed|unable to open database file/i;
let databaseFailures = 0;
function databaseCheck(error) {
  if (error && !FATAL_SQLITE.test(String(error.message))) return;
  if (!error) {
    try { portal.db.prepare('SELECT id FROM users LIMIT 1').get(); } catch (checkError) { error = checkError; }
  }
  if (!error || !FATAL_SQLITE.test(String(error.message))) { databaseFailures = 0; return; }
  databaseFailures++;
  console.error(`Database check failed (${databaseFailures}/3)`, error);
  // 감독 프로세스 아래에서 실행될 때만(또는 명시적으로 켠 경우) 종료해 재시작하게 한다. npm start로 직접 실행했다면 오류만 기록한다.
  if (databaseFailures >= 3 && (process.send || process.env.PORTAL_RESTART_ON_DB_FAILURE === 'true')) { console.error('Database unavailable for 3 minutes; exiting so the supervisor restarts the portal'); process.exit(75); }
}
// 자동 백업: 마지막 백업이 24시간보다 오래되면 백업한다. 드라이브 여유 공간이 DB 크기의 2배보다 작으면 건너뛴다.
const AUTO_BACKUP_INTERVAL = 24 * 60 * 60 * 1000;
let autoBackupRunning = false, autoBackupSkipLogged = 0;
async function autoBackup() {
  if (autoBackupRunning || restoring || process.env.AUTO_BACKUP === 'off') return;
  try { if (!portal.db.prepare('SELECT 1 FROM users LIMIT 1').get()) return; } catch { return; } // 첫 관리자 생성 전에는 백업하지 않는다.
  const latest = latestBackupTime(backupDir);
  if (latest && Date.now() - latest < AUTO_BACKUP_INTERVAL) return;
  try {
    const size = statSync(join(dataDir, 'portal.sqlite')).size, disk = statfsSync(existsSync(backupDir) ? backupDir : dataDir);
    if (Number(disk.bavail) * Number(disk.bsize) < size * 2) {
      if (Date.now() - autoBackupSkipLogged > 6 * 60 * 60 * 1000) { console.warn('Automatic backup skipped: not enough free disk space'); autoBackupSkipLogged = Date.now(); }
      return;
    }
  } catch {}
  autoBackupRunning = true;
  try {
    const saved = await createBackup(portal.db, backupDir);
    console.log('Automatic backup saved:', saved.name);
    recordActivity(portal.db, { scope: 'backups', action: 'auto-backup', title: '백업/복구 · 자동 백업 완료', detail: saved.name, key: `auto-backup:${saved.name}` });
  } catch (error) { console.error('Automatic backup failed', error); }
  finally { autoBackupRunning = false; }
}
const timer = setInterval(() => {
  if (restoring) return;
  try {
    portal.tick();
    portal.pruneBackups();
    databaseCheck();
  } catch (error) { console.error('Periodic portal task failed', error); databaseCheck(error); }
  autoBackup().catch(error => console.error('Automatic backup failed', error));
}, 60000);
function close() {
  clearInterval(timer);
  if (server?.listening) server.close(() => { portal.db.close(); process.exit(0); });
  else { try { portal.db.close(); } catch {} process.exit(0); }
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
// 감독 프로세스가 종료되면(ipc 연결 끊김) 함께 종료해 포트를 비운다.
if (process.send) process.on('disconnect', close);
