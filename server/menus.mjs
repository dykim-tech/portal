// 메뉴 표시 설정(포털 전체): 관리자가 끈 메뉴는 모든 사용자의 왼쪽·상단 메뉴에서 숨긴다.
// 메뉴 목록 자체는 화면(public/app.js)에 있으므로 서버는 숨길 메뉴 id만 저장한다. '설정'은 숨길 수 없다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
export const ALWAYS_VISIBLE = new Set(['settings']);

export function validateHiddenMenus(value) {
  if (!Array.isArray(value) || value.length > 40 || value.some(id => typeof id !== 'string' || !/^[a-z]{2,24}$/.test(id)) || new Set(value).size !== value.length) throw fail(400, '메뉴 표시 설정을 확인해 주세요.');
  if (value.some(id => ALWAYS_VISIBLE.has(id))) throw fail(400, '설정 메뉴는 숨길 수 없습니다.');
  return value;
}

// 첫 화면 '자주 쓰는 메뉴' 칩(포털형, 2026-10-28): 관리자가 설정에서 체크한 메뉴 id 목록(포털 전체).
// 저장한 적이 없으면 기본 4개를 쓴다. NAS 묶음은 하위 메뉴 id(nas-site·nasadmin·naslogin)로 고른다.
export const DEFAULT_QUICK_MENUS = ['drafts', 'meetings', 'library', 'work'];
export function validateQuickMenus(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !/^[a-z][a-z-]{1,23}$/.test(id)) || new Set(value).size !== value.length) throw fail(400, '자주 쓰는 메뉴 설정을 확인해 주세요.');
  return value;
}

export function createMenuSettings(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const hidden = () => {
    try {
      const list = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='menus'").get()?.value ?? '{}').hidden;
      return Array.isArray(list) ? list.filter(id => typeof id === 'string' && !ALWAYS_VISIBLE.has(id)) : [];
    } catch { return []; }
  };
  const quick = () => {
    try {
      const list = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='quick_menus'").get()?.value ?? 'null')?.ids;
      return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [...DEFAULT_QUICK_MENUS];
    } catch { return [...DEFAULT_QUICK_MENUS]; }
  };
  function register(app, { requireRole }) {
    app.put('/api/menu-settings/quick', requireRole(['admin']), (req, res) => {
      const ids = validateQuickMenus(req.body?.ids);
      db.prepare("INSERT INTO app_settings(key,value) VALUES('quick_menus',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ids }));
      res.json({ ids });
    });
    app.get('/api/menu-settings', (_req, res) => res.json({ hidden: hidden() }));
    app.put('/api/menu-settings', requireRole(['admin']), (req, res) => {
      const list = validateHiddenMenus(req.body?.hidden);
      db.prepare("INSERT INTO app_settings(key,value) VALUES('menus',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ hidden: list }));
      res.json({ hidden: list });
    });
  }
  return { hidden, quick, register };
}
