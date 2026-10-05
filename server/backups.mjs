import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const fail = (status, message) => Object.assign(new Error(message), { status });
const backupName = /^portal-[A-Za-z0-9-]+\.sqlite$/;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const coreTables = ['users', 'items', 'installations', 'folders', 'manuals', 'work_logs'];
const legacyTables = ['users', 'sessions', 'login_attempts', 'items', 'files', 'history', 'notifications', 'installations', 'folders', 'manuals'];
const preservedTables = ['users', 'items', 'files', 'history', 'installations', 'folders', 'manuals'];
const legacyColumns = {
  users: ['id', 'name', 'email', 'password', 'role', 'active', 'created_at'],
  items: ['id', 'asset_code', 'created_by', 'updated_by'],
  installations: ['id', 'customer', 'created_by', 'updated_by'],
  folders: ['id', 'parent_id', 'name'],
  manuals: ['id', 'folder_id', 'name', 'size', 'bytes', 'uploaded_by']
};

export function backupPath(backupDir, name) {
  if (typeof name !== 'string' || !backupName.test(name)) throw fail(400, '백업 파일 이름을 확인해 주세요.');
  const path = join(resolve(backupDir), name);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw fail(404, '백업 파일을 찾을 수 없습니다.');
  return path;
}

function backupCreatedAt(name, info) {
  const match = /^portal-(?:pre-restore-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[a-f0-9]{6})?\.sqlite$/.exec(name);
  if (!match) return info.mtimeMs;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : info.mtimeMs;
}

export function pruneExpiredBackups(backupDir, now = Date.now(), protectedNames = new Set()) {
  mkdirSync(backupDir, { recursive: true });
  const removed = [];
  for (const name of readdirSync(backupDir)) {
    if (!backupName.test(name) || protectedNames.has(name)) continue;
    const path = join(backupDir, name), info = lstatSync(path);
    if (!info.isFile() || backupCreatedAt(name, info) > now - retentionMs) continue;
    try {
      rmSync(path);
      removed.push(name);
      for (const suffix of ['-wal', '-shm', '.partial-wal', '.partial-shm']) {
        const sidecar = path + suffix;
        if (existsSync(sidecar) && lstatSync(sidecar).isFile()) rmSync(sidecar);
      }
    } catch (error) { console.warn(`Expired backup cleanup failed: ${name}`, error); }
  }
  return removed;
}

// 가장 최근 일반 백업의 생성 시각(복구 직전 백업 제외). 없으면 null.
export function latestBackupTime(backupDir) {
  if (!existsSync(backupDir)) return null;
  let latest = null;
  for (const name of readdirSync(backupDir)) {
    if (!/^portal-\d{4}-.+\.sqlite$/.test(name)) continue;
    let time; try { time = backupCreatedAt(name, statSync(join(backupDir, name))); } catch { continue; }
    if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
  }
  return latest;
}
export function listBackups(backupDir) {
  mkdirSync(backupDir, { recursive: true });
  return readdirSync(backupDir)
    .filter(name => backupName.test(name))
    .flatMap(name => {
      const path = join(backupDir, name), info = lstatSync(path);
      return info.isFile() ? [{ name, size: info.size, created_at: new Date(backupCreatedAt(name, info)).toISOString() }] : [];
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.name.localeCompare(left.name));
}

function inspectBackup(path, allowLegacy = false) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw fail(400, '백업 파일의 무결성 검사에 실패했습니다.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw fail(400, '백업 파일의 연결 정보가 올바르지 않습니다.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const current = coreTables.every(name => tables.has(name)) && legacyTables.every(name => tables.has(name)) && tables.has('customers');
    const legacy = allowLegacy && !tables.has('work_logs') && !tables.has('customers') && legacyTables.every(name => tables.has(name))
      && Object.entries(legacyColumns).every(([table, columns]) => {
        const available = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        return columns.every(column => available.has(column));
      });
    if (!current && !legacy) throw fail(400, '지원되지 않는 백업 형식입니다. 핵심 테이블 또는 열을 확인해 주세요.');
    if (!db.prepare('SELECT id FROM users LIMIT 1').get()) throw fail(400, '관리자 계정이 없는 백업은 복구할 수 없습니다.');
    return { legacy: !current, counts: Object.fromEntries(preservedTables.map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])) };
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, '백업 파일을 열 수 없습니다.');
  } finally { db?.close(); }
}

export function verifyBackup(path) { return inspectBackup(path); }

export function verifyRestoreCandidate(path) { return inspectBackup(path, true); }

