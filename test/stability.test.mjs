import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPortal } from '../server/app.mjs';
import { latestBackupTime, createBackup, cleanBackupFiles, recoverInterruptedRestore, pruneExpiredBackups } from '../server/backups.mjs';
import { DatabaseSync } from 'node:sqlite';
import { purgeOrphanChunks, deleteUploadChunks } from '../server/uploads.mjs';

const freePort = () => new Promise((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
async function health(port) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); return await r.json(); } catch { return null; } }
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await wait(200); } throw new Error('timed out'); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('health reports database status and backups are verified off the main thread', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-stability-')), backupDir = join(dataDir, 'backups');
  const portal = createPortal({ dataDir, backupDir, origin: 'http://localhost:3100' });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const data = await health(server.address().port);
    assert.equal(data.ok, true);
    assert.equal(data.database, 'ok');
    const port = server.address().port, origin = 'http://localhost:3100';
    const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' }) });
    assert.equal(setup.status, 201);
    assert.equal(latestBackupTime(backupDir), null);
    const saved = await createBackup(portal.db, backupDir);
    assert.ok(existsSync(join(backupDir, saved.name)));
    assert.ok(Math.abs(latestBackupTime(backupDir) - Date.now()) < 60000);
    writeFileSync(join(backupDir, 'portal-pre-restore-2099-01-01T00-00-00-000Z-abcdef.sqlite'), 'x');
    assert.ok(latestBackupTime(backupDir) < Date.parse('2099-01-01T00:00:00Z'), 'pre-restore backups are not counted');
  } finally {
    await new Promise(r => server.close(r)); portal.db.close();
  }
});

test('supervisor restarts a crashed worker and the worker stops when the supervisor dies', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-supervisor-')), port = await freePort();
  mkdirSync(join(dataDir, 'backups'), { recursive: true });
  // 예전 PowerShell 방식(UTF-16) 로그는 시작할 때 별도 파일로 분리된다.
  writeFileSync(join(dataDir, 'server.log'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const env = { ...process.env, NODE_ENV: '', DATA_DIR: dataDir, BACKUP_DIR: join(dataDir, 'backups'), PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: `http://localhost:${port}`, AUTO_BACKUP: 'off' };
  const supervisor = spawn(process.execPath, [resolve('server/windows-start.mjs')], { env, stdio: 'ignore' });
  try {
    const first = await until(() => health(port));
    assert.equal(first.database, 'ok');
    const log = () => readFileSync(join(dataDir, 'server.log'), 'utf8');
    const workerPid = Number(/Supervisor started portal worker \(pid (\d+)\)/.exec(await until(() => /pid \d+/.test(log()) && log()))[1]);
    assert.ok(readdirSync(dataDir).some(name => /^server-\d{4}-.+\.log$/.test(name)), 'UTF-16 log was rotated');
    process.kill(workerPid, 'SIGKILL');
    const second = await until(async () => { const h = await health(port); return h && h.instance_id !== first.instance_id && h; });
    assert.notEqual(second.instance_id, first.instance_id);
    assert.match(log(), /restarting in/);
    const newPid = Number([...log().matchAll(/pid (\d+)\)/g)].at(-1)[1]);
    supervisor.kill('SIGKILL');
    await until(() => !alive(newPid), 15000);
    assert.equal(await health(port), null, 'port is released after the supervisor is gone');
  } finally {
    if (alive(supervisor.pid)) supervisor.kill('SIGKILL');
  }
});

