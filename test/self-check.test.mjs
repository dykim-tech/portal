import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfCheck, currentCommit } from '../server/self-check.mjs';
import { createPortal } from '../server/app.mjs';

test('self-check records results in the log and runs once per code version', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-selfcheck-'));
  const ok = async () => ({ key: 'syntax', name: '문법 검사', status: 'ok', summary: '정상', ms: 1, output: '' });
  const bad = async () => ({ key: 'test', name: '자동 테스트', status: 'fail', summary: '1개 실패', ms: 1, output: 'not ok 1 - sample' });
  const check = createSelfCheck({ dataDir, steps: [ok, bad] });
  const running = check.start('수동 실행');
  assert.equal(running.status, 'running');
  assert.equal(check.start('수동 실행'), running, 'a second start while running returns the same run');
  await check.wait();
  const [log] = check.logs();
  assert.equal(log.status, 'fail');
  assert.deepEqual(log.steps.map(step => step.status), ['ok', 'fail']);
  assert.equal(log.steps[1].output, 'not ok 1 - sample');
  assert.equal(check.status(), null);

  // 같은 코드(커밋)는 다시 자동 실행하지 않는다.
  const before = check.logs().length;
  const ran = check.runIfCodeChanged();
  if (currentCommit()) assert.equal(ran, false); await check.wait();
  assert.equal(check.logs().length, before);

  // 50회까지만 보관
  const quick = createSelfCheck({ dataDir, steps: [ok] });
  for (let i = 0; i < 55; i++) { quick.start('반복'); await quick.wait(); }
  assert.equal(quick.logs().length, 50);
  assert.equal(readFileSync(join(dataDir, 'check-log.jsonl'), 'utf8').trim().split('\n').length, 50);
});

test('commit detection reads the git HEAD reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-git-'));
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'abcdef1234567890\n');
  assert.equal(currentCommit(dir), 'abcdef1');
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), '');
  assert.equal(currentCommit(join(dir, 'missing')), null);
});

test('check log API is admin-only', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-checkapi-'));
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, cookie = '') => fetch(base + '/api' + path, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/auth/setup', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'a@example.test', password: 'test-password-1234' })).status, 201);
    const admin = (await post('/auth/login', { username: 'admin', password: 'test-password-1234' })).headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/users', { name: '편집자', username: 'editor', email: 'e@example.test', role: 'editor', password: 'test-password-1234' }, admin)).status, 201);
    const editor = (await post('/auth/login', { username: 'editor', password: 'test-password-1234' })).headers.get('set-cookie').split(';')[0];
    const listed = await (await fetch(base + '/api/operations/checks', { headers: { Cookie: admin } })).json();
    assert.deepEqual(listed, { running: null, logs: [] });
    assert.equal((await fetch(base + '/api/operations/checks', { headers: { Cookie: editor } })).status, 403);
    assert.equal((await post('/operations/checks', {}, editor)).status, 403);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
