import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { koreaDate } from './db.mjs';

// 휴가 현황: 회사 공용 엑셀(.xlsx/.xlsm) 파일을 읽어 설정한 사원 1명의 연차·휴가 정보만 돌려준다.
// 엑셀 파일은 읽기만 하며 수정하지 않는다. 계산식 셀은 엑셀이 마지막으로 저장한 값을 쓰고,
// 오늘 날짜(TODAY)에 따라 바뀌는 'Today기준연차수'만 엑셀과 같은 식으로 다시 계산한다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// ---- ZIP(.xlsx) 읽기 ----
export function unzipEntries(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw fail(422, '엑셀 파일 형식을 읽을 수 없습니다.');
  const count = buffer.readUInt16LE(end + 10), entries = new Map();
  let at = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw fail(422, '엑셀 파일 형식을 읽을 수 없습니다.');
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20), nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return name => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size === 0xffffffff) throw fail(422, '엑셀 파일이 너무 큽니다.');
    const start = entry.local + 30 + buffer.readUInt16LE(entry.local + 26) + buffer.readUInt16LE(entry.local + 28);
    const data = buffer.subarray(start, start + entry.size);
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) return inflateRawSync(data).toString('utf8');
    throw fail(422, '엑셀 파일 압축 방식을 읽을 수 없습니다.');
  };
}

// ---- XML 셀 읽기 ----
const decode = text => text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) => hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()]);
const attr = (attrs, name) => attrs.match(new RegExp('\\b' + name + '="([^"]*)"'))?.[1];
const texts = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');

export function readSharedStrings(xml) {
  return xml ? [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1])) : [];
}

export function readCells(xml, shared) {
  const cells = new Map();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(m[1], 'r'), type = attr(m[1], 't'), body = m[2] ?? '';
    if (!ref) continue;
    const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let value = null;
    if (type === 'inlineStr') value = texts(body);
    else if (raw === undefined) continue;
    else if (type === 's') value = shared[Number(raw)] ?? '';
    else if (type === 'str') value = decode(raw);
    else if (type === 'b') value = raw === '1';
    else if (type === 'e') value = null;
    else value = Number(raw);
    if (value !== null && value !== '') cells.set(ref, value);
  }
  return cells;
}

