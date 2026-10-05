import { koreaDate } from './db.mjs';

const views = {
  installations: '설치관리', library: '자료 관리', items: '자산 관리',
  work: '업무관리', reports: '리포트', users: '사용자 관리', backups: '백업/복구'
};
const resourceViews = {
  installations: 'installations', 'installation-files': 'installations',
  folders: 'library', manuals: 'library', 'library-links': 'library', items: 'items', files: 'items',
  customers: 'work', 'work-logs': 'work', users: 'users', backups: 'backups'
};
const blankFields = {
  installations: { product_version: '세부내용', engineer: '설치엔지니어' },
  items: { location: '보관 위치', owner: '담당자' },
  'work-logs': { owner: '담당자', content: '업무 내용' }
};

export function initializeActivity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('change','missing','monthly')),
    title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', entity_id INTEGER,
    event_key TEXT UNIQUE, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_events_created ON activity_events(created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS activity_reads (
    event_id INTEGER NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id)
  );`);
}

export function recordActivity(db, { scope, action, kind = 'change', title, detail = '', entityId = null, key = null }, at = new Date()) {
  if (!views[scope]) throw new Error('Unknown activity scope');
  db.prepare('INSERT OR IGNORE INTO activity_events(scope,action,kind,title,detail,entity_id,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(scope, action, kind, String(title).slice(0, 240), String(detail).slice(0, 2000), entityId, key, at.toISOString());
}

function changedResource(req) {
  const [resource, second, third] = req.path.split('/').filter(Boolean);
  if (req.method === 'POST' && resource === 'auth' && second === 'password') return { scope: 'users', resource: 'password' };
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return null;
  if (resource === 'backups') return req.method === 'POST' && !third ? { scope: 'backups', resource } : null;
  if (resource === 'categories') return { scope: req.body?.scope === 'installations' || req.query.scope === 'installations' ? 'installations' : 'items', resource };
  if (!resourceViews[resource]) return null;
  return { scope: resourceViews[resource], resource };
}

export function recordMutation(db, req, body) {
  const changed = changedResource(req);
  if (!changed) return;
  const { scope, resource } = changed;
  const row = body?.installation ?? body?.item ?? body?.log ?? body?.customer ?? body?.user ?? body?.folder ?? body?.file ?? body?.link ?? body?.backup;
  const entityId = Number(row?.id ?? body?.id ?? req.params?.id) || null;
  const subject = row?.name ?? row?.title ?? row?.customer ?? req.body?.name ?? req.body?.title ?? req.file?.originalname ?? (entityId ? `#${entityId}` : views[scope]);
  const action = resource === 'password' ? '비밀번호 변경' : req.method === 'POST' ? '등록' : req.method === 'PUT' ? '수정' : '삭제';
  const noun = resource === 'password' ? '사용자' : resource === 'categories' ? '분류' :
    ['installation-files', 'files'].includes(resource) ? '첨부자료' : resource === 'folders' ? '폴더' :
    resource === 'manuals' ? '자료' : resource === 'library-links' ? '링크' : resource === 'work-logs' ? '업무일지' : resource === 'customers' ? '고객' :
    resource === 'users' ? '사용자' : resource === 'backups' ? '백업' : scope === 'items' ? '자산' : '설치 정보';
  recordActivity(db, { scope, action: req.method === 'POST' ? 'create' : req.method === 'PUT' ? 'update' : 'delete',
    title: `${views[scope]} · ${noun} ${action}`, detail: `${String(subject).slice(0, 180)} · ${req.user?.name ?? '시스템'}`, entityId });
  const fields = blankFields[resource];
  if (!fields || req.method === 'DELETE' || !row) return;
  const missing = Object.entries(fields).filter(([field]) => row[field] == null || String(row[field]).trim() === '').map(([, label]) => label);
  if (missing.length) recordActivity(db, { scope, action: 'missing', kind: 'missing',
    title: `${views[scope]} · 핵심 정보 누락`, detail: `${String(subject).slice(0, 150)}: ${missing.join(', ')}`,
    entityId, key: `missing:${resource}:${entityId}:${row.version ?? 1}` });
}

