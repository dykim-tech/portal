import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('a running portal restores a selected backup and reconnects', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'portal-restore-process-'));
  const dataDir = join(root, 'data'), backupDir = join(root, 'backups');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolveClose => probe.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: resolve('.'), env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  async function health(previous) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(origin + '/api/health');
        if (response.ok) {
          const status = await response.json();
          if (!previous || status.instance_id !== previous) return status;
        }
      } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 150));
    }
    throw new Error('Portal did not reconnect: ' + output);
  }
  let cookie = '';
  async function request(path, method = 'GET', body) {
    const response = await fetch(origin + '/api' + path, {
      method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  try {
    const before = await health();
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(join(dataDir, 'setup-token.txt'), 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' });
    assert.equal(setup.status, 201, JSON.stringify(setup.data));
    cookie = setup.headers.get('set-cookie').split(';')[0];
    const saved = await request('/backups', 'POST', {});
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal((await request('/customers', 'POST', { name: '복구 후 없어질 고객' })).status, 201);
    const restored = await request('/backups/' + saved.data.backup.name + '/restore', 'POST', { confirm: saved.data.backup.name });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const after = await health(before.instance_id);
    assert.deepEqual(after.restore_result, { id: restored.data.restore_id, ok: true });
    assert.equal((await request('/customers')).data.customers.length, 0);
    assert.equal((await request('/backups')).data.backups.length, 2);
    const legacyName = 'portal-legacy-test.sqlite';
    const legacyPath = join(backupDir, legacyName);
    copyFileSync(join(backupDir, saved.data.backup.name), legacyPath);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('DROP TABLE work_logs; DROP TABLE customers;');
    legacy.close();
    const originalHash = createHash('sha256').update(readFileSync(legacyPath)).digest('hex');
    const legacyRestore = await request('/backups/' + legacyName + '/restore', 'POST', { confirm: legacyName });
    assert.equal(legacyRestore.status, 200, JSON.stringify(legacyRestore.data));
    const afterLegacy = await health(after.instance_id);
    assert.deepEqual(afterLegacy.restore_result, { id: legacyRestore.data.restore_id, ok: true });
    assert.equal((await request('/customers')).data.customers.length, 0);
    assert.equal(createHash('sha256').update(readFileSync(legacyPath)).digest('hex'), originalHash);
    // 같은 날 백업이 4건(일반·복구 직전 2건·이전 형식)이 되었으므로 하루 3건 제한으로 가장 오래된 일반 백업이 정리된다.
    const remaining = (await request('/backups')).data.backups.map(row => row.name);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.includes(legacyName) && !remaining.includes(saved.data.backup.name));
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise(resolveWait => setTimeout(resolveWait, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
