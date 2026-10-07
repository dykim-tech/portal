import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { createPortal } from '../server/app.mjs';
import { monthsBetween, todayLeaveDays, readWorkbook, extractLeave } from '../server/leave.mjs';

// 테스트용 최소 .xlsx(ZIP) 작성기
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), data = deflateRawSync(raw), nameBuffer = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data); centrals.push(central, nameBuffer); offset += 30 + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const serial = iso => (Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
const strings = [];
const s = text => { let i = strings.indexOf(text); if (i < 0) { strings.push(text); i = strings.length - 1; } return i; };
const cell = (ref, value) => typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="s"><v>${s(value)}</v></c>`;
const sheet = rows => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map(([r, cells]) => `<row r="${r}">${Object.entries(cells).map(([col, v]) => cell(col + r, v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
function workbook() {
  strings.length = 0;
  const header = { B: '사원명', C: '부서', D: '직책', E: '입사일', F: '연차 적용 기간', G: '연간 연차수', H: 'Today기준연차수', I: '추가일수', J: '공제일수', K: '사용일수', L: '잔여일수' };
  'MNOPQRSTUVWX'.split('').forEach((c, i) => { header[c] = (i + 1) + '월'; });
  const info = sheet([[3, { B: 2026, C: '년도' }], [6, header],
    [7, { B: '김동엽', C: '기술지원팀', D: '수석', E: serial('2025-11-01'), F: '2026-01-01~2026-12-31', G: 12, H: 11, K: 4, L: 8, O: 1, Q: 1, S: 2 }],
    [8, { B: '강동우', C: '기술지원팀', D: '전임', E: serial('2026-02-01'), F: '2026-01-01~2026-12-31', G: 10, H: 7, K: 5.5, L: 4.5, N: 1 }]]);
  const records = sheet([[5, { B: '사원명', C: '부서', D: '직책', E: '휴가구분', F: '휴가시작일', G: '휴가종료일', H: '사용일수', I: '휴가사유', J: '비고' }],
    [6, { B: '강동우', E: '연차', F: serial('2026-02-11'), G: serial('2026-02-11'), H: 1 }],
    [7, { B: '김동엽', E: '연차', F: serial('2026-03-20'), G: serial('2026-03-20'), H: 1 }],
    [8, { B: '김동엽', E: '반차', F: serial('2026-05-22'), G: serial('2026-05-22'), H: 0.5, I: '병원' }],
    [9, { B: '김동엽', E: '연차', F: serial('2026-07-30'), G: serial('2026-07-31'), H: 2, I: '하계휴가' }]]);
  const hidden = sheet([[1, { A: 1, C: 1 }], [14, { A: 1 }]]);
  const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(t => `<si><t>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`;
  return zip({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="사원정보" sheetId="1" r:id="rId1"/><sheet name="연차(휴가)정보" sheetId="2" r:id="rId2"/><sheet name="Sheet1" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': info, 'xl/worksheets/sheet2.xml': records, 'xl/worksheets/sheet3.xml': hidden, 'xl/sharedStrings.xml': shared,
  });
}

test('Today기준연차수 follows the workbook formula', () => {
  assert.equal(monthsBetween('2025-11-01', '2026-10-07'), 11);
  assert.equal(monthsBetween('2025-11-01', '2026-09-30'), 10);
  assert.equal(todayLeaveDays('2025-11-01', 1, '2026-09-30'), 11);
  assert.equal(todayLeaveDays('2025-11-01', 1, '2026-10-07'), 12);
  assert.equal(todayLeaveDays('2026-02-01', 1, '2026-10-07'), 8);
  assert.equal(todayLeaveDays('2026-02-01', 1, '2026-09-30'), 7);
  assert.equal(todayLeaveDays('2020-03-01', 1, '2026-10-07'), 17);
  assert.equal(todayLeaveDays('2027-01-01', 1, '2026-10-07'), 0);
});

test('extracts only the configured employee', () => {
  const leave = extractLeave(readWorkbook(workbook()), '김동엽', '2026-10-07');
  assert.equal(leave.year, 2026);
  assert.equal(leave.hire_date, '2025-11-01');
  assert.deepEqual([leave.annual_days, leave.today_days, leave.used_days, leave.remaining_days], [12, 12, 4, 8]);
  assert.deepEqual(leave.months.filter(m => m.days).map(m => [m.label, m.days]), [['3월', 1], ['5월', 1], ['7월', 2]]);
  assert.equal(leave.months.length, 12);
  assert.deepEqual(leave.records.map(r => [r.type, r.start, r.end, r.days, r.reason]), [['연차', '2026-07-30', '2026-07-31', 2, '하계휴가'], ['반차', '2026-05-22', '2026-05-22', 0.5, '병원'], ['연차', '2026-03-20', '2026-03-20', 1, '']]);
  assert.ok(!JSON.stringify(leave).includes('강동우'));
  assert.throws(() => extractLeave(readWorkbook(workbook()), '홍길동'), /찾지 못했습니다/);
});

test('leave API is admin-only and reads the configured file', async () => {
  const origin = 'http://localhost:3100', dataDir = mkdtempSync(join(tmpdir(), 'portal-leave-'));
  const file = join(dataDir, '휴가관리.xlsm'); writeFileSync(file, workbook());
  const portal = createPortal({ dataDir, backupDir: join(dataDir, 'backups'), origin, selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const login = async username => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-password-1234' }) })).headers.get('set-cookie').split(';')[0];
  try {
    assert.equal((await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).status, 201);
    const admin = await login('admin');
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', role: 'viewer', password: 'test-password-1234' }, admin);
    const viewer = await login('viewer');
    assert.deepEqual((await request('/leave', 'GET', undefined, admin)).data, { configured: false });
    assert.equal((await request('/leave/settings', 'PUT', { file: 'relative.xlsm', employee: '김동엽' }, admin)).status, 400);
    assert.equal((await request('/leave/settings', 'PUT', { file, employee: '김동엽' }, viewer)).status, 403);
    assert.equal((await request('/leave/settings', 'PUT', { file, employee: '김동엽' }, admin)).status, 200);
    assert.equal((await request('/leave', 'GET', undefined, viewer)).status, 403);
    const leave = (await request('/leave', 'GET', undefined, admin)).data;
    assert.equal(leave.employee, '김동엽'); assert.equal(leave.remaining_days, 8); assert.equal(leave.records.length, 3); assert.ok(leave.saved_at);
    await request('/leave/settings', 'PUT', { file: join(dataDir, 'missing.xlsm'), employee: '김동엽' }, admin);
    assert.match((await request('/leave', 'GET', undefined, admin)).data.error, /찾을 수 없습니다/);
    assert.equal((await request('/leave/settings', 'PUT', { file: '', employee: '' }, admin)).status, 200);
    assert.deepEqual((await request('/leave', 'GET', undefined, admin)).data, { configured: false });
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
