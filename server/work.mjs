import { listing } from './listing.mjs';
import { transaction } from './db.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const text = (value, label, max = 200, required = false) => {
  if (value != null && typeof value !== 'string') throw fail(400, `${label} 형식을 확인해 주세요.`);
  const result = (value ?? '').trim();
  if ((required && !result) || result.length > max) throw fail(400, `${label} 항목을 확인해 주세요.`);
  return result;
};
const id = value => {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw fail(400, '식별자를 확인해 주세요.');
  return Number(value);
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(400, '업무 날짜를 확인해 주세요.');
  return value;
};
const statuses = new Set(['planned', 'progress', 'done', 'hold']);
const workTypes = new Set(['regular', 'incident', 'installation', 'per_call', 'other']);
const workLogColumns = `
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
    work_date TEXT NOT NULL, title TEXT NOT NULL, work_type TEXT CHECK(work_type IN ('regular','incident','installation','per_call','other')), owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('planned','progress','done','hold')),
    content TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;
export function initializeWork(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_logs (${workLogColumns});
  CREATE INDEX IF NOT EXISTS work_logs_customer_date ON work_logs(customer_id,work_date DESC);
  CREATE INDEX IF NOT EXISTS work_logs_date ON work_logs(work_date DESC);`);
  if (!db.prepare('PRAGMA table_info(work_logs)').all().some(column => column.name === 'work_type')) {
    db.exec("ALTER TABLE work_logs ADD COLUMN work_type TEXT CHECK(work_type IN ('regular','incident','installation','per_call','other'))");
  } else if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_logs'").get().sql.includes("'other'")) {
    transaction(db, () => {
      db.exec(`CREATE TABLE work_logs_updated (${workLogColumns});
        INSERT INTO work_logs_updated(id,customer_id,work_date,title,work_type,owner,status,content,version,created_by,updated_by,created_at,updated_at)
        SELECT id,customer_id,work_date,title,work_type,owner,status,content,version,created_by,updated_by,created_at,updated_at FROM work_logs;
        DROP TABLE work_logs;
        ALTER TABLE work_logs_updated RENAME TO work_logs;
        CREATE INDEX work_logs_customer_date ON work_logs(customer_id,work_date DESC);
        CREATE INDEX work_logs_date ON work_logs(work_date DESC);`);
    });
  }
  // Make existing installation customers available for work logs without changing installations.
  db.prepare("INSERT OR IGNORE INTO customers(name,created_at,updated_at) SELECT DISTINCT TRIM(customer),MIN(created_at),MAX(updated_at) FROM installations WHERE TRIM(customer)!='' GROUP BY TRIM(customer)").run();
}
export function registerWork(app, { db, requireRole }) {
  const edit = requireRole(['admin', 'editor']);
  const customer = value => {
    const row = db.prepare('SELECT * FROM customers WHERE id=?').get(id(value));
    if (!row) throw fail(404, '고객을 찾을 수 없습니다.');
    return row;
  };
  const log = value => {
    const row = db.prepare('SELECT w.*,c.name customer_name FROM work_logs w JOIN customers c ON c.id=w.customer_id WHERE w.id=?').get(id(value));
    if (!row) throw fail(404, '업무일지를 찾을 수 없습니다.');
    return row;
  };
  const data = (body, existingCustomerId = null, existingType = null) => {
    const c = customer(body.customer_id);
    if (!c.active && c.id !== existingCustomerId) throw fail(400, '비활성 고객에는 업무일지를 등록할 수 없습니다.');
    if (!statuses.has(body.status)) throw fail(400, '진행 상태를 확인해 주세요.');
    const workType = body.work_type ?? existingType;
    if (!workTypes.has(workType)) throw fail(400, '업무 유형을 선택해 주세요.');
    return {
      customer_id: c.id, work_date: date(body.work_date),
      title: text(body.title, '업무 제목', 150, true),
      work_type: workType,
      owner: text(body.owner, '담당자', 100),
      status: body.status, content: text(body.content, '업무 내용', 10000)
    };
  };
  app.get('/api/customers', (_req, res) => {
    res.json({ customers: db.prepare('SELECT c.*,(SELECT COUNT(*) FROM work_logs w WHERE w.customer_id=c.id) log_count FROM customers c WHERE c.active=1 ORDER BY c.name').all() });
  });
  app.post('/api/customers', edit, (req, res) => {
    const name = text(req.body.name, '고객명', 150, true), contact = text(req.body.contact, '연락처', 200), notes = text(req.body.notes, '메모', 2000), stamp = now();
    const existing = db.prepare('SELECT id,active FROM customers WHERE name=?').get(name);
    if (existing) {
      if (existing.active) throw fail(409, '이미 등록된 고객입니다.');
      db.prepare('UPDATE customers SET active=1,contact=?,notes=?,updated_at=? WHERE id=?').run(contact, notes, stamp, existing.id);
      return res.json({ customer: customer(existing.id) });
    }
    const result = db.prepare('INSERT INTO customers(name,contact,notes,created_at,updated_at) VALUES(?,?,?,?,?)').run(name, contact, notes, stamp, stamp);
    res.status(201).json({ customer: customer(result.lastInsertRowid) });
  });
  app.put('/api/customers/:id', edit, (req, res) => {
    const c = customer(req.params.id), name = text(req.body.name, '고객명', 150, true), contact = text(req.body.contact, '연락처', 200), notes = text(req.body.notes, '메모', 2000);
    if (typeof req.body.active !== 'boolean') throw fail(400, '사용 여부를 확인해 주세요.');
    db.prepare('UPDATE customers SET name=?,contact=?,notes=?,active=?,updated_at=? WHERE id=?').run(name, contact, notes, Number(req.body.active), now(), c.id);
    res.json({ customer: customer(c.id) });
  });
  app.delete('/api/customers/:id', edit, (req, res) => {
    const c = customer(req.params.id);
    const linked = db.prepare('SELECT id FROM work_logs WHERE customer_id=? LIMIT 1').get(c.id)
      || db.prepare('SELECT id FROM installations WHERE customer=? COLLATE NOCASE LIMIT 1').get(c.name);
    if (linked) db.prepare('UPDATE customers SET active=0,updated_at=? WHERE id=?').run(now(), c.id);
    else db.prepare('DELETE FROM customers WHERE id=?').run(c.id);
    res.json({ ok: true, archived: Boolean(linked) });
  });
  app.get('/api/work-logs', (req, res) => {
    const clauses = [], params = [], q = text(req.query.q, '검색어', 200);
    if (q) {
      const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      clauses.push("(w.title LIKE ? ESCAPE '\\' OR w.content LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR w.owner LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern, pattern);
    }
    if (req.query.customer_id) { clauses.push('w.customer_id=?'); params.push(customer(req.query.customer_id).id); }
    if (req.query.status) {
      if (!statuses.has(req.query.status)) throw fail(400, '진행 상태를 확인해 주세요.');
      clauses.push('w.status=?'); params.push(req.query.status);
    }
    if (req.query.work_type) {
      if (!workTypes.has(req.query.work_type)) throw fail(400, '업무 유형을 확인해 주세요.');
      clauses.push('w.work_type=?'); params.push(req.query.work_type);
    }
    if (req.query.from) { clauses.push('w.work_date>=?'); params.push(date(req.query.from)); }
    if (req.query.to) { clauses.push('w.work_date<=?'); params.push(date(req.query.to)); }
    const list = listing(req.query, {work_date:'w.work_date',customer:'c.name COLLATE NOCASE',title:'w.title COLLATE NOCASE',work_type:'w.work_type',owner:'w.owner COLLATE NOCASE',status:'w.status',updated_at:'w.updated_at'}, 'work_date', 'desc', 'w.id');
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const from = `FROM work_logs w JOIN customers c ON c.id=w.customer_id ${where}`;
    res.json({
      logs: db.prepare(`SELECT w.*,c.name customer_name ${from} ORDER BY ${list.orderBy} LIMIT ? OFFSET ?`).all(...params, list.size, (list.page - 1) * list.size),
      total: db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n, page: list.page, page_size: list.size
    });
  });
  app.get('/api/work-logs/:id', (req, res) => res.json({ log: log(req.params.id) }));
  app.post('/api/work-logs', edit, (req, res) => {
    const values = data(req.body), stamp = now();
    const result = db.prepare('INSERT INTO work_logs(customer_id,work_date,title,work_type,owner,status,content,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(...Object.values(values), req.user.id, req.user.id, stamp, stamp);
    res.status(201).json({ log: log(result.lastInsertRowid) });
  });
  app.put('/api/work-logs/:id', edit, (req, res) => {
    const original = log(req.params.id), values = data(req.body, original.customer_id, original.work_type);
    if (original.version !== Number(req.body.version)) throw fail(409, '다른 사용자가 수정했습니다. 최신 업무일지를 다시 열어 주세요.');
    db.prepare('UPDATE work_logs SET customer_id=?,work_date=?,title=?,work_type=?,owner=?,status=?,content=?,version=version+1,updated_by=?,updated_at=? WHERE id=?')
      .run(...Object.values(values), req.user.id, now(), original.id);
    res.json({ log: log(original.id) });
  });
  app.delete('/api/work-logs/:id', edit, (req, res) => {
    const row = log(req.params.id);
    db.prepare('DELETE FROM work_logs WHERE id=?').run(row.id);
    res.json({ ok: true });
  });
}
