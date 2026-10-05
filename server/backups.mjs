import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const fail = (status, message) => Object.assign(new Error(message), { status });
const backupName = /^portal-[A-Za-z0-9-]+\.sqlite$/;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// 백업 보관 규칙(한국 날짜 기준): 오늘·어제·그제 3일치만 보관하고, 하루에는 최근 3건까지만 남긴다(최대 9건).
// 가장 최근 백업 1건은 기간이 지나도 지우지 않는다(PC를 며칠 끈 뒤 켰을 때 새 백업이 생기기 전까지 백업이 하나도 없게 되지 않도록).
export const BACKUP_KEEP_DAYS = 3, BACKUP_KEEP_PER_DAY = 3;
const koreaDay = time => new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

const SIDECARS = ['-wal', '-shm', '-journal'];
const removeSidecars = path => { for (const suffix of SIDECARS) rmSync(path + suffix, { force: true }); };
// 수 GB 백업 파일을 바로 지우면(rmSync) 그동안 서버 전체가 1초 가까이 멈춘다. 이름을 바꿔 목록에서 즉시 빼고
// 실제 삭제는 백그라운드에서 한다. 서버가 그 사이 꺼져 남은 파일은 다음 시작 때 cleanBackupFiles가 지운다.
const deletingName = /^portal-[A-Za-z0-9-]+\.sqlite\.deleting-[a-f0-9]+$/;
function removeInBackground(path) {
  const doomed = `${path}.deleting-${randomBytes(4).toString('hex')}`;
  renameSync(path, doomed);
  rm(doomed, { force: true }).catch(error => console.warn(`Backup file removal failed: ${doomed}`, error));
}

// 백업 파일을 단일 파일(DELETE 저널 방식)로 바꾼다. 이렇게 하면 백업을 읽기 전용으로 열거나 검사해도
// 옆에 -wal/-shm 보조 파일이 생기지 않고, 파일 하나만 복사해도 완전한 백업이 된다.
function makeStandalone(path) {
  const { atime, mtime } = statSync(path);
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode=DELETE'); } finally { db.close(); }
  removeSidecars(path);
  // 이름에 날짜가 없는 예전 백업은 수정 시각으로 생성 시점을 판단하므로 원래 시각을 유지한다.
  utimesSync(path, atime, mtime);
}

// 예전 방식 백업 옆에 남은 보조 파일(-wal/-shm, .partial-wal/-shm)을 정리한다.
// 내용이 남은 -wal 파일이 붙은 백업은 건드리지 않는다.
export function cleanBackupFiles(backupDir) {
  if (!existsSync(backupDir)) return { removed: 0, converted: 0 };
  let removed = 0, converted = 0;
  const names = new Set(readdirSync(backupDir));
  const mains = new Set();
  for (const name of names) {
    if (deletingName.test(name)) { rm(join(backupDir, name), { force: true }).catch(error => console.warn(`Backup file removal failed: ${name}`, error)); removed++; continue; }
    const match = /^(portal-[A-Za-z0-9-]+\.sqlite(?:\.partial)?)(-wal|-shm|-journal)$/.exec(name);
    if (!match) continue;
    const main = match[1];
    if (!names.has(main) || main.endsWith('.partial')) {
      // 원본이 없거나(삭제·이름 변경됨) 중간 파일의 보조 파일이면 필요 없다. 진행 중인 백업의 .partial은 남겨 둔다.
      if (main.endsWith('.partial') && names.has(main)) continue;
      try { rmSync(join(backupDir, name), { force: true }); removed++; } catch (error) { console.warn(`Backup sidecar cleanup failed: ${name}`, error); }
    } else mains.add(main);
  }
  // 보조 파일이 없어도 WAL 방식으로 저장된 예전 백업(헤더 18번째 바이트가 2)은 단일 파일로 바꾼다.
  for (const name of names) {
    if (!backupName.test(name) || mains.has(name)) continue;
    try {
      const fd = openSync(join(backupDir, name), 'r'), header = Buffer.alloc(20);
      try { readSync(fd, header, 0, 20, 0); } finally { closeSync(fd); }
      if (header.toString('latin1', 0, 15) === 'SQLite format 3' && header[18] === 2) mains.add(name);
    } catch { /* 읽을 수 없는 파일은 건너뛴다. */ }
  }
  for (const main of mains) {
    const path = join(backupDir, main);
    try {
      if (existsSync(path + '-wal') && statSync(path + '-wal').size > 0) { console.warn(`Backup has pending WAL data; left unchanged: ${main}`); continue; }
      const before = SIDECARS.filter(suffix => existsSync(path + suffix)).length;
      makeStandalone(path);
      converted++; removed += before;
    } catch (error) { console.warn(`Backup conversion failed: ${main}`, error); }
  }
  return { removed, converted };
}

