// 공휴일(2026-10-28, 포털형 첫 화면 달력): Google 캘린더의 공개 '대한민국의 휴일' 캘린더(iCal)를 받아
// 설명이 '공휴일'인 날만 쓴다(기념일 제외). 받은 결과는 app_settings 'holidays'에 저장하고 하루에 한 번 다시 받는다.
// 받지 못하면 저장해 둔 목록을 그대로 쓰고 오류를 함께 알려 준다. 날짜·이름은 출처 그대로 보여 준다.

export const HOLIDAY_SOURCE = { name: 'Google 캘린더 · 대한민국의 휴일', url: 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics' };
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 30 * 60_000;

// iCal: 줄 이어쓰기(다음 줄이 공백·탭으로 시작) 펼치기, 이스케이프(\n \, \;) 풀기.
const unescape = value => value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
export function parseIcsHolidays(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = new Map();
  let event = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { event = {}; continue; }
    if (line === 'END:VEVENT') {
      if (event?.date && event.summary && /^공휴일/.test(event.description ?? '')) {
        const key = `${event.date}|${event.summary}`;
        if (!out.has(key)) out.set(key, { date: event.date, name: event.summary });
      }
      event = null; continue;
    }
    if (!event) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).split(';')[0].toUpperCase(), value = line.slice(at + 1);
    if (name === 'DTSTART') { const m = /^(\d{4})(\d{2})(\d{2})/.exec(value); if (m) event.date = `${m[1]}-${m[2]}-${m[3]}`; }
    else if (name === 'SUMMARY') event.summary = unescape(value).trim();
    else if (name === 'DESCRIPTION') event.description = unescape(value).trim();
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

export function registerHolidays(app, { db, fetchImpl = globalThis.fetch }) {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const load = () => { try { return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='holidays'").get()?.value ?? 'null'); } catch { return null; } };
  const save = value => db.prepare("INSERT INTO app_settings(key,value) VALUES('holidays',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  let running = null, lastTry = 0, lastError = '';

  async function refresh() {
    lastTry = Date.now();
    try {
      if (typeof fetchImpl !== 'function') throw new Error('이 환경에서는 인터넷 요청을 할 수 없습니다.');
      const response = await fetchImpl(HOLIDAY_SOURCE.url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseIcsHolidays(await response.text());
      if (!items.length) throw new Error('공휴일 정보를 찾지 못했습니다.');
      save({ fetched_at: new Date().toISOString(), items });
      lastError = '';
    } catch (error) { lastError = '공휴일 정보를 받지 못했습니다: ' + String(error?.message ?? error).slice(0, 200); }
  }

  app.get('/api/holidays', async (req, res) => {
    let saved = load();
    const stale = !saved || Date.now() - Date.parse(saved.fetched_at) > REFRESH_MS;
    if (stale && Date.now() - lastTry > RETRY_MS) {
      running ??= refresh().finally(() => { running = null; });
      if (!saved) await running; // 처음에는 받을 때까지 기다린다(이후에는 저장된 목록으로 바로 응답).
      saved = load();
    }
    const year = /^\d{4}$/.test(String(req.query.year ?? '')) ? String(req.query.year) : '';
    const items = (saved?.items ?? []).filter(item => !year || item.date.startsWith(year + '-'));
    res.json({ holidays: items, fetched_at: saved?.fetched_at ?? null, source: HOLIDAY_SOURCE.name, error: lastError || undefined });
  });
}
