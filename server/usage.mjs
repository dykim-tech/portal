import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { join, parse } from 'node:path';

// 사용량 관리: 로컬 드라이브 공간과 포털 데이터·백업·첨부 사용량을 관리자에게 보여 준다.
const attachmentTables = [
  ['manuals', '자료 관리'],
  ['installation_files', '설치관리 첨부'],
  ['files', '자산 관리 첨부'],
  ['customer_files', '업무관리 고객 첨부'],
  ['todo_files', 'TO-DO List 첨부'],
];

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function folderSize(dir) {
  let size = 0, count = 0;
  if (!existsSync(dir)) return { size, count };
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { size += fileSize(path); count++; }
    }
  };
  try { walk(dir); } catch { /* 접근할 수 없는 항목은 건너뛴다. */ }
  return { size, count };
}

function drive(label, path) {
  try {
    const info = statfsSync(path);
    const total = Number(info.blocks) * Number(info.bsize), free = Number(info.bavail) * Number(info.bsize);
    return { label, root: parse(path).root || path, path, total, free, used: Math.max(0, total - free), dev: statSync(path).dev };
  } catch (error) {
    return { label, root: parse(path).root || path, path, error: '드라이브 정보를 읽지 못했습니다.' };
  }
}

export function registerUsage(app, { db, requireRole, dataDir, backupDir }) {
  const admin = requireRole(['admin']);
  app.get('/api/usage', admin, (_req, res) => {
    const database = join(dataDir, 'portal.sqlite');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const freePages = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const uploads = folderSize(join(dataDir, 'upload-tmp'));
    const backups = folderSize(backupDir);
    const drives = [drive('데이터 저장 드라이브', dataDir)];
    const backupDrive = drive('백업 저장 드라이브', backupDir);
    if (!backupDrive.error && backupDrive.dev !== drives[0].dev) drives.push(backupDrive);
    const attachments = attachmentTables.map(([table, label]) => {
      const row = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS size FROM ${table}`).get();
      return { key: table, label, count: row.count, size: row.size };
    });
    res.json({
      generated_at: new Date().toISOString(),
      drives: drives.map(({ dev, ...rest }) => rest),
      storage: [
        { key: 'database', label: '데이터베이스', path: database, size: fileSize(database) },
        { key: 'wal', label: 'SQLite 보조 파일 (WAL)', path: database + '-wal', size: fileSize(database + '-wal') },
        { key: 'shm', label: 'SQLite 보조 파일 (SHM)', path: database + '-shm', size: fileSize(database + '-shm') },
        { key: 'upload_tmp', label: '업로드 임시 폴더', path: join(dataDir, 'upload-tmp'), size: uploads.size, count: uploads.count },
        { key: 'log', label: '실행 로그', path: join(dataDir, 'server.log'), size: fileSize(join(dataDir, 'server.log')) },
        { key: 'backups', label: '백업 폴더', path: backupDir, size: backups.size, count: backups.count },
      ],
      database: { page_size: pageSize, allocated: pageSize * pageCount, reclaimable: pageSize * freePages },
      attachments,
    });
  });
}
