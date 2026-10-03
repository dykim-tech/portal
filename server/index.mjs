import { createPortal } from './app.mjs';
import { createBackup, restoreDatabaseFile } from './backups.mjs';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const backupDir = resolve(process.env.BACKUP_DIR ?? './backups');
let portal, server, restoring = false;

function listen() {
  return new Promise((resolveListen, reject) => {
    const running = portal.app.listen(port, host);
    running.once('error', reject);
    running.once('listening', () => { server = running; resolveListen(); });
  });
}

async function restoreInPlace({ path, restoreId }) {
  if (restoring) return;
  restoring = true;
  let oldClosed = false, newOpened = false, previous = null;
  try {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    const safety = await createBackup(portal.db, backupDir, 'portal-pre-restore');
    console.log('Before-restore backup:', safety.name);
    portal.db.close();
    oldClosed = true;
    previous = restoreDatabaseFile(dataDir, path);
    portal = createPortal({ dataDir, backupDir, onRestore: restoreInPlace, restoreResult: { id: restoreId, ok: true } });
    newOpened = true;
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
  } finally { restoring = false; }
}

portal = createPortal({ dataDir, backupDir, onRestore: restoreInPlace });
await listen();
console.log(`Portal: ${process.env.APP_ORIGIN ?? 'http://localhost:3000'}`);
console.log(`First-run setup code, if needed: ${portal.tokenPath}`);
const timer = setInterval(() => { try { portal.tick(); } catch (error) { console.error('Deadline scan failed', error); } }, 60000);
function close() {
  clearInterval(timer);
  if (server?.listening) server.close(() => { portal.db.close(); process.exit(0); });
  else { try { portal.db.close(); } catch {} process.exit(0); }
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
