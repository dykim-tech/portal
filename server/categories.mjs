const fail = (status, message) => Object.assign(new Error(message), { status });
const scopes = new Set(['installations', 'items']);

function scopeOf(value) {
  if (!scopes.has(value)) throw fail(400, '분류 메뉴를 확인해 주세요.');
  return value;
}
function numberId(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw fail(400, '분류를 확인해 주세요.');
  return Number(value);
}
function category(db, scope, value) {
  const row = db.prepare('SELECT * FROM record_categories WHERE id=? AND scope=?').get(numberId(value), scope);
  if (!row) throw fail(404, '분류를 찾을 수 없습니다.');
  return row;
}
export function initializeCategories(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS record_categories (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('installations','items')),
    parent_id INTEGER REFERENCES record_categories(id) ON DELETE RESTRICT,
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS record_categories_unique
    ON record_categories(scope, COALESCE(parent_id, 0), name);
  CREATE INDEX IF NOT EXISTS record_categories_parent ON record_categories(parent_id);`);
  for (const table of ['installations', 'items']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(column => column.name === 'category_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN category_id INTEGER REFERENCES record_categories(id)`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_category ON ${table}(category_id)`);
  }
}
export function categoryInput(db, scope, value) {
  scopeOf(scope);
  if (value == null || value === '') return null; // Existing records can remain uncategorized.
  const row = category(db, scope, value);
  if (row.level !== 3) throw fail(400, '소분류를 선택해 주세요.');
  return row.id;
}
export function categoryDescendants(db, scope, value) {
  scopeOf(scope);
  const selected = category(db, scope, value);
  const all = db.prepare('SELECT id,parent_id FROM record_categories WHERE scope=?').all(scope);
  const ids = [selected.id];
  for (let level = selected.level; level < 3; level++) {
    for (const row of all) if (ids.includes(row.parent_id) && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}
export function registerCategories(app, { db, requireRole }) {
  const edit = requireRole(['admin', 'editor']);
  app.get('/api/categories', (req, res) => {
    const scope = scopeOf(req.query.scope);
    res.json({ categories: db.prepare('SELECT id,scope,parent_id,level,name FROM record_categories WHERE scope=? ORDER BY level,name,id').all(scope) });
  });
  app.post('/api/categories', edit, (req, res) => {
    const scope = scopeOf(req.body.scope);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100 || /[\\/\u0000-\u001f]/.test(name)) throw fail(400, '분류 이름은 1~100자로 입력해 주세요.');
    const parent = req.body.parent_id == null || req.body.parent_id === '' ? null : category(db, scope, req.body.parent_id);
    if (parent?.level === 3) throw fail(400, '분류는 소분류까지 만들 수 있습니다.');
    const level = parent ? parent.level + 1 : 1;
    const result = db.prepare('INSERT INTO record_categories(scope,parent_id,level,name,created_at) VALUES(?,?,?,?,?)')
      .run(scope, parent?.id ?? null, level, name, new Date().toISOString());
    res.status(201).json({ id: Number(result.lastInsertRowid), level });
  });
  app.put('/api/categories/:id', edit, (req, res) => {
    const scope = scopeOf(req.body.scope);
    const row = category(db, scope, req.params.id);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100 || /[\\/\u0000-\u001f]/.test(name)) throw fail(400, '분류 이름은 1~100자로 입력해 주세요.');
    db.prepare('UPDATE record_categories SET name=? WHERE id=?').run(name, row.id);
    res.json({ ok: true });
  });
  app.delete('/api/categories/:id', edit, (req, res) => {
    const scope = scopeOf(req.query.scope);
    const row = category(db, scope, req.params.id);
    if (db.prepare('SELECT id FROM record_categories WHERE parent_id=? LIMIT 1').get(row.id)) throw fail(409, '하위 분류가 있어 삭제할 수 없습니다.');
    if (db.prepare(`SELECT id FROM ${scope} WHERE category_id=? LIMIT 1`).get(row.id)) throw fail(409, '등록된 항목이 있어 삭제할 수 없습니다.');
    db.prepare('DELETE FROM record_categories WHERE id=?').run(row.id);
    res.json({ ok: true });
  });
}
