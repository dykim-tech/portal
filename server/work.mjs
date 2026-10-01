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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(400, '업무 날짜를 확인해 주세요.');
  return value;
};
const statuses = new Set(['planned', 'progress', 'done', 'hold']);
export function initializeWork(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
    work_date TEXT NOT NULL, title TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('planned','progress','done','hold')),
    content TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_logs_customer_date ON work_logs(customer_id,work_date DESC);
  CREATE INDEX IF NOT EXISTS work_logs_date ON work_logs(work_date DESC);`);
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
  const data = body => {
    const c = customer(body.customer_id);
    if (!c.active) throw fail(400, '비활성 고객에는 업무일지를 등록할 수 없습니다.');
    if (!statuses.has(body.status)) throw fail(400, '진행 상태를 확인해 주세요.');
    return {
      customer_id: c.id, work_date: date(body.work_date),
      title: text(body.title, '업무 제목', 150, true),
      owner: text(body.owner, '담당자', 100),
      status: body.status, content: text(body.content, '업무 내용', 10000)
    };
  };
  app.get('/api/customers', (_req, res) => {
    res.json({ customers: db.prepare('SELECT c.*,(SELECT COUNT(*) FROM work_logs w WHERE w.customer_id=c.id) log_count FROM customers c ORDER BY c.name').all() });
  });
  app.post('/api/customers', edit, (req, res) => {
    const name = text(req.body.name, '고객명', 150, true), contact = text(req.body.contact, '연락처', 200), notes = text(req.body.notes, '메모', 2000), stamp = now();
    const result = db.prepare('INSERT INTO customers(name,contact,notes,created_at,updated_at) VALUES(?,?,?,?,?)').run(name, contact, notes, stamp, stamp);
    res.status(201).json({ customer: customer(result.lastInsertRowid) });
  });
  app.put('/api/customers/:id', edit, (req, res) => {
    const c = customer(req.params.id), name = text(req.body.name, '고객명', 150, true), contact = text(req.body.contact, '연락처', 200), notes = text(req.body.notes, '메모', 2000);
    if (typeof req.body.active !== 'boolean') throw fail(400, '사용 여부를 확인해 주세요.');
    db.prepare('UPDATE customers SET name=?,contact=?,notes=?,active=?,updated_at=? WHERE id=?').run(name, contact, notes, Number(req.body.active), now(), c.id);
    res.json({ customer: customer(c.id) });
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
    if (req.query.from) { clauses.push('w.work_date>=?'); params.push(date(req.query.from)); }
    if (req.query.to) { clauses.push('w.work_date<=?'); params.push(date(req.query.to)); }
    const page = id(req.query.page ?? 1), where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const from = `FROM work_logs w JOIN customers c ON c.id=w.customer_id ${where}`;
    res.json({
      logs: db.prepare(`SELECT w.*,c.name customer_name ${from} ORDER BY w.work_date DESC,w.id DESC LIMIT 25 OFFSET ?`).all(...params, (page - 1) * 25),
      total: db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n, page
    });
  });
  app.get('/api/work-logs/:id', (req, res) => res.json({ log: log(req.params.id) }));
  app.post('/api/work-logs', edit, (req, res) => {
    const values = data(req.body), stamp = now();
    const result = db.prepare('INSERT INTO work_logs(customer_id,work_date,title,owner,status,content,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(...Object.values(values), req.user.id, req.user.id, stamp, stamp);
    res.status(201).json({ log: log(result.lastInsertRowid) });
  });
  app.put('/api/work-logs/:id', edit, (req, res) => {
    const original = log(req.params.id), values = data(req.body);
    if (original.version !== Number(req.body.version)) throw fail(409, '다른 사용자가 수정했습니다. 최신 업무일지를 다시 열어 주세요.');
    db.prepare('UPDATE work_logs SET customer_id=?,work_date=?,title=?,owner=?,status=?,content=?,version=version+1,updated_by=?,updated_at=? WHERE id=?')
      .run(...Object.values(values), req.user.id, now(), original.id);
    res.json({ log: log(original.id) });
  });
}
