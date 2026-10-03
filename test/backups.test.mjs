import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPortal } from '../server/app.mjs';
import { backupPath, createBackup, listBackups, restoreDatabaseFile, verifyRestoreCandidate } from '../server/backups.mjs';

test('admin can create, list and download backups; restore requires explicit selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portal-backup-api-'));
  const dataDir = join(root, 'data'), backupDir = join(root, 'backups'), origin = 'http://localhost:3104';
  let requested;
  const portal = createPortal({ dataDir, backupDir, origin, onRestore: async selection => { requested = selection; } });
  const server = portal.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, method = 'GET', body, session = cookie) {
    const response = await fetch(base + '/api' + path, {
      method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
  }
  try {
    assert.equal((await request('/backups', 'GET', undefined, '')).status, 401);
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' });
    cookie = setup.headers.get('set-cookie').split(';')[0];
    const created = await request('/backups', 'POST', {});
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.match(created.data.backup.name, /^portal-.*\.sqlite$/);
    assert.equal((await request('/backups')).data.backups.length, 1);
    const download = await request('/backups/' + created.data.backup.name + '/download');
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(download.data).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await request('/backups/not-a-backup.sqlite/download')).status, 400);
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' });
    const viewer = await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' });
    const viewerCookie = viewer.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/backups', 'GET', undefined, viewerCookie)).status, 403);
    assert.equal((await request('/backups', 'POST', {}, viewerCookie)).status, 403);
    assert.equal((await request('/backups/' + created.data.backup.name + '/download', 'GET', undefined, viewerCookie)).status, 403);
    assert.equal((await request('/backups/' + created.data.backup.name + '/restore', 'POST', { confirm: 'wrong' })).status, 400);
    const restore = await request('/backups/' + created.data.backup.name + '/restore', 'POST', { confirm: created.data.backup.name });
    assert.equal(restore.status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested.path, backupPath(backupDir, created.data.backup.name));
    assert.equal(requested.restoreId, restore.data.restore_id);
    assert.equal((await request('/auth/me')).status, 503);
    assert.equal((await request('/health')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('selected backup restores its earlier data while the previous database is retained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portal-backup-restore-'));
  const dataDir = join(root, 'data'), backupDir = join(root, 'backups');
  let portal = createPortal({ dataDir, backupDir });
  try {
    portal.db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES('관리자','admin','admin@example.test','unused','admin','2026-01-01')").run();
    portal.db.prepare("INSERT INTO customers(name,created_at,updated_at) VALUES('백업 당시','2026-01-01','2026-01-01')").run();
    const saved = await createBackup(portal.db, backupDir);
    portal.db.prepare("INSERT INTO customers(name,created_at,updated_at) VALUES('백업 이후','2026-01-02','2026-01-02')").run();
    assert.equal(portal.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
    portal.db.close();
    const previous = restoreDatabaseFile(dataDir, backupPath(backupDir, saved.name));
    portal = createPortal({ dataDir, backupDir });
    assert.equal(portal.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
    assert.equal(portal.db.prepare("SELECT name FROM customers").get().name, '백업 당시');
    assert.equal(portal.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(listBackups(backupDir).length, 1);
    portal.db.close();
    const prior = new DatabaseSync(previous, { readOnly: true });
    assert.equal(prior.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
    prior.close();
  } finally {
    try { portal.db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete backups are rejected even when the older tables are present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portal-backup-invalid-'));
  const dataDir = join(root, 'data'), backupDir = join(root, 'backups');
  const portal = createPortal({ dataDir, backupDir });
  try {
    portal.db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES('관리자','admin','admin@example.test','unused','admin','2026-01-01')").run();
    const saved = await createBackup(portal.db, backupDir);
    const damaged = join(backupDir, 'portal-incomplete.sqlite');
    copyFileSync(backupPath(backupDir, saved.name), damaged);
    const db = new DatabaseSync(damaged);
    db.exec('DROP TABLE work_logs; DROP TABLE customers; DROP TABLE manuals;');
    db.close();
    assert.throws(() => verifyRestoreCandidate(damaged), /지원되지 않는 백업 형식/);
  } finally {
    portal.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