export function scanMissing(db, at = new Date()) {
  const day = koreaDate(at);
  const checks = [
    ['installations', 'installations', "trim(product_version)='' OR trim(engineer)=''", 'customer'],
    ['items', 'items', "trim(location)='' OR trim(owner)=''", 'name'],
    ['work', 'work_logs', "trim(owner)='' OR trim(content)=''", 'title']
  ];
  for (const [scope, table, predicate, name] of checks) {
    const count = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${predicate}`).get().n;
    if (!count) continue;
    const examples = db.prepare(`SELECT ${name} label FROM ${table} WHERE ${predicate} ORDER BY id DESC LIMIT 5`).all().map(row => row.label);
    recordActivity(db, { scope, action: 'missing', kind: 'missing', title: `${views[scope]} · 핵심 정보 누락 ${count}건`,
      detail: examples.join(', '), key: `missing-digest:${day}:${scope}` }, at);
  }
}

export function scanMonthly(db, at = new Date()) {
  const today = koreaDate(at), [year, month] = today.split('-').map(Number);
  const to = `${year}-${String(month).padStart(2, '0')}-01`;
  const from = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const period = from.slice(0, 7), label = `${Number(from.slice(5, 7))}월`;
  const registration = [
    ['installations', 'installations', 'installed_on', 'customer'],
    ['library', 'manuals', "date(created_at,'+9 hours')", 'name'],
    ['items', 'items', "date(created_at,'+9 hours')", 'name'],
    ['work', 'work_logs', 'work_date', 'title']
  ];
  const counts = {};
  for (const [scope, table, column, name] of registration) {
    const count = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}>=? AND ${column}<?`).get(from, to).n;
    const examples = db.prepare(`SELECT DISTINCT ${name} label FROM ${table} WHERE ${column}>=? AND ${column}<? ORDER BY id DESC LIMIT 6`).all(from, to).map(row => row.label);
    counts[scope] = count;
    recordActivity(db, { scope, action: 'monthly', kind: 'monthly', title: `${label} ${views[scope]} ${count}건`,
      detail: examples.length ? examples.join(', ') : '해당 기간 등록 내역 없음', key: `monthly:${period}:${scope}` }, at);
  }
  for (const scope of ['backups', 'users']) {
    const count = db.prepare("SELECT COUNT(*) n FROM activity_events WHERE scope=? AND action='create' AND date(created_at,'+9 hours')>=? AND date(created_at,'+9 hours')<?").get(scope, from, to).n;
    counts[scope] = count;
    recordActivity(db, { scope, action: 'monthly', kind: 'monthly', title: `${label} ${views[scope]} 등록 ${count}건`,
      detail: '포털 알림 기록 기준', key: `monthly:${period}:${scope}` }, at);
  }
  recordActivity(db, { scope: 'reports', action: 'monthly', kind: 'monthly',
    title: `${label} 리포트 집계 완료`, detail: `설치 ${counts.installations}건 · 자료 ${counts.library}건 · 자산 ${counts.items}건 · 업무일지 ${counts.work}건`,
    key: `monthly:${period}:reports` }, at);
}

export function activityForUser(db, user, limit = 200) {
  if (user.role !== 'admin') return [];
  return db.prepare(`SELECT e.*,r.read_at FROM activity_events e
    LEFT JOIN activity_reads r ON r.event_id=e.id AND r.user_id=?
    ORDER BY e.created_at DESC,e.id DESC LIMIT ?`).all(user.id, limit)
    .map(row => ({ ...row, id: `activity:${row.id}` }));
}

export function activityUnread(db, user) {
  if (user.role !== 'admin') return 0;
  return db.prepare('SELECT COUNT(*) n FROM activity_events e LEFT JOIN activity_reads r ON r.event_id=e.id AND r.user_id=? WHERE r.event_id IS NULL').get(user.id).n;
}

export function readActivity(db, user, id, at = new Date()) {
  if (user.role !== 'admin') return;
  if (id == null) {
    db.prepare('INSERT OR IGNORE INTO activity_reads(event_id,user_id,read_at) SELECT e.id,?,? FROM activity_events e').run(user.id, at.toISOString());
  } else if (/^activity:[1-9]\d*$/.test(String(id))) {
    db.prepare('INSERT OR IGNORE INTO activity_reads(event_id,user_id,read_at) SELECT id,?,? FROM activity_events WHERE id=?').run(user.id, at.toISOString(), Number(String(id).slice(9)));
  }
}
