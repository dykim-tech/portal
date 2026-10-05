import multer from 'multer';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { transaction } from './db.mjs';

// 업로드 파일 크기 제한 없음. 디스크 여유 공간이 실제 한도가 된다.
const CHUNK_SIZE = 1024 * 1024;
const tables = new Set(['files', 'manuals', 'installation_files', 'todo_files', 'customer_files']);

function table(name) {
  if (!tables.has(name)) throw new Error('Unknown file table');
  return name;
}

export function initializeUploadChunks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS file_chunks (
    scope TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY(scope, file_id, seq)
  ) WITHOUT ROWID;`);
}

export function createUploadMiddleware(dataDir) {
  const tempDir = join(dataDir, 'upload-tmp');
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  // Multer uses 32-character random hex names. A restart leaves no active uploads.
  for (const entry of readdirSync(tempDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{32}$/.test(entry.name)) {
      try { unlinkSync(join(tempDir, entry.name)); }
      catch (error) { console.warn('Could not remove an old upload temporary file:', error); }
    }
  }
  return multer({ dest: tempDir, limits: { files: 1, fields: 0 } }).single('file');
}

export function uploadHeader(path, size = 16) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(size);
    return header.subarray(0, readSync(fd, header, 0, size, 0));
  } finally {
    closeSync(fd);
  }
}

export function writeUploadChunks(db, scope, fileId, file) {
  table(scope);
  const insert = db.prepare('INSERT INTO file_chunks(scope,file_id,seq,bytes) VALUES(?,?,?,?)');
  const fd = openSync(file.path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let bytesRead, written = 0, seq = 0;
  try {
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      insert.run(scope, fileId, seq++, buffer.subarray(0, bytesRead));
      written += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  if (written !== file.size) throw new Error('Uploaded file size changed while saving.');
}

export function discardUpload(file) {
  if (!file?.path || !existsSync(file.path)) return;
  try { unlinkSync(file.path); }
  catch (error) { console.warn('Could not remove an upload temporary file:', error); }
}

// 큰 첨부를 한 번에 지우면 SQLite가 수 GB를 읽고 쓰는 동안 서버 전체가 멈추므로,
// 작은 파일만 즉시 지우고 큰 파일은 기록 삭제가 확정된 뒤 조금씩 나누어 지운다.
const IMMEDIATE_DELETE_CHUNKS = 16, PURGE_BATCH_CHUNKS = 16;
const purgeQueue = [];
let purging = false;
const pause = () => new Promise(resolve => setImmediate(resolve));

export function deleteUploadChunks(db, scope, fileId) {
  table(scope);
  const count = db.prepare('SELECT COUNT(*) AS n FROM file_chunks WHERE scope=? AND file_id=?').get(scope, fileId).n;
  if (count <= IMMEDIATE_DELETE_CHUNKS) {
    db.prepare('DELETE FROM file_chunks WHERE scope=? AND file_id=?').run(scope, fileId);
    return;
  }
  scheduleChunkPurge(db, scope, fileId);
}

function scheduleChunkPurge(db, scope, fileId) {
  purgeQueue.push({ db, scope, fileId });
  if (!purging) setImmediate(() => runChunkPurge().catch(error => console.error('Attachment cleanup failed:', error)));
}

async function runChunkPurge() {
  if (purging) return;
  purging = true;
  try {
    while (purgeQueue.length) {
      const { db, scope, fileId } = purgeQueue.shift();
      if (!db.isOpen) continue;
      // 삭제 트랜잭션이 취소되어 기록이 남아 있으면 첨부 조각을 지우지 않는다.
      if (db.prepare(`SELECT 1 FROM ${table(scope)} WHERE id=?`).get(fileId)) continue;
      const step = db.prepare('DELETE FROM file_chunks WHERE scope=? AND file_id=? AND seq IN (SELECT seq FROM file_chunks WHERE scope=? AND file_id=? ORDER BY seq LIMIT ?)');
      while (db.isOpen && step.run(scope, fileId, scope, fileId, PURGE_BATCH_CHUNKS).changes > 0) await pause();
    }
  } finally { purging = false; }
}

// 서버가 업로드나 정리 도중 꺼져 기록 없이 남은 첨부 조각을 시작할 때 백그라운드로 정리한다.
export function purgeOrphanChunks(db) {
  for (const scope of tables) {
    for (const row of db.prepare(`SELECT DISTINCT file_id FROM file_chunks WHERE scope=? AND file_id NOT IN (SELECT id FROM ${scope})`).all(scope)) scheduleChunkPurge(db, scope, row.file_id);
  }
}

// 업로드 저장: 첨부 조각을 작은 트랜잭션으로 나누어 기록하고 그 사이에 다른 요청을 처리한다.
// 조각이 모두 기록된 뒤에만 기록 행을 만들므로 저장 중인 파일은 목록·다운로드에 나타나지 않는다.
const UPLOAD_BATCH_CHUNKS = 8;
const reservedIds = new Map();
function reserveFileId(db, scope) {
  const recordMax = db.prepare(`SELECT COALESCE(MAX(id),0) AS n FROM ${table(scope)}`).get().n;
  const chunkMax = db.prepare('SELECT COALESCE(MAX(file_id),0) AS n FROM file_chunks WHERE scope=?').get(scope).n;
  const next = Math.max(recordMax, chunkMax, reservedIds.get(scope) ?? 0) + 1;
  reservedIds.set(scope, next);
  return next;
}

export async function storeUpload(db, scope, file, insertRecord) {
  table(scope);
  const fileId = reserveFileId(db, scope);
  const insert = db.prepare('INSERT INTO file_chunks(scope,file_id,seq,bytes) VALUES(?,?,?,?)');
  const fd = openSync(file.path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let written = 0, seq = 0, done = false;
  try {
    while (!done) {
      transaction(db, () => {
        for (let count = 0; count < UPLOAD_BATCH_CHUNKS; count++) {
          const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
          if (bytesRead <= 0) { done = true; return; }
          insert.run(scope, fileId, seq++, buffer.subarray(0, bytesRead));
          written += bytesRead;
        }
      });
      if (!done) await pause();
    }
    if (written !== file.size) throw new Error('Uploaded file size changed while saving.');
    return transaction(db, () => insertRecord(fileId));
  } catch (error) {
    if (db.isOpen) {
      if (seq <= IMMEDIATE_DELETE_CHUNKS) db.prepare('DELETE FROM file_chunks WHERE scope=? AND file_id=?').run(scope, fileId);
      else if (!db.prepare(`SELECT 1 FROM ${scope} WHERE id=?`).get(fileId)) scheduleChunkPurge(db, scope, fileId);
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

export function getStoredFile(db, scope, fileId) {
  table(scope);
  const preview = ['manuals', 'installation_files'].includes(scope) ? 'preview_type' : 'NULL AS preview_type';
  const parent = {files:'item_id',manuals:'folder_id',installation_files:'installation_id',todo_files:'todo_id',customer_files:'customer_id'}[scope];
  return db.prepare(`SELECT id,name,size,created_at,${preview},${parent} AS parent_id,length(bytes) AS inline_size FROM ${scope} WHERE id=?`).get(fileId);
}

export function sendStoredFile(db, scope, file, res) {
  table(scope);
  res.set('Content-Length', String(file.size));
  if (file.size === 0) return res.end();
  // Records created before chunked storage retain their original inline BLOB.
  if (file.inline_size > 0) {
    return res.end(db.prepare(`SELECT bytes FROM ${scope} WHERE id=?`).get(file.id).bytes);
  }
  // 조각을 하나씩 따로 읽는다. 다운로드 내내 읽기 트랜잭션을 열어 두면 그동안 WAL 체크포인트가 막혀
  // 다른 업로드가 있을 때 WAL 파일이 수 GB까지 커지므로, 조각마다 짧게 읽고 바로 닫는다.
  const chunk = db.prepare('SELECT bytes FROM file_chunks WHERE scope=? AND file_id=? AND seq=?');
  let seq = 0, sent = 0;
  const source = new Readable({
    highWaterMark: 4 * 1024 * 1024,
    read() {
      try {
        if (!db.isOpen) throw new Error('Database closed during download.');
        const row = chunk.get(scope, file.id, seq++);
        if (!row) {
          if (sent !== file.size) throw new Error(`Stored file is incomplete (${sent}/${file.size} bytes).`);
          this.push(null);
          return;
        }
        sent += row.bytes.length;
        this.push(row.bytes);
      } catch (error) { this.destroy(error); }
    }
  });
  source.on('error', error => { console.error(error.message); res.destroy(error); });
  res.on('close', () => source.destroy());
  source.pipe(res);
}
