import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('APP_ORIGIN accepts several comma-separated addresses', async () => {
  const portal = createPortal({ dataDir: mkdtempSync(join(tmpdir(), 'portal-origins-')), origin: 'https://203.0.113.10, https://192.168.0.20', selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = async origin => (await fetch(base + '/api/auth/setup', { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).json();
  try {
    assert.match((await setup('https://evil.example')).error, /요청 출처/);
    assert.doesNotMatch((await setup('https://203.0.113.10')).error, /요청 출처/);
    assert.doesNotMatch((await setup('https://192.168.0.20')).error, /요청 출처/);
    assert.ok(readFileSync(portal.tokenPath, 'utf8'));
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
