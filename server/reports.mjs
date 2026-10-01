const fail = (status, message) => Object.assign(new Error(message), { status });
const date = value => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(400, '조회 날짜를 확인해 주세요.');
  return value;
};
function range(query) {
  const from = date(query.from), to = date(query.to);
  if (from && to && from > to) throw fail(400, '종료일은 시작일 이후로 설정해 주세요.');
  return { from, to };
}
function predicate(column, { from, to }) {
  const clauses = [], args = [];
  if (from) { clauses.push(`${column}>=?`); args.push(from); }
  if (to) { clauses.push(`${column}<=?`); args.push(to); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args };
}
function paths(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const result = new Map();
  for (const row of rows) {
    const parts = [row.name];
    let parent = row.parent_id ? byId.get(row.parent_id) : null;
    while (parent) { parts.unshift(parent.name); parent = parent.parent_id ? byId.get(parent.parent_id) : null; }
    result.set(row.id, parts.join(' / '));
  }
  return result;
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function csvRow(values) { return values.map(csvCell).join(',') + '\r\n'; }
export function registerReports(app, { db }) {
  app.get('/api/reports', (req, res) => {
    const dates = range(req.query);
    const installations = predicate('installed_on', dates);
    const items = predicate("date(updated_at,'+9 hours')", dates);
    const manuals = predicate("date(created_at,'+9 hours')", dates);
    const work = predicate('work_date', dates);
    const count = (table, p) => db.prepare(`SELECT COUNT(*) n FROM ${table} ${p.where}`).get(...p.args).n;
    const group = (table, field, p) => db.prepare(`SELECT ${field} value,COUNT(*) count FROM ${table} ${p.where} GROUP BY ${field} ORDER BY count DESC,value`).all(...p.args);
    res.json({
      range: dates,
      counts: {
        installations: count('installations', installations),
        items: count('items', items),
        manuals: count('manuals', manuals),
        work_logs: count('work_logs', work),
        customers: db.prepare('SELECT COUNT(*) n FROM customers WHERE active=1').get().n
      },
      statuses: {
        installations: group('installations', 'status', installations),
        items: group('items', 'status', items),
        work_logs: group('work_logs', 'status', work)
      },
      categories: {
        installations: group('installations', 'category_id', installations),
        items: group('items', 'category_id', items),
        manuals: group('manuals', 'folder_id', manuals)
      },
      customers: db.prepare(`SELECT c.name value,COUNT(*) count FROM work_logs w JOIN customers c ON c.id=w.customer_id ${predicate('w.work_date', dates).where} GROUP BY c.id ORDER BY count DESC,c.name LIMIT 20`).all(...work.args),
      categoryTree: db.prepare('SELECT id,scope,parent_id,name FROM record_categories').all(),
      folderTree: db.prepare('SELECT id,parent_id,name FROM folders').all()
    });
  });
  app.get('/api/reports/:kind.csv', (req, res) => {
    const kind = req.params.kind, dates = range(req.query);
    const categoryPaths = paths(db.prepare('SELECT id,parent_id,name FROM record_categories').all());
    const folderPaths = paths(db.prepare('SELECT id,parent_id,name FROM folders').all());
    let header, sql, args, project;
    let sequence = 0;
    if (kind === 'installations') {
      const p = predicate('i.installed_on', dates);
      header = ['구분','고객사','제품명','세부내용','수량','설치시작일','설치종료일','담당자','설치엔지니어','비고','대분류 / 중분류 / 소분류','상태','첨부자료 수'];
      sql = `SELECT i.*,(SELECT COUNT(*) FROM installation_files f WHERE f.installation_id=i.id) file_count FROM installations i ${p.where} ORDER BY i.installed_on DESC,i.id DESC`;
      args = p.args;
      project = row => [++sequence,row.customer,row.name,row.product_version,row.quantity,row.installed_on,row.completed_on,row.contact,row.engineer,row.notes,categoryPaths.get(row.category_id) ?? '미분류',row.status,row.file_count];
    } else if (kind === 'items') {
      const p = predicate("date(i.updated_at,'+9 hours')", dates);
      header = ['최근 수정','대분류 / 중분류 / 소분류','유형','자산명','관리번호','상태','수량','위치','담당자','시리얼','관리 기한','설명','첨부자료 수'];
      sql = `SELECT i.*,(SELECT COUNT(*) FROM files f WHERE f.item_id=i.id) file_count FROM items i ${p.where} ORDER BY i.updated_at DESC,i.id DESC`;
      args = p.args;
      project = row => [row.updated_at,categoryPaths.get(row.category_id) ?? '미분류',row.category,row.name,row.asset_code,row.status,row.quantity,row.location,row.owner,row.serial,row.due_date,row.description,row.file_count];
    } else if (kind === 'manuals') {
      const p = predicate("date(m.created_at,'+9 hours')", dates);
      header = ['등록일','대분류 / 중분류 / 소분류','파일명','크기(byte)','등록자'];
      sql = `SELECT m.id,m.folder_id,m.name,m.size,m.created_at,u.name uploader FROM manuals m JOIN users u ON u.id=m.uploaded_by ${p.where} ORDER BY m.created_at DESC,m.id DESC`;
      args = p.args;
      project = row => [row.created_at,folderPaths.get(row.folder_id) ?? '미분류',row.name,row.size,row.uploader];
    } else if (kind === 'work-logs') {
      const p = predicate('w.work_date', dates);
      header = ['업무일','고객','제목','담당자','상태','업무 내용','최근 수정'];
      sql = `SELECT w.*,c.name customer_name FROM work_logs w JOIN customers c ON c.id=w.customer_id ${p.where} ORDER BY w.work_date DESC,w.id DESC`;
      args = p.args;
      project = row => [row.work_date,row.customer_name,row.title,row.owner,row.status,row.content,row.updated_at];
    } else throw fail(404, '리포트 종류를 찾을 수 없습니다.');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-report.csv"`,
      'Cache-Control': 'no-store'
    });
    res.write('\uFEFF' + csvRow(header));
    for (const row of db.prepare(sql).iterate(...args)) res.write(csvRow(project(row)));
    res.end();
  });
}
