import multer from 'multer';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export const MAX_FILE_SIZE = 500 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const tables = new Set(['files', 'manuals', 'installation_files']);

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
  return multer({ dest: tempDir, limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 0 } }).single('file');
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

export function deleteUploadChunks(db, scope, fileId) {
  table(scope);
  db.prepare('DELETE FROM file_chunks WHERE scope=? AND file_id=?').run(scope, fileId);
}

export function getStoredFile(db, scope, fileId) {
  table(scope);
  const preview = scope === 'files' ? 'NULL AS preview_type' : 'preview_type';
  const parent = scope === 'files' ? 'item_id' : scope === 'manuals' ? 'folder_id' : 'installation_id';
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
  const rows = db.prepare('SELECT bytes FROM file_chunks WHERE scope=? AND file_id=? ORDER BY seq').iterate(scope, file.id);
  const source = Readable.from((function* () { for (const row of rows) yield row.bytes; })());
  source.on('error', error => { console.error(error); res.destroy(error); });
  res.on('close', () => source.destroy());
  source.pipe(res);
}
