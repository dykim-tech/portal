import { transaction } from './db.mjs';
import { storeUpload, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile } from './uploads.mjs';

// 회의록: 모든 사용자가 열람하고, 편집자·관리자가 작성·수정·삭제한다.
// 한 건은 기본 항목(제목·날짜·시간·장소·참석자·내용), 결정 사항, 후속 조치(담당자·기한·완료), 첨부파일로 이루어진다.
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const id = value => { if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail(400, '번호를 확인해 주세요.'); return Number(value); };
const text = (value, label, max, required = false) => {
  if (value != null && typeof value !== 'string') throw fail(400, `${label} 형식을 확인해 주세요.`);
  const result = (value ?? '').trim();
  if (required && !result) throw fail(400, `${label}을(를) 입력해 주세요.`);
  if (result.length > max) throw fail(400, `${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return result;
};
const date = (value, label, required = false) => {
  if (value == null || value === '') { if (required) throw fail(400, `${label}을(를) 입력해 주세요.`); return null; }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(400, `${label}을(를) 확인해 주세요.`);
  return value;
};
const time = (value, label) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw fail(400, `${label}을(를) 확인해 주세요.`);
  return value;
};

export function initializeMeetings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '', attendees TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '', decisions TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meetings_date ON meetings(meeting_date DESC,start_time DESC,id DESC);
  CREATE TABLE IF NOT EXISTS meeting_actions (
    id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    task TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', due_date TEXT, done_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meeting_actions_meeting ON meeting_actions(meeting_id,id);
  CREATE TABLE IF NOT EXISTS meeting_files (
    id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    name TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meeting_files_meeting ON meeting_files(meeting_id);`);
}