export function backupPath(backupDir, name) {
  if (typeof name !== 'string' || !backupName.test(name)) throw fail(400, '백업 파일 이름을 확인해 주세요.');
  const path = join(resolve(backupDir), name);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw fail(404, '백업 파일을 찾을 수 없습니다.');
  return path;
}

function backupCreatedAt(name, info) {
  // portal-날짜, portal-pre-restore-날짜, portal-pre-login-fix-날짜처럼 이름에 기록된 UTC 생성 시각을 쓴다.
  const match = /^portal-(?:[a-z]+(?:-[a-z]+)*-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[a-f0-9]{6})?\.sqlite$/.exec(name);
  if (!match) return info.mtimeMs;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : info.mtimeMs;
}

export function pruneExpiredBackups(backupDir, now = Date.now(), protectedNames = new Set()) {
  mkdirSync(backupDir, { recursive: true });
  const removed = [], entries = [];
  for (const name of readdirSync(backupDir)) {
    if (!backupName.test(name)) continue;
    const path = join(backupDir, name), info = lstatSync(path);
    if (info.isFile()) entries.push({ name, path, time: backupCreatedAt(name, info) });
  }
  entries.sort((left, right) => right.time - left.time || right.name.localeCompare(left.name));
  const oldestDay = koreaDay(now - (BACKUP_KEEP_DAYS - 1) * 24 * 60 * 60 * 1000);
  const perDay = new Map();
  entries.forEach((entry, index) => {
    const day = koreaDay(entry.time), count = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, count);
    // 다운로드·복구 중인 파일은 지우지 않는다(그날 건수에는 포함).
    if (protectedNames.has(entry.name) || index === 0) return;
    if (day >= oldestDay && count <= BACKUP_KEEP_PER_DAY) return;
    try {
      removeInBackground(entry.path);
      removed.push(entry.name);
      removeSidecars(entry.path); removeSidecars(entry.path + '.partial');
    } catch (error) { console.warn(`Expired backup cleanup failed: ${entry.name}`, error); }
  });
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
    // 백업은 별도의 읽기 전용 연결에서 한 번에(rate 최대값) 복사한다. 운영 연결로 조금씩 복사하면 복사 단계마다
    // 그 연결이 잠겨 다른 요청이 최대 1초 가까이 기다렸다. 별도 연결은 WAL 덕분에 쓰기와 동시에 진행된다.
    const source = new DatabaseSync(db.prepare('PRAGMA database_list').get().file, { readOnly: true });
    try { await sqliteBackup(source, partial, { rate: 2147483647 }); } finally { source.close(); }
    makeStandalone(partial);
    await verifyBackupInWorker(partial);
    removeSidecars(partial);
    renameSync(partial, path);
    return { name, size: statSync(path).size, created_at: statSync(path).mtime.toISOString() };
  } catch (error) {
    rmSync(partial, { force: true });
    removeSidecars(partial);
    throw error;
  }
}

export function recoverInterruptedRestore(dataDir) {
  const live = join(dataDir, 'portal.sqlite');
  if (!existsSync(dataDir)) return;
  // 복구 검사용 임시 파일의 보조 파일(-wal/-shm)이 원본 없이 남아 있으면 지운다.
  const names = new Set(readdirSync(dataDir));
  for (const name of names) {
    const match = /^(portal\.sqlite\.restore-[a-f0-9]+)(-wal|-shm|-journal)$/.exec(name);
    if (match && !names.has(match[1])) rmSync(join(dataDir, name), { force: true });
  }
  if (existsSync(live)) return;
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
  } finally { rmSync(staged, { force: true }); removeSidecars(staged); }
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