// Migrate a disposable copy. The selected backup is never opened for writing.
export function prepareRestoreSource(sourcePath, dataDir, migrate) {
  const source = verifyRestoreCandidate(sourcePath);
  if (!source.legacy) return { path: sourcePath, cleanup() {} };
  const stagingDir = mkdtempSync(join(dataDir, 'portal-restore-check-'));
  const stagedPath = join(stagingDir, 'portal.sqlite');
  try {
    copyFileSync(sourcePath, stagedPath);
    migrate(stagingDir);
    const migrated = verifyBackup(stagedPath);
    for (const table of preservedTables) {
      if (migrated.counts[table] !== source.counts[table]) throw fail(400, `이전 백업의 ${table} 데이터가 보존되지 않아 복구를 중단했습니다.`);
    }
    return { path: stagedPath, cleanup: () => rmSync(stagingDir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function verifyBackupInWorker(path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-verify-worker.mjs', import.meta.url), { workerData: { path } });
    worker.once('message', message => message.ok ? resolve() : reject(Object.assign(new Error(message.message), { status: message.status })));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Backup verification worker exited with code ${code}`)); });
  });
}

export async function createBackup(db, backupDir, prefix = 'portal') {
  mkdirSync(backupDir, { recursive: true });
  const name = `${prefix}-${stamp()}-${randomBytes(3).toString('hex')}.sqlite`;
  const path = join(backupDir, name), partial = path + '.partial';
  try {
    await sqliteBackup(db, partial);
    await verifyBackupInWorker(partial);
    renameSync(partial, path);
    return { name, size: statSync(path).size, created_at: statSync(path).mtime.toISOString() };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

export function recoverInterruptedRestore(dataDir) {
  const live = join(dataDir, 'portal.sqlite');
  if (existsSync(live) || !existsSync(dataDir)) return;
  const previous = readdirSync(dataDir).filter(name => /^portal\.sqlite\.previous-[a-f0-9]+$/.test(name)).sort().at(-1);
  if (previous) renameSync(join(dataDir, previous), live);
}

// The caller must stop HTTP traffic and close the live SQLite connection first.
export function restoreDatabaseFile(dataDir, sourcePath) {
  verifyBackup(sourcePath);
  const live = join(dataDir, 'portal.sqlite');
  const suffix = randomBytes(6).toString('hex');
  const staged = join(dataDir, `portal.sqlite.restore-${suffix}`);
  const previous = join(dataDir, `portal.sqlite.previous-${suffix}`);
  copyFileSync(sourcePath, staged);
  try {
    verifyBackup(staged);
    for (const extension of ['-wal', '-shm']) rmSync(live + extension, { force: true });
    renameSync(live, previous);
    try { renameSync(staged, live); }
    catch (error) { renameSync(previous, live); throw error; }
    return previous;
  } finally { rmSync(staged, { force: true }); }
}

export function registerBackups(app, { db, backupDir, requireRole, maintenance, onRestore }) {
  const admin = requireRole(['admin']);
  let busy = false;
  const downloading = new Set();
  const prune = () => { if (!busy && !maintenance.restoring) pruneExpiredBackups(backupDir, Date.now(), downloading); };
  app.get('/api/backups', admin, (_req, res) => { prune(); res.json({ backups: listBackups(backupDir) }); });
  app.post('/api/backups', admin, async (_req, res) => {
    if (busy) throw fail(409, '백업 작업이 진행 중입니다.');
    busy = true;
    try { res.status(201).json({ backup: await createBackup(db, backupDir) }); }
    finally { busy = false; prune(); }
  });
  app.get('/api/backups/:name/download', admin, (req, res) => {
    prune();
    const path = backupPath(backupDir, req.params.name);
    downloading.add(req.params.name);
    res.once('close', () => downloading.delete(req.params.name));
    res.download(path, req.params.name);
  });
  app.post('/api/backups/:name/restore', admin, (req, res) => {
    if (!onRestore) throw fail(501, '이 실행 방식에서는 화면 복구를 사용할 수 없습니다.');
    if (busy || maintenance.restoring) throw fail(409, '백업 또는 복구 작업이 진행 중입니다.');
    if (req.body?.confirm !== req.params.name) throw fail(400, '선택한 백업 파일을 다시 확인해 주세요.');
    prune();
    const path = backupPath(backupDir, req.params.name);
    verifyRestoreCandidate(path);
    const restoreId = randomBytes(12).toString('hex');
    maintenance.restoring = true;
    res.once('close', () => { if (!res.writableFinished) maintenance.restoring = false; });
    res.once('finish', () => setImmediate(() => onRestore({ path, restoreId }).catch(error => console.error('Restore failed', error))));
    res.json({ ok: true, restore_id: restoreId });
  });
  return prune;
}
