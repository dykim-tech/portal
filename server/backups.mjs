import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const backupName = /^portal-[A-Za-z0-9-]+\.sqlite$/;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function backupPath(backupDir, name) {
  if (typeof name !== 'string' || !backupName.test(name)) throw fail(400, '백업 파일 이름을 확인해 주세요.');
  const path = join(resolve(backupDir), name);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw fail(404, '백업 파일을 찾을 수 없습니다.');
  return path;
}

export function listBackups(backupDir) {
  mkdirSync(backupDir, { recursive: true });
  return readdirSync(backupDir)
    .filter(name => backupName.test(name))
    .flatMap(name => {
      const path = join(backupDir, name), info = lstatSync(path);
      return info.isFile() ? [{ name, size: info.size, created_at: info.mtime.toISOString() }] : [];
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.name.localeCompare(left.name));
}

export function verifyBackup(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw fail(400, '백업 파일의 무결성 검사에 실패했습니다.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw fail(400, '백업 파일의 연결 정보가 올바르지 않습니다.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!['users', 'items', 'installations', 'folders', 'manuals', 'work_logs'].every(name => tables.has(name))) throw fail(400, '이 백업은 화면 복구가 지원하지 않는 오래된 형식입니다. 운영 문서의 수동 복구 절차를 사용해 주세요.');
    if (!db.prepare('SELECT id FROM users LIMIT 1').get()) throw fail(400, '관리자 계정이 없는 백업은 복구할 수 없습니다.');
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, '백업 파일을 열 수 없습니다.');
  } finally { db?.close(); }
}

export async function createBackup(db, backupDir, prefix = 'portal') {
  mkdirSync(backupDir, { recursive: true });
  const name = `${prefix}-${stamp()}-${randomBytes(3).toString('hex')}.sqlite`;
  const path = join(backupDir, name), partial = path + '.partial';
  try {
    await sqliteBackup(db, partial);
    verifyBackup(partial);
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
  app.get('/api/backups', admin, (_req, res) => res.json({ backups: listBackups(backupDir) }));
  app.post('/api/backups', admin, async (_req, res) => {
    if (busy) throw fail(409, '백업 작업이 진행 중입니다.');
    busy = true;
    try { res.status(201).json({ backup: await createBackup(db, backupDir) }); }
    finally { busy = false; }
  });
  app.get('/api/backups/:name/download', admin, (req, res) => {
    const path = backupPath(backupDir, req.params.name);
    res.download(path, req.params.name);
  });
  app.post('/api/backups/:name/restore', admin, (req, res) => {
    if (!onRestore) throw fail(501, '이 실행 방식에서는 화면 복구를 사용할 수 없습니다.');
    if (busy || maintenance.restoring) throw fail(409, '백업 또는 복구 작업이 진행 중입니다.');
    if (req.body?.confirm !== req.params.name) throw fail(400, '선택한 백업 파일을 다시 확인해 주세요.');
    const path = backupPath(backupDir, req.params.name);
    verifyBackup(path);
    const restoreId = randomBytes(12).toString('hex');
    maintenance.restoring = true;
    res.once('close', () => { if (!res.writableFinished) maintenance.restoring = false; });
    res.once('finish', () => setImmediate(() => onRestore({ path, restoreId }).catch(error => console.error('Restore failed', error))));
    res.json({ ok: true, restore_id: restoreId });
  });
}
