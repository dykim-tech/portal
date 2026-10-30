// 첫 화면 메모(2026-10-30 개편): 사용자마다 스티커 메모 2장을 항상 둔다(추가·삭제 없이 바로 쓰는 메모장 2개).
// 예전에 4장까지 만들던 때의 빈 메모는 정리하고, 내용이 있는 메모는 지우지 않는다. 글을 쓰면 자동 저장하며, 다른 창에서 먼저 저장했으면(버전 불일치) 덮어쓰지 않고 409와 최신 내용을 돌려준다.
// 예전 한 장짜리 메모(user_notes)는 처음 열 때 첫 메모로 옮긴다(원래 표는 그대로 둠).

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
export const NOTE_MAX = 5000, NOTE_COUNT_MAX = 2;

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
  // 메모를 항상 2장으로 맞춘다: 없으면 만들고(예전 한 장짜리 메모가 있으면 첫 장에), 2장을 넘는 빈 메모는 지운다.
  const ensure = userId => {
    let rows = list(userId);
    if (rows.length > NOTE_COUNT_MAX) {
      for (const row of [...rows].reverse()) {
        if (rows.length <= NOTE_COUNT_MAX) break;
        if (!row.body.trim()) { db.prepare('DELETE FROM dashboard_notes WHERE id=?').run(row.id); rows = rows.filter(r => r.id !== row.id); }
      }
    }
    if (!rows.length) {
      // 예전 메모는 한 번만 옮긴다(옮긴 뒤 모두 지우면 빈 메모로 시작).
      const migrated = db.prepare('SELECT 1 FROM dashboard_notes_migrated WHERE user_id=?').get(userId);
      const old = migrated ? null : db.prepare('SELECT body, updated_at FROM user_notes WHERE user_id=?').get(userId);
      insert(userId, old?.body ?? '', old?.body ? old.updated_at : null);
      db.prepare('INSERT OR IGNORE INTO dashboard_notes_migrated(user_id) VALUES(?)').run(userId);
      rows = list(userId);
    }
    while (rows.length < NOTE_COUNT_MAX) { insert(userId); rows = list(userId); }
    return rows;
  };
  const text = body => {
    if (typeof body !== 'string' || body.length > NOTE_MAX) throw fail(400, `메모는 ${NOTE_MAX.toLocaleString('ko-KR')}자까지 쓸 수 있습니다.`);
    return body;
  };

  app.get('/api/dashboard-notes', (req, res) => res.json({ notes: ensure(req.user.id), max: NOTE_COUNT_MAX }));
  app.put('/api/dashboard-notes/:id', (req, res) => {
    const current = own(req.params.id, req.user.id), body = text(req.body?.body), version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) throw fail(400, '메모 버전을 확인해 주세요.');
    if (current.version !== version) return res.status(409).json({ error: '다른 창에서 메모가 바뀌었습니다. 최신 내용을 불러왔습니다.', note: current });
    db.prepare('UPDATE dashboard_notes SET body=?, version=version+1, updated_at=? WHERE id=?').run(body, new Date().toISOString(), current.id);
    res.json({ note: own(current.id, req.user.id) });
  });
  // 예전에 만든 3·4번째 메모(내용이 있어 자동으로 지우지 않은 것)만 화면에서 지울 수 있다.
  app.delete('/api/dashboard-notes/:id', (req, res) => {
    const current = own(req.params.id, req.user.id);
    db.prepare('DELETE FROM dashboard_notes WHERE id=?').run(current.id);
    res.json({ notes: ensure(req.user.id) }); // 2장보다 적어지면 빈 메모로 다시 채운다
  });
}