test('backups are standalone files and leftover sidecar files are tidied', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-backupfiles-')), backupDir = join(dataDir, 'backups');
  const portal = createPortal({ dataDir, backupDir, origin: 'http://localhost:3100' });
  try {
    portal.db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES('관리자','admin','a@example.test','x','admin',datetime())").run();
    const saved = await createBackup(portal.db, backupDir);
    assert.deepEqual(readdirSync(backupDir), [saved.name], 'only the backup file itself remains');
    const check = new DatabaseSync(join(backupDir, saved.name), { readOnly: true });
    assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    check.prepare('SELECT COUNT(*) FROM users').get(); check.close();
    assert.deepEqual(readdirSync(backupDir), [saved.name], 'reading a backup creates no -wal/-shm files');

    // 예전 방식(WAL) 백업과 그 보조 파일, 원본 없는 보조 파일
    const old = 'portal-2026-01-01T00-00-00-000Z.sqlite', oldPath = join(backupDir, old);
    const legacy = new DatabaseSync(oldPath); legacy.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1)'); legacy.close();
    writeFileSync(oldPath + '-wal', ''); writeFileSync(oldPath + '-shm', Buffer.alloc(32768));
    for (const name of ['portal-2026-01-02T00-00-00-000Z.sqlite.partial-wal', 'portal-2026-01-02T00-00-00-000Z.sqlite.partial-shm', 'portal-gone.sqlite-shm']) writeFileSync(join(backupDir, name), '');
    // 보조 파일 없이 WAL 방식으로 남은 예전 백업
    const bare = 'portal-2026-01-03T00-00-00-000Z.sqlite';
    const bareDb = new DatabaseSync(join(backupDir, bare)); bareDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x)'); bareDb.close();
    assert.ok(!existsSync(join(backupDir, bare + '-wal')));
    const result = cleanBackupFiles(backupDir);
    assert.equal(result.converted, 2);
    assert.deepEqual(readdirSync(backupDir).sort(), [old, bare, saved.name].sort());
    assert.equal(readFileSync(join(backupDir, bare))[18], 1, 'converted to a rollback-journal (standalone) file');
    assert.deepEqual(cleanBackupFiles(backupDir), { removed: 0, converted: 0 }, 'a second run has nothing to do');
    const reopened = new DatabaseSync(oldPath, { readOnly: true });
    assert.equal(reopened.prepare('SELECT x FROM t').get().x, 1);
    assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); reopened.close();

    // 복구 검사용 임시 파일의 보조 파일만 남은 경우
    writeFileSync(join(dataDir, 'portal.sqlite.restore-abc123-wal'), ''); writeFileSync(join(dataDir, 'portal.sqlite.restore-abc123-shm'), '');
    recoverInterruptedRestore(dataDir);
    assert.ok(!readdirSync(dataDir).some(name => name.startsWith('portal.sqlite.restore-')));
  } finally { portal.db.close(); }
});

test('a slow download does not hold a read transaction that blocks WAL checkpoints', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-download-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const writer = new DatabaseSync(join(dataDir, 'portal.sqlite'));
  try {
    const headers = { Origin: origin, 'X-Portal-Request': '1' };
    const json = { ...headers, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' }) })).status, 201);
    const cookie = (await fetch(base + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', password: 'test-password-1234' }) })).headers.get('set-cookie').split(';')[0];
    const size = 24 * 1024 * 1024, content = Buffer.alloc(size, 7); content.write('portal-download-check', 5 * 1024 * 1024);
    const form = new FormData(); form.append('file', new Blob([content]), 'big.bin');
    const uploaded = await fetch(base + '/api/manuals?folder=', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: form });
    assert.equal(uploaded.status, 201);
    const id = (await uploaded.json()).manual?.id ?? portal.db.prepare('SELECT id FROM manuals ORDER BY id DESC').get().id;
    const response = await fetch(`${base}/api/manuals/${id}/download`, { headers: { Cookie: cookie } });
    const reader = response.body.getReader();
    const first = await reader.read(); assert.ok(first.value.length > 0);
    await wait(100);
    // 다운로드가 멈춰 있는 동안 다른 쓰기와 체크포인트가 막히지 않아야 한다.
    writer.exec('CREATE TABLE IF NOT EXISTS probe(x); INSERT INTO probe VALUES(randomblob(100000));');
    const checkpoint = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'checkpoint completed while the download was paused');
    const parts = [first.value]; for (let next; !(next = await reader.read()).done;) parts.push(next.value);
    const received = Buffer.concat(parts.map(part => Buffer.from(part)));
    assert.equal(received.length, size);
    assert.ok(received.equals(content), 'downloaded bytes match the upload');
  } finally {
    writer.close();
    await new Promise(r => server.close(r)); portal.db.close();
  }
});

test('supervisor keeps retrying after repeated start failures instead of giving up', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-retry-')), port = await freePort();
  // 포트를 다른 프로그램이 쓰고 있어 포털이 시작하지 못하는 상황
  const blocker = createServer(); await new Promise(r => blocker.listen(port, '127.0.0.1', r));
  const env = { ...process.env, NODE_ENV: '', DATA_DIR: dataDir, BACKUP_DIR: join(dataDir, 'backups'), PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: `http://localhost:${port}`, AUTO_BACKUP: 'off', PORTAL_RESTART_BASE_MS: '50', PORTAL_RESTART_COOLDOWN_MS: '1500' };
  const supervisor = spawn(process.execPath, [resolve('server/windows-start.mjs')], { env, stdio: 'ignore' });
  const log = () => existsSync(join(dataDir, 'server.log')) ? readFileSync(join(dataDir, 'server.log'), 'utf8') : '';
  try {
    await until(() => /failed repeatedly; retrying in 1\.5s/.test(log()), 30000);
    assert.ok(alive(supervisor.pid), 'supervisor is still running');
    // 쉬는 시간 동안 포트가 비면 다음 시도에서 정상 시작한다.
    await new Promise(r => blocker.close(r));
    const healthy = await until(() => health(port), 30000);
    assert.equal(healthy.database, 'ok');
  } finally {
    if (blocker.listening) blocker.close();
    supervisor.kill('SIGKILL');
  }
});

