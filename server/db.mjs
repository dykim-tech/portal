import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'portal.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      category TEXT NOT NULL CHECK(category IN ('general','it')), status TEXT NOT NULL,
      quantity INTEGER NOT NULL, location TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
      serial TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', due_date TEXT,
      reminder_days INTEGER NOT NULL DEFAULT 7, version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      due_date TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
      read_at TEXT, UNIQUE(user_id, item_id, due_date, kind)
    );
    CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at);
    PRAGMA user_version=1;
  `);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function koreaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function scanDeadlines(db, now = new Date()) {
  const today = koreaDate(now);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const items = db.prepare("SELECT * FROM items WHERE due_date IS NOT NULL AND status != 'retired'").all();
  const users = db.prepare('SELECT id FROM users WHERE active=1').all();
  const insert = db.prepare('INSERT OR IGNORE INTO notifications(user_id,item_id,due_date,kind,title,created_at) VALUES(?,?,?,?,?,?)');
  transaction(db, () => {
    for (const item of items) {
      const days = Math.round((Date.parse(item.due_date + 'T00:00:00Z') - todayMs) / 86400000);
      if (days > item.reminder_days) continue;
      const kind = days < 0 ? 'overdue' : days === 0 ? 'today' : 'upcoming';
      const label = days < 0 ? '기한 경과' : days === 0 ? '오늘 기한' : '기한 예정';
      for (const user of users) insert.run(user.id, item.id, item.due_date, kind, `${item.name} · ${label} (${item.due_date})`, now.toISOString());
    }
  });
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now.getTime());
  db.prepare('DELETE FROM login_attempts WHERE reset_at < ?').run(now.getTime());
}
