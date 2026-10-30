// 첫 화면 메모(2026-10-30 개편): 사용자마다 스티커 메모 최대 4장. 기본 1장을 두고, 메모 영역을 마우스 오른쪽 버튼으로
// 누르면 1장씩 더 만든다. 글을 쓰면 자동 저장하며, 다른 창에서 먼저 저장했으면(버전 불일치) 덮어쓰지 않고 409와 최신 내용을 돌려준다.
// 예전 한 장짜리 메모(user_notes)는 처음 열 때 첫 메모로 옮긴다(원래 표는 그대로 둠).

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
export const NOTE_MAX = 5000, NOTE_COUNT_MAX = 4;

export function initializeNotes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_notes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS dashboard_notes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS dashboard_notes_user ON dashboard_notes(user_id, id);
  CREATE TABLE IF NOT EXISTS dashboard_notes_migrated (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)`);
}

export function registerNotes(app, { db }) {
  initializeNotes(db);
  const select = 'SELECT id, body, version, updated_at FROM dashboard_notes';
  const list = userId => db.prepare(`${select} WHERE user_id=? ORDER BY id`).all(userId);
  const own = (id, userId) => {
    const row = db.prepare(`${select} WHERE id=? AND user_id=?`).get(Number(id), userId);
    if (!row) throw fail(404, '메모를 찾을 수 없습니다.');
    return row;
  };
  const insert = (userId, body = '', updatedAt = null) => db.prepare('INSERT INTO dashboard_notes(user_id, body, created_at, updated_at) VALUES(?,?,?,?)').run(userId, body, new Date().toISOString(), updatedAt).lastInsertRowid;
  // 메모가 하나도 없으면 기본 1장을 만든다(예전 메모가 있으면 그 내용으로).
  const ensure = userId => {
    let rows = list(userId);
    if (!rows.length) {
      // 예전 메모는 한 번만 옮긴다(옮긴 뒤 모두 지우면 빈 메모로 시작).
      const migrated = db.prepare('SELECT 1 FROM dashboard_notes_migrated WHERE user_id=?').get(userId);
      const old = migrated ? null : db.prepare('SELECT body, updated_at FROM user_notes WHERE user_id=?').get(userId);
      insert(userId, old?.body ?? '', old?.body ? old.updated_at : null);
      db.prepare('INSERT OR IGNORE INTO dashboard_notes_migrated(user_id) VALUES(?)').run(userId);
      rows = list(userId);
    }
    return rows;
  };
  const text = body => {
    if (typeof body !== 'string' || body.length > NOTE_MAX) throw fail(400, `메모는 ${NOTE_MAX.toLocaleString('ko-KR')}자까지 쓸 수 있습니다.`);
    return body;
  };

  app.get('/api/dashboard-notes', (req, res) => res.json({ notes: ensure(req.user.id), max: NOTE_COUNT_MAX }));
  app.post('/api/dashboard-notes', (req, res) => {
    const rows = ensure(req.user.id);
    if (rows.length >= NOTE_COUNT_MAX) throw fail(409, `메모는 ${NOTE_COUNT_MAX}장까지 만들 수 있습니다.`);
    const id = insert(req.user.id, text(req.body?.body ?? ''));
    res.status(201).json({ note: own(id, req.user.id) });
  });
  app.put('/api/dashboard-notes/:id', (req, res) => {
    const current = own(req.params.id, req.user.id), body = text(req.body?.body), version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) throw fail(400, '메모 버전을 확인해 주세요.');
    if (current.version !== version) return res.status(409).json({ error: '다른 창에서 메모가 바뀌었습니다. 최신 내용을 불러왔습니다.', note: current });
    db.prepare('UPDATE dashboard_notes SET body=?, version=version+1, updated_at=? WHERE id=?').run(body, new Date().toISOString(), current.id);
    res.json({ note: own(current.id, req.user.id) });
  });
  app.delete('/api/dashboard-notes/:id', (req, res) => {
    const current = own(req.params.id, req.user.id);
    db.prepare('DELETE FROM dashboard_notes WHERE id=?').run(current.id);
    res.json({ notes: ensure(req.user.id) }); // 마지막 1장을 지우면 빈 메모 1장이 다시 생긴다
  });
}
