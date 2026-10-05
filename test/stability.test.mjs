import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPortal } from '../server/app.mjs';
import { latestBackupTime, createBackup } from '../server/backups.mjs';

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