export function readWorkbook(buffer) {
  const entry = unzipEntries(buffer), workbook = entry('xl/workbook.xml'), rels = entry('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw fail(422, '엑셀 통합 문서를 읽을 수 없습니다.');
  const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const shared = readSharedStrings(entry('xl/sharedStrings.xml'));
  const sheets = new Map();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decode(attr(m[1], 'name') ?? ''), target = targets.get(attr(m[1], 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    sheets.set(name, { path, cells: null });
  }
  return name => {
    const sheet = sheets.get(name);
    if (!sheet) return null;
    sheet.cells ??= readCells(entry(sheet.path) ?? '', shared);
    return sheet.cells;
  };
}

// ---- 셀 주소·날짜 도우미 ----
const columnName = index => { let name = ''; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
const at = (cells, column, row) => cells.get(columnName(column) + row);
const text = value => value === undefined || value === null ? '' : String(value).trim();
const number = value => { const n = typeof value === 'number' ? value : Number(String(value ?? '').trim()); return value === undefined || value === null || String(value).trim() === '' || !Number.isFinite(n) ? null : n; };
export const excelDate = value => { const n = number(value); return n === null ? null : new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10); };

function findHeader(cells, label, maxRow = 40, maxColumn = 40) {
  for (let row = 1; row <= maxRow; row++) for (let column = 1; column <= maxColumn; column++) if (text(at(cells, column, row)) === label) return { row, column };
  return null;
}
function headerColumns(cells, row, maxColumn = 60) {
  const columns = new Map();
  for (let column = 1; column <= maxColumn; column++) { const label = text(at(cells, column, row)); if (label && !columns.has(label)) columns.set(label, column); }
  return columns;
}

// ---- 엑셀 DATEDIF(…,"m") / DATE(y,m,0) 과 같은 계산 ----
const parts = iso => iso.split('-').map(Number);
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
export function monthsBetween(from, to) {
  const [y1, m1, d1] = parts(from), [y2, m2, d2] = parts(to);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}
const days = (from, to) => (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;

// 사원정보 시트 'Today기준연차수' 열의 수식을 그대로 옮긴 계산(입사일·기준 회계월·오늘 날짜).
export function todayLeaveDays(hireDate, fiscalMonth, today) {
  if (!hireDate) return 0;
  if (hireDate > today) return 0;
  const year = parts(today)[0], fiscalStart = iso(year, fiscalMonth, 1), fiscalEve = iso(year, fiscalMonth, 0);
  if (days(hireDate, fiscalStart) < 365) {
    if (today < fiscalStart || parts(hireDate)[0] === year) return Math.min(monthsBetween(hireDate, today), 11);
    return Math.min(monthsBetween(hireDate, today), 11) - Math.min(monthsBetween(hireDate, fiscalEve), 11) + Math.floor(15 / 12 * monthsBetween(hireDate, fiscalStart));
  }
  return Math.min(Math.trunc((Math.trunc(monthsBetween(hireDate, fiscalStart) / 12) - 1) / 2 + 15), 25);
}

// 통합 문서에서 사원 1명의 휴가 정보를 뽑는다.
export function extractLeave(sheetOf, employee, today = koreaDate()) {
  const info = sheetOf('사원정보'), records = sheetOf('연차(휴가)정보'), hidden = sheetOf('Sheet1');
  if (!info) throw fail(422, "엑셀 파일에 '사원정보' 시트가 없습니다.");
  const head = findHeader(info, '사원명');
  if (!head) throw fail(422, "'사원정보' 시트에서 '사원명' 머리글을 찾지 못했습니다.");
  const columns = headerColumns(info, head.row);
  let row = null;
  for (let r = head.row + 1; r <= head.row + 2000; r++) if (text(at(info, head.column, r)) === employee) { row = r; break; }
  if (!row) throw fail(404, `'사원정보' 시트에서 사원명 '${employee}'을(를) 찾지 못했습니다.`);
  const value = label => columns.has(label) ? at(info, columns.get(label), row) : undefined;
  const year = number(findYear(info, head.row));
  const fiscalMonth = number(hidden?.get('A14')) ?? 1;
  const hireDate = excelDate(value('입사일'));
  const remainingColumn = columns.get('잔여일수');
  const months = [];
  if (remainingColumn) for (let column = remainingColumn + 1; column <= remainingColumn + 12; column++) {
    const label = text(at(info, column, head.row));
    if (!/^\d{1,2}월$/.test(label)) break;
    months.push({ label, days: number(at(info, column, row)) });
  }
  const list = [];
  if (records) {
    const top = findHeader(records, '사원명');
    if (top) {
      const c = headerColumns(records, top.row), get = (r, label) => c.has(label) ? at(records, c.get(label), r) : undefined;
      for (let r = top.row + 1; r <= top.row + 5000; r++) {
        if (text(at(records, top.column, r)) !== employee) continue;
        list.push({ type: text(get(r, '휴가구분')), start: excelDate(get(r, '휴가시작일')), end: excelDate(get(r, '휴가종료일')), days: number(get(r, '사용일수')), reason: text(get(r, '휴가사유')), note: text(get(r, '비고')) });
      }
      list.sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')));
    }
  }
  return {
    employee, year, fiscal_month: fiscalMonth,
    department: text(value('부서')), position: text(value('직책')), hire_date: hireDate,
    period: text(value('연차 적용 기간')),
    annual_days: number(value('연간 연차수')),
    today_days: hireDate ? todayLeaveDays(hireDate, fiscalMonth, today) : number(value('Today기준연차수')),
    used_days: number(value('사용일수')), remaining_days: number(value('잔여일수')),
    months, records: list,
  };
}
function findYear(cells, headerRow) {
  // 사원정보 시트 맨 위의 '년도' 왼쪽 칸(예: B3=2026)
  for (let row = 1; row < headerRow; row++) for (let column = 2; column <= 30; column++) if (text(at(cells, column, row)) === '년도') return at(cells, column - 1, row);
  return null;
}

// ---- 설정·API ----
export function validateLeaveSettings(body) {
  const file = String(body?.file ?? '').trim(), employee = String(body?.employee ?? '').trim();
  if (!file && !employee) return { file: '', employee: '' };
  if (!file || file.length > 500 || !isAbsolute(file) || !/\.xls[xm]$/i.test(file)) throw fail(400, '휴가 파일은 .xlsx 또는 .xlsm 파일의 전체 경로로 입력해 주세요.');
  if (!employee || employee.length > 50) throw fail(400, '사원명을 50자 이내로 입력해 주세요.');
  return { file, employee };
}

export function registerLeave(app, { db, requireRole }) {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const admin = requireRole(['admin']);
  const settings = () => { try { return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='leave'").get()?.value ?? '{}'); } catch { return {}; } };
  let cache = null;
  async function load(force) {
    const { file, employee } = settings();
    if (!file || !employee) return { configured: false };
    const base = { configured: true, employee, file_name: basename(file) };
    let info;
    try { info = await stat(file); } catch { return { ...base, error: '휴가 파일을 찾을 수 없습니다. 경로와 OneDrive 동기화 상태를 확인해 주세요.' }; }
    if (!info.isFile()) return { ...base, error: '휴가 파일 경로가 파일이 아닙니다.' };
    if (info.size > MAX_FILE_BYTES) return { ...base, error: '휴가 파일이 너무 큽니다(20MB 초과).' };
    const key = [file, info.size, info.mtimeMs].join('|');
    if (force || !cache || cache.key !== key) {
      try { cache = { key, sheetOf: readWorkbook(await readFile(file)) }; }
      catch (error) { cache = null; return { ...base, error: error.expose ? error.message : '휴가 파일을 읽지 못했습니다. 엑셀에서 파일이 열려 저장 중인지 확인해 주세요.' }; }
    }
    try { return { ...base, saved_at: new Date(info.mtimeMs).toISOString(), today: koreaDate(), ...extractLeave(cache.sheetOf, employee) }; }
    catch (error) { return { ...base, error: error.expose ? error.message : '휴가 정보를 해석하지 못했습니다.' }; }
  }
  app.get('/api/leave', admin, async (req, res) => res.json(await load(req.query.refresh === '1')));
  app.get('/api/leave/settings', admin, (_req, res) => { const { file = '', employee = '' } = settings(); res.json({ file, employee }); });
  app.put('/api/leave/settings', admin, (req, res) => {
    const value = validateLeaveSettings(req.body);
    db.prepare("INSERT INTO app_settings(key,value) VALUES('leave',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
    cache = null;
    res.json(value);
  });
}
