// 첫 화면 메모 스티커(2026-10-28, 포털형): 사용자마다 메모 한 장. 메모장처럼 글만 쓰고, 입력하면 자동 저장한다.
// 다른 창에서 먼저 저장했으면(버전 불일치) 덮어쓰지 않고 409와 최신 내용을 돌려준다.

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
export const NOTE_MAX = 5000;

export function initializeNotes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_notes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
}

export function registerNotes(app, { db }) {
  initializeNotes(db);
  const read = userId => db.prepare('SELECT body, version, updated_at FROM user_notes WHERE user_id=?').get(userId) ?? { body: '', version: 0, updated_at: null };
  app.get('/api/dashboard-note', (req, res) => res.json({ note: read(req.user.id) }));
  app.put('/api/dashboard-note', (req, res) => {
    const body = req.body?.body, version = Number(req.body?.version);
    if (typeof body !== 'string' || body.length > NOTE_MAX) throw fail(400, `메모는 ${NOTE_MAX.toLocaleString('ko-KR')}자까지 쓸 수 있습니다.`);
    if (!Number.isInteger(version) || version < 0) throw fail(400, '메모 버전을 확인해 주세요.');
    const current = read(req.user.id);
    if (current.version !== version) return res.status(409).json({ error: '다른 창에서 메모가 바뀌었습니다. 최신 내용을 불러왔습니다.', note: current });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO user_notes(user_id, body, version, updated_at) VALUES(?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET body=excluded.body, version=user_notes.version+1, updated_at=excluded.updated_at`).run(req.user.id, body, now);
    res.json({ note: read(req.user.id) });
  });
}
