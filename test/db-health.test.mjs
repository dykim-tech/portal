import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseMonitor, freshConnectionWorks } from '../server/db-health.mjs';

const ioError = () => Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
const quiet = { error() {} };
const broken = () => ({ prepare() { return { get() { throw ioError(); } }; } });
const healthy = () => ({ prepare() { return { get: () => ({ id: 1 }) }; } });

test('a broken connection restarts at once when the database file itself is fine', () => {
  const exits = [];
  const monitor = createDatabaseMonitor({ db: broken, path: 'x', supervised: () => true, exit: code => exits.push(code), probe: () => true, log: quiet });
  monitor.check();
  assert.deepEqual(exits, [75]);
  monitor.stop();
});

test('an unavailable drive is rechecked quickly and restarts after three failures', async () => {
  const exits = [];
  const monitor = createDatabaseMonitor({ db: broken, path: 'x', supervised: () => true, exit: code => exits.push(code), probe: () => false, recheckMs: 10, log: quiet });
  monitor.check();
  assert.deepEqual(exits, []);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(exits, [75]);
  assert.equal(monitor.failures(), 3);
  monitor.stop();
});

test('recovery resets the count; unsupervised runs only log; other errors are ignored', async () => {
  let current = broken;
  const exits = [];
  const monitor = createDatabaseMonitor({ db: () => current(), path: 'x', supervised: () => true, exit: code => exits.push(code), probe: () => false, recheckMs: 10, log: quiet });
  monitor.check();
  current = healthy;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(monitor.failures(), 0); assert.deepEqual(exits, []);
  monitor.report(new Error('UNIQUE constraint failed'));
  assert.equal(monitor.failures(), 0);
  monitor.stop();
  const alone = createDatabaseMonitor({ db: broken, path: 'x', supervised: () => false, exit: code => exits.push(code), probe: () => true, log: quiet });
  alone.check(); alone.report(ioError());
  assert.deepEqual(exits, []); assert.equal(alone.failures(), 1, 'request-path reports are throttled to one check per 5 seconds');
  alone.stop();
});

test('fresh connection probe opens the real file read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-health-')), path = join(dir, 'portal.sqlite');
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)');
  assert.equal(freshConnectionWorks(path), true);
  db.close();
  assert.equal(freshConnectionWorks(join(dir, 'missing', 'portal.sqlite')), false);
});
