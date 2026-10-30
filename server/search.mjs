// 통합 검색(2026-10-28, 포털형 첫 화면 검색창): 포털에 저장된 모든 기록의 제목·내용·첨부 파일 이름을 한 번에 찾는다.
// 검색어를 띄어쓰기로 나누어 모든 낱말이 들어 있는 항목만 고른다(대소문자 무시, LIKE). 첨부 파일 '내용'은 찾지 않는다.
// TO-DO·달력 일정은 로그인한 사용자 본인 것만, 잠긴 메모는 잠금 제목으로만 찾는다. 분류마다 최대 limit건과 전체 건수를 돌려준다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const like = term => '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%';
const joinText = columns => columns.map(c => `coalesce(${c},'')`).join(" || ' ' || ");

// [분류 id, 이름, 이동할 화면, FROM 절, 찾을 열 목록, 고를 열, 정렬, 본인 것만(열 이름)]
const sources = [
  ['drafts', '업무기안', 'drafts', 'drafts d', ['d.title', 'd.doc_no', 'd.drafter', 'd.content', 'd.approver_email', 'd.cc_emails'],
    "d.id, d.title, d.content AS body, coalesce(d.doc_no,'') || ' · ' || d.draft_date AS sub", 'd.draft_date DESC, d.id DESC'],
  ['meetings', '회의록', 'meetings', 'meetings m', ['m.title', 'm.location', 'm.attendees', 'm.content', 'm.decisions', "(SELECT group_concat(task || ' ' || owner, ' ') FROM meeting_actions a WHERE a.meeting_id=m.id)"],
    "m.id, m.title, m.content || ' ' || m.decisions AS body, m.meeting_date || CASE WHEN m.location<>'' THEN ' · ' || m.location ELSE '' END AS sub", 'm.meeting_date DESC, m.id DESC'],
  ['work', '업무일지', 'work', 'work_logs w JOIN customers c ON c.id=w.customer_id', ['w.title', 'w.content', 'w.owner', 'c.name'],
    "w.id, w.title, w.content AS body, c.name || ' · ' || w.work_date AS sub", 'w.work_date DESC, w.id DESC'],
  ['customers', '고객', 'work', 'customers c', ['c.name', 'c.contact', 'c.notes'],
    "c.id, c.name AS title, c.notes AS body, c.contact AS sub", 'c.name'],
  ['installations', '설치관리', 'installations', 'installations i', ['i.name', 'i.customer', 'i.location', 'i.contact', 'i.engineer', 'i.product_version', 'i.notes'],
    "i.id, i.name AS title, i.notes AS body, i.customer || ' · ' || i.installed_on AS sub", 'i.installed_on DESC, i.id DESC'],
  ['projects', '프로젝트', 'projects', 'projects p', ['p.name', 'p.customer', 'p.owner', 'p.location', 'p.notes', "(SELECT group_concat(title, ' ') FROM project_tasks t WHERE t.project_id=p.id)"],
    "p.id, p.name AS title, p.notes AS body, p.customer || CASE WHEN p.owner<>'' THEN ' · ' || p.owner ELSE '' END AS sub", 'p.id DESC'],
  ['items', '자산', 'items', 'items it', ['it.name', 'it.asset_code', 'it.location', 'it.owner', 'it.serial', 'it.description'],
    "it.id, it.name AS title, it.description AS body, it.asset_code || CASE WHEN it.location<>'' THEN ' · ' || it.location ELSE '' END AS sub", 'it.updated_at DESC'],
  // 잠긴 메모는 내용 대신 잠금 제목만 찾고 보여 준다.
  ['todos', 'TO-DO', 'todos', 'todos td', ["CASE WHEN td.lock_hash IS NULL THEN td.title || ' ' || td.body ELSE td.lock_title END"],
    "td.id, CASE WHEN td.lock_hash IS NULL THEN coalesce(nullif(td.title,''), substr(trim(td.body),1,60)) ELSE '🔒 ' || td.lock_title END AS title, CASE WHEN td.lock_hash IS NULL THEN td.body ELSE '' END AS body, td.target_date || CASE WHEN td.done=1 THEN ' · 완료' ELSE '' END || CASE WHEN td.lock_hash IS NULL THEN '' ELSE ' · 잠김' END AS sub", 'td.target_date DESC, td.id DESC', 'td.user_id'],
  ['events', '달력 일정', 'dashboard', 'calendar_events ev', ['ev.title'],
    "ev.id, ev.title, '' AS body, ev.event_date || CASE WHEN ev.event_time<>'' THEN ' ' || ev.event_time ELSE '' END AS sub, ev.event_date AS date", 'ev.event_date DESC, ev.event_time DESC', 'ev.user_id'],
  ['folders', '자료 폴더', 'library', 'folders f', ['f.name'],
    "f.id, f.name AS title, '' AS body, coalesce((SELECT name FROM folders p WHERE p.id=f.parent_id),'최상위') AS sub, f.id AS folder_id", 'f.name'],
  ['manuals', '자료 파일', 'library', 'manuals mf', ['mf.name'],
    "mf.id, mf.name AS title, '' AS body, coalesce((SELECT name FROM folders p WHERE p.id=mf.folder_id),'최상위') AS sub, mf.folder_id, mf.preview_type", 'mf.created_at DESC'],
  ['links', '자료 링크', 'library', 'library_links l', ['l.name', 'l.url'],
    "l.id, l.name AS title, '' AS body, l.url AS sub, l.folder_id, l.url", 'l.created_at DESC'],
];