export function registerMeetings(app, { db, requireRole, upload }) {
  const edit = requireRole(['admin', 'editor']);
  const meeting = value => {
    const row = db.prepare('SELECT m.*,cu.name created_by_name,uu.name updated_by_name FROM meetings m LEFT JOIN users cu ON cu.id=m.created_by LEFT JOIN users uu ON uu.id=m.updated_by WHERE m.id=?').get(id(value));
    if (!row) throw fail(404, '회의록을 찾을 수 없습니다.');
    return row;
  };
  const action = value => { const row = db.prepare('SELECT * FROM meeting_actions WHERE id=?').get(id(value)); if (!row) throw fail(404, '후속 조치를 찾을 수 없습니다.'); return row; };
  const meetingFile = value => { const file = getStoredFile(db, 'meeting_files', id(value)); if (!file) throw fail(404, '첨부파일을 찾을 수 없습니다.'); return file; };
  const touch = (meetingId, userId) => db.prepare('UPDATE meetings SET version=version+1,updated_by=?,updated_at=? WHERE id=?').run(userId, now(), meetingId);
  function input(body) {
    const start_time = time(body.start_time, '시작 시간'), end_time = time(body.end_time, '종료 시간');
    if (start_time && end_time && end_time < start_time) throw fail(400, '종료 시간은 시작 시간 이후로 입력해 주세요.');
    return {
      title: text(body.title, '회의 제목', 200, true), meeting_date: date(body.meeting_date, '회의 날짜', true), start_time, end_time,
      location: text(body.location, '장소', 200), attendees: text(body.attendees, '참석자', 2000),
      content: text(body.content, '회의 내용', 50000), decisions: text(body.decisions, '결정 사항', 20000),
    };
  }

  app.get('/api/meetings', (req, res) => {
    const clauses = [], params = [];
    const q = text(req.query.q, '검색어', 200);
    if (q) { const term = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; clauses.push("(m.title LIKE ? ESCAPE '\\' OR m.attendees LIKE ? ESCAPE '\\' OR m.location LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\' OR m.decisions LIKE ? ESCAPE '\\')"); params.push(term, term, term, term, term); }
    const from = date(req.query.from, '시작일'), to = date(req.query.to, '종료일');
    if (from) { clauses.push('m.meeting_date>=?'); params.push(from); }
    if (to) { clauses.push('m.meeting_date<=?'); params.push(to); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const page = req.query.page == null ? 1 : id(req.query.page), pageSize = 20;
    const total = db.prepare(`SELECT COUNT(*) n FROM meetings m ${where}`).get(...params).n;
    const meetings = db.prepare(`SELECT m.id,m.title,m.meeting_date,m.start_time,m.end_time,m.location,m.attendees,m.updated_at,uu.name updated_by_name,
      (SELECT COUNT(*) FROM meeting_actions a WHERE a.meeting_id=m.id) action_count,
      (SELECT COUNT(*) FROM meeting_actions a WHERE a.meeting_id=m.id AND a.done_at IS NULL) open_action_count,
      (SELECT COUNT(*) FROM meeting_files f WHERE f.meeting_id=m.id) file_count
      FROM meetings m LEFT JOIN users uu ON uu.id=m.updated_by ${where}
      ORDER BY m.meeting_date DESC,m.start_time DESC,m.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    res.json({ meetings, total, page, page_size: pageSize });
  });
  app.get('/api/meetings/:id', (req, res) => {
    const row = meeting(req.params.id);
    res.json({ meeting: row,
      actions: db.prepare('SELECT * FROM meeting_actions WHERE meeting_id=? ORDER BY id').all(row.id),
      files: db.prepare('SELECT id,name,size,created_at FROM meeting_files WHERE meeting_id=? ORDER BY id').all(row.id) });
  });
  app.post('/api/meetings', edit, (req, res) => {
    const data = input(req.body), stamp = now();
    const result = db.prepare(`INSERT INTO meetings(${Object.keys(data).join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(Object.keys(data).length + 4).fill('?').join(',')})`).run(...Object.values(data), req.user.id, req.user.id, stamp, stamp);
    res.status(201).json({ meeting: meeting(result.lastInsertRowid) });
  });
  app.put('/api/meetings/:id', edit, (req, res) => {
    const data = input(req.body);
    transaction(db, () => {
      const original = meeting(req.params.id);
      if (original.version !== Number(req.body.version)) throw fail(409, '다른 사용자가 먼저 수정했습니다. 회의록을 다시 열어 주세요.');
      db.prepare(`UPDATE meetings SET ${Object.keys(data).map(key => key + '=?').join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...Object.values(data), req.user.id, now(), original.id);
    });
    res.json({ meeting: meeting(req.params.id) });
  });
  app.delete('/api/meetings/:id', edit, (req, res) => {
    const row = meeting(req.params.id);
    transaction(db, () => {
      for (const file of db.prepare('SELECT id FROM meeting_files WHERE meeting_id=?').all(row.id)) deleteUploadChunks(db, 'meeting_files', file.id);
      db.prepare('DELETE FROM meetings WHERE id=?').run(row.id);
    });
    res.json({ ok: true, id: row.id, title: row.title });
  });

  // 후속 조치: 할 일·담당자·기한·완료 여부
  app.post('/api/meetings/:id/actions', edit, (req, res) => {
    const row = meeting(req.params.id);
    const task = text(req.body.task, '후속 조치', 500, true), owner = text(req.body.owner, '담당자', 100), due = date(req.body.due_date, '기한');
    const created = transaction(db, () => { const result = db.prepare('INSERT INTO meeting_actions(meeting_id,task,owner,due_date,created_at) VALUES(?,?,?,?,?)').run(row.id, task, owner, due, now()); touch(row.id, req.user.id); return Number(result.lastInsertRowid); });
    res.status(201).json({ action: action(created), title: task });
  });
  app.put('/api/meeting-actions/:id', edit, (req, res) => {
    const row = action(req.params.id);
    if (typeof req.body.done !== 'boolean') throw fail(400, '완료 여부를 확인해 주세요.');
    transaction(db, () => { db.prepare('UPDATE meeting_actions SET done_at=? WHERE id=?').run(req.body.done ? now() : null, row.id); touch(row.meeting_id, req.user.id); });
    res.json({ action: action(row.id), title: row.task });
  });
  app.delete('/api/meeting-actions/:id', edit, (req, res) => {
    const row = action(req.params.id);
    transaction(db, () => { db.prepare('DELETE FROM meeting_actions WHERE id=?').run(row.id); touch(row.meeting_id, req.user.id); });
    res.json({ ok: true, title: row.task });
  });

  // 첨부파일
  app.post('/api/meetings/:id/files', edit, (req, res, next) => { meeting(req.params.id); next(); }, upload, async (req, res) => {
    if (!req.file) throw fail(400, '첨부할 파일을 선택해 주세요.');
    try {
      const row = meeting(req.params.id);
      const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const name = (decoded.includes('�') ? req.file.originalname : decoded).replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 240);
      if (!name) throw fail(400, '파일 이름을 확인해 주세요.');
      const fileId = await storeUpload(db, 'meeting_files', req.file, fileId => {
        db.prepare('INSERT INTO meeting_files(id,meeting_id,name,size,bytes,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId, row.id, name, req.file.size, Buffer.alloc(0), req.user.id, now());
        touch(row.id, req.user.id);
        return fileId;
      });
      res.status(201).json({ id: fileId, file: { id: fileId, name } });
    } finally { discardUpload(req.file); }
  });
  app.get('/api/meeting-files/:id/download', (req, res) => {
    const file = meetingFile(req.params.id);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    sendStoredFile(db, 'meeting_files', file, res);
  });
  app.delete('/api/meeting-files/:id', edit, (req, res) => {
    const file = meetingFile(req.params.id);
    transaction(db, () => { deleteUploadChunks(db, 'meeting_files', file.id); db.prepare('DELETE FROM meeting_files WHERE id=?').run(file.id); touch(file.parent_id, req.user.id); });
    res.json({ ok: true, file: { id: file.id, name: file.name } });
  });
}