test('large deletions run in the background and a backup completes while writes continue', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-background-')), backupDir = join(dataDir, 'backups');
  const portal = createPortal({ dataDir, backupDir, origin: 'http://localhost:3100' });
  try {
    portal.db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES('관리자','admin','a@example.test','x','admin',datetime())").run();
    portal.db.exec('CREATE TABLE IF NOT EXISTS load_probe(x)');
    // 백업하는 동안 운영 연결로 계속 기록한다.
    let writing = true, writes = 0;
    const writer = (async () => { while (writing) { portal.db.prepare('INSERT INTO load_probe VALUES(randomblob(4096))').run(); writes++; await new Promise(r => setImmediate(r)); } })();
    const saved = await createBackup(portal.db, backupDir);
    writing = false; await writer;
    assert.ok(writes > 0, 'writes continued during the backup');
    const copy = new DatabaseSync(join(backupDir, saved.name), { readOnly: true });
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    copy.close();
    // 오래된 백업 삭제: 목록에서는 즉시 빠지고 실제 파일은 백그라운드에서 지워진다.
    const old = 'portal-2020-01-01T00-00-00-000Z.sqlite';
    writeFileSync(join(backupDir, old), Buffer.alloc(1024 * 1024));
    assert.deepEqual(pruneExpiredBackups(backupDir), [old]);
    assert.ok(!existsSync(join(backupDir, old)));
    await until(() => readdirSync(backupDir).every(name => !name.includes('.deleting-')), 5000);
    assert.deepEqual(readdirSync(backupDir), [saved.name]);
    // 서버가 꺼져 남은 삭제 대기 파일은 시작할 때 정리한다.
    writeFileSync(join(backupDir, 'portal-2020-01-02T00-00-00-000Z.sqlite.deleting-abcd1234'), 'x');
    cleanBackupFiles(backupDir);
    await until(() => readdirSync(backupDir).length === 1, 5000);
  } finally { portal.db.close(); }
});

test('orphan attachment chunks are found by one table scan and large deletions are purged in the background', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-chunks-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin: 'http://localhost:3100' });
  const db = portal.db;
  const insert = db.prepare('INSERT INTO file_chunks(scope,file_id,seq,bytes) VALUES(?,?,?,?)');
  const chunks = (scope, id) => db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE scope=? AND file_id=?').get(scope, id).n;
  try {
    db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES('관리자','admin','a@example.test','x','admin',datetime())").run();
    const kept = db.prepare("INSERT INTO manuals(folder_id,name,size,bytes,uploaded_by,created_at) VALUES(NULL,'kept.bin',2,x'',1,datetime())").run().lastInsertRowid;
    for (let seq = 0; seq < 2; seq++) insert.run('manuals', kept, seq, Buffer.alloc(1));
    for (let seq = 0; seq < 20; seq++) insert.run('manuals', 900, seq, Buffer.alloc(1)); // 기록 없는 조각(서버가 저장 중 꺼진 경우)
    for (let seq = 0; seq < 3; seq++) insert.run('todo_files', 901, seq, Buffer.alloc(1));
    purgeOrphanChunks(db);
    await until(() => chunks('manuals', 900) === 0 && chunks('todo_files', 901) === 0, 5000);
    assert.equal(chunks('manuals', kept), 2, 'chunks of an existing record are kept');
    // 작은 파일(16조각 이하)은 즉시, 큰 파일은 백그라운드에서 지운다.
    for (let seq = 0; seq < 3; seq++) insert.run('manuals', 902, seq, Buffer.alloc(1));
    deleteUploadChunks(db, 'manuals', 902);
    assert.equal(chunks('manuals', 902), 0);
    for (let seq = 0; seq < 17; seq++) insert.run('manuals', 903, seq, Buffer.alloc(1));
    deleteUploadChunks(db, 'manuals', 903);
    assert.equal(chunks('manuals', 903), 17, 'large deletion is not done synchronously');
    await until(() => chunks('manuals', 903) === 0, 5000);
  } finally { db.close(); }
});