// 첨부 파일 이름: 붙어 있는 기록(부모)을 열도록 부모 분류와 id를 함께 돌려준다.
const attachments = [
  ['draft_files', 'draft_id', 'drafts', 'drafts', 'title'],
  ['meeting_files', 'meeting_id', 'meetings', 'meetings', 'title'],
  ['installation_files', 'installation_id', 'installations', 'installations', 'name'],
  ['customer_files', 'customer_id', 'customers', 'customers', 'name'],
  ['files', 'item_id', 'items', 'items', 'name'],
  ['todo_files', 'todo_id', 'todos', 'todos', 'title', 'user_id', 'lock_hash IS NULL'],
];

export function parseQuery(value) {
  const q = String(value ?? '').trim();
  if (!q) throw fail(400, '검색어를 입력해 주세요.');
  if (q.length > 100) throw fail(400, '검색어는 100자 이내로 입력해 주세요.');
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 5);
  return { q, terms };
}

// 내용에서 첫 검색어 앞뒤를 잘라 보여 준다.
export function snippet(body, terms, width = 60) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const at = terms.map(t => lower.indexOf(t.toLowerCase())).filter(i => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return '';
  const start = Math.max(0, at - width), end = Math.min(text.length, at + width);
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function registerSearch(app, { db }) {
  const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  app.get('/api/search', (req, res) => {
    const { q, terms } = parseQuery(req.query.q);
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 30);
    const groups = [];
    for (const [id, label, view, from, columns, select, order, ownerColumn, extra] of sources) {
      const table = from.split(' ')[0];
      if (!has(table)) continue;
      const where = terms.map(() => `(${joinText(columns)}) LIKE ? ESCAPE '\\'`);
      const params = terms.map(like);
      if (ownerColumn) { where.push(`${ownerColumn}=?`); params.push(req.user.id); }
      if (extra) where.push(extra);
      const sql = `FROM ${from} WHERE ${where.join(' AND ')}`;
      const total = db.prepare(`SELECT count(*) AS n ${sql}`).get(...params).n;
      if (!total) continue;
      const rows = db.prepare(`SELECT ${select} ${sql} ORDER BY ${order} LIMIT ?`).all(...params, limit);
      groups.push({ id, label, view, total, rows: rows.map(({ body, ...row }) => ({ ...row, snippet: snippet(body, terms) })) });
    }
    const files = [];
    for (const [table, key, kind, parent, parentTitle, ownerColumn, extra] of attachments) {
      if (!has(table)) continue;
      const where = terms.map(() => "f.name LIKE ? ESCAPE '\\'"), params = terms.map(like);
      if (ownerColumn) { where.push(`p.${ownerColumn}=?`); params.push(req.user.id); }
      if (extra) where.push(`p.${extra}`);
      files.push(...db.prepare(`SELECT f.id, f.name AS title, f.${key} AS parent_id, p.${parentTitle} AS parent_title, f.created_at FROM ${table} f JOIN ${parent} p ON p.id=f.${key} WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT ?`).all(...params, limit)
        .map(row => ({ ...row, kind })));
    }
    if (files.length) {
      files.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      groups.push({ id: 'attachments', label: '첨부 파일', view: null, total: files.length, rows: files.slice(0, limit).map(({ created_at, ...row }) => ({ ...row, sub: row.parent_title })) });
    }
    res.json({ q, terms, total: groups.reduce((sum, g) => sum + g.total, 0), groups });
  });
}
