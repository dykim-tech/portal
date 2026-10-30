// 첫 화면 달력 일정(2026-10-30, 포털형): 날짜를 눌러 간단한 일정(시각 선택 + 한 줄 내용)을 적는다. 사용자마다 따로 보관한다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export const EVENT_TITLE_MAX = 100;

export function validateEvent(body) {
  const date = String(body?.date ?? ''), time = String(body?.time ?? '').trim(), title = String(body?.title ?? '').trim();
  if (!isDate(date)) throw fail(400, '날짜를 확인해 주세요.');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, '시각을 확인해 주세요(예: 09:30).');
  if (!title) throw fail(400, '일정 내용을 입력해 주세요.');
  if (title.length > EVENT_TITLE_MAX) throw fail(400, `일정 내용은 ${EVENT_TITLE_MAX}자까지 쓸 수 있습니다.`);
  return { date, time, title };
}

// 메모 제목이 있으면 제목, 없으면 내용 첫 줄을 80자까지 쓴다.
export function todoText(row) {
  const text = String(row.title ?? '').trim() || String(row.body ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  return text.length > 80 ? text.slice(0, 80) + '…' : text || '(내용 없음)';
}

export function registerCalendar(app, { db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_date TEXT NOT NULL,
    event_time TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS calendar_events_user_date ON calendar_events(user_id, event_date)`);
  const select = "SELECT id, event_date AS date, event_time AS time, title FROM calendar_events";
  const own = (id, userId) => {
    const row = db.prepare(`${select} WHERE id=? AND user_id=?`).get(Number(id), userId);
    if (!row) throw fail(404, '일정을 찾을 수 없습니다.');
    return row;
  };
  app.get('/api/calendar-events', (req, res) => {
    const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
    if (!isDate(from) || !isDate(to) || from > to) throw fail(400, '조회 기간을 확인해 주세요.');
    if (Date.parse(to) - Date.parse(from) > 400 * 86400000) throw fail(400, '조회 기간은 400일 이내로 정해 주세요.');
    const events = db.prepare(`${select} WHERE user_id=? AND event_date BETWEEN ? AND ? ORDER BY event_date, event_time='' DESC, event_time, id`).all(req.user.id, from, to);
    // TO-DO List 연동: 본인 메모를 목표 날짜(target_date)에 함께 보여 준다. 잠긴 메모는 내용 없이 잠금 제목만 보여 준다.
    const todos = db.prepare("SELECT id, target_date AS date, title, body, done, lock_hash, lock_title FROM todos WHERE user_id=? AND target_date BETWEEN ? AND ? ORDER BY target_date, done, id").all(req.user.id, from, to)
      .map(row => ({ id: row.id, date: row.date, done: Boolean(row.done), locked: Boolean(row.lock_hash), text: row.lock_hash ? (row.lock_title ?? '') : todoText(row) }));
    res.json({ events, todos });
  });
  app.post('/api/calendar-events', (req, res) => {
    const { date, time, title } = validateEvent(req.body);
    if (db.prepare('SELECT count(*) n FROM calendar_events WHERE user_id=? AND event_date=?').get(req.user.id, date).n >= 30) throw fail(400, '하루에 일정은 30건까지 적을 수 있습니다.');
    const now = new Date().toISOString();
    const id = db.prepare('INSERT INTO calendar_events(user_id, event_date, event_time, title, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(req.user.id, date, time, title, now, now).lastInsertRowid;
    res.status(201).json({ event: own(id, req.user.id) });
  });
  app.put('/api/calendar-events/:id', (req, res) => {
    own(req.params.id, req.user.id);
    const { date, time, title } = validateEvent(req.body);
    db.prepare('UPDATE calendar_events SET event_date=?, event_time=?, title=?, updated_at=? WHERE id=? AND user_id=?').run(date, time, title, new Date().toISOString(), Number(req.params.id), req.user.id);
    res.json({ event: own(req.params.id, req.user.id) });
  });
  app.delete('/api/calendar-events/:id', (req, res) => {
    own(req.params.id, req.user.id);
    db.prepare('DELETE FROM calendar_events WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });
}
