import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';

test('categories, installation files, customer work logs, and CSV reports', async () => {
  const origin = 'http://localhost:3101';
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-extended-'));
  const portal = createPortal({ dataDir, origin });
  const server = portal.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, method = 'GET', body, session = cookie) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: session, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {})
    });
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  }
  try {
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' });
    assert.equal(setup.status, 201);
    cookie = setup.headers.get('set-cookie').split(';')[0];
    async function makeCategory(scope, name, parent_id = null) {
      const result = await request('/categories', 'POST', { scope, name, parent_id });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data.id;
    }
    const installMajor = await makeCategory('installations', '고객사');
    const installMid = await makeCategory('installations', '서버');
    // Mid-level categories must be attached to a parent.
    assert.equal((await request('/categories/' + installMid + '?scope=installations', 'DELETE')).status, 200);
    const serverMid = await makeCategory('installations', '서버', installMajor);
    const installLeaf = await makeCategory('installations', '신규 설치', serverMid);
    assert.equal((await request('/categories', 'POST', { scope: 'installations', name: '4단계', parent_id: installLeaf })).status, 400);
    const assetMajor = await makeCategory('items', '장비');
    const assetMid = await makeCategory('items', '네트워크', assetMajor);
    const assetLeaf = await makeCategory('items', '스위치', assetMid);
    assert.equal((await request('/categories?scope=items')).data.categories.length, 3);
    assert.equal((await request('/installations', 'POST', { name: '잘못된 분류', customer: 'A', installed_on: '2026-10-01', status: 'installed', category_id: assetLeaf })).status, 404);
    const created = await request('/installations', 'POST', { name: 'Petra Cipher', customer: '테스트 고객', product_version: 'Petra Cipher for Linux', quantity: 2, installed_on: '2026-10-01', completed_on: '2026-10-02', contact: '고객 담당자', engineer: '설치 엔지니어', status: 'installed', category_id: installLeaf, notes: '완료' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const installationId = created.data.installation.id;
    assert.equal(created.data.installation.quantity, 2);
    assert.equal(created.data.installation.completed_on, '2026-10-02');
    assert.equal(created.data.installation.contact, '고객 담당자');
    assert.equal((await request('/installations?q=고객 담당자')).data.total, 1);
    assert.equal((await request('/installations', 'POST', { name: '검증', customer: 'A', installed_on: '2026-10-01', completed_on: '2026-09-30', quantity: 1, status: 'installed' })).status, 400);
    assert.equal((await request('/installations', 'POST', { name: '검증', customer: 'A', installed_on: '2026-10-01', quantity: 0, status: 'installed' })).status, 400);
    assert.equal((await request('/installations?category_id=' + installMajor)).data.total, 1);
    assert.equal((await request('/installations?category_id=' + serverMid)).data.total, 1);
    const upload = new FormData();
    upload.append('file', new Blob(['설치 문서']), '설치.txt');
    assert.equal((await request('/installations/' + installationId + '/files', 'POST', upload)).status, 201);
    const detail = await request('/installations/' + installationId);
    assert.equal(detail.data.files.length, 1);
    const attachmentId = detail.data.files[0].id;
    assert.match((await request('/installation-files/' + attachmentId + '/preview')).data, /설치 문서/);
    assert.match((await request('/installation-files/' + attachmentId + '/download')).headers.get('content-disposition'), /attachment/);
    const asset = await request('/items', 'POST', { name: '스위치', asset_code: 'SW-001', category: 'it', category_id: assetLeaf, status: 'active', quantity: 1, reminder_days: 7 });
    assert.equal(asset.status, 201, JSON.stringify(asset.data));
    assert.equal((await request('/items?category_id=' + assetMajor)).data.total, 1);

    const large = (await request('/folders', 'POST', { name: '제품' })).data.id;
    const middle = (await request('/folders', 'POST', { name: '서버', parent_id: large })).data.id;
    assert.equal((await request('/folders', 'POST', { name: '너무 깊음', parent_id: middle })).status, 400);
    const manual = new FormData();
    manual.append('file', new Blob(['설치 순서']), '안내.txt');
    assert.equal((await request('/manuals?folder=' + middle, 'POST', manual)).status, 201);
    assert.equal((await request('/library?folder=' + middle)).data.total, 1);

    const customers = await request('/customers');
    const customer = customers.data.customers.find(row => row.name === '테스트 고객');
    assert.ok(customer, 'Installation customer is available for work logs');
    const log = await request('/work-logs', 'POST', { customer_id: customer.id, work_date: '2026-10-01', title: '점검', owner: '담당자', status: 'done', content: '정상 작동' });
    assert.equal(log.status, 201, JSON.stringify(log.data));
    assert.equal((await request('/work-logs?customer_id=' + customer.id)).data.total, 1);
    assert.equal((await request('/work-logs?from=2026-10-02')).data.total, 0);
    const report = await request('/reports');
    assert.deepEqual([report.data.counts.installations, report.data.counts.items, report.data.counts.manuals, report.data.counts.work_logs], [1, 1, 1, 1]);
    const installationCsv = await request('/reports/installations.csv');
    assert.equal(installationCsv.status, 200);
    assert.match(installationCsv.data, /고객사 \/ 서버 \/ 신규 설치/);
    assert.match(installationCsv.data, /Petra Cipher for Linux/);
    assert.match(installationCsv.data, /설치종료일/);
    assert.match(installationCsv.data, /고객 담당자/);
    const formulaCustomer = await request('/customers', 'POST', { name: '=2+2' });
    const formulaLog = await request('/work-logs', 'POST', { customer_id: formulaCustomer.data.customer.id, work_date: '2026-10-01', title: 'CSV 검사', status: 'done' });
    assert.equal(formulaLog.status, 201);
    const protectedCsv = await request('/reports/work-logs.csv');
    assert.match(protectedCsv.data, /"'=2\+2"/);
    const workCsv = await request('/reports/work-logs.csv?from=2026-10-02');
    assert.equal(workCsv.status, 200);
    assert.doesNotMatch(workCsv.data, /정상 작동/);
    const viewer = await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' });
    assert.equal(viewer.status, 201);
    const login = await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' });
    const viewerCookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/reports', 'GET', undefined, viewerCookie)).status, 200);
    assert.equal((await request('/categories', 'POST', { scope: 'items', name: '금지' }, viewerCookie)).status, 403);
    assert.equal((await request('/work-logs', 'POST', { customer_id: customer.id, work_date: '2026-10-01', title: '금지', status: 'done' }, viewerCookie)).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
  const reopened = createPortal({ dataDir, origin });
  try {
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM installations').get().n, 1);
    assert.equal(reopened.db.prepare('SELECT quantity FROM installations').get().quantity, 2);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM work_logs').get().n, 2);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM record_categories').get().n, 6);
  } finally { reopened.db.close(); }
});

test('older installation records keep their data when sheet columns are added', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-install-migrate-'));
  const legacy = openDatabase(dataDir);
  legacy.exec(`CREATE TABLE installations (
    id INTEGER PRIMARY KEY,name TEXT NOT NULL,customer TEXT NOT NULL,location TEXT NOT NULL DEFAULT '',installed_on TEXT NOT NULL,
    engineer TEXT NOT NULL DEFAULT '',product_version TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO users(id,name,email,password,role,created_at) VALUES(1,'기존 관리자','old@example.test','unused','admin','2026-01-01T00:00:00Z');
    INSERT INTO installations(name,customer,installed_on,status,created_by,updated_by,created_at,updated_at)
    VALUES('기존 제품','기존 고객','2026-01-01','installed',1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`);
  legacy.close();
  const portal = createPortal({ dataDir });
  try {
    const row = portal.db.prepare('SELECT * FROM installations WHERE id=1').get();
    assert.equal(row.name, '기존 제품');
    assert.equal(row.customer, '기존 고객');
    assert.equal(row.quantity, 1);
    assert.equal(row.completed_on, null);
    assert.equal(row.contact, '');
  } finally { portal.db.close(); }
});

test('record deletion removes attachments while customer removal preserves linked history', async () => {
  const origin = 'http://localhost:3102';
  const dataDir = mkdtempSync(join(tmpdir(), 'portal-delete-'));
  const portal = createPortal({ dataDir, origin });
  const server = portal.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, method = 'GET', body, session = cookie) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: session, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {})
    });
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  }
  try {
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'delete-admin', email: 'delete-admin@example.test', password: 'test-password-1234' });
    cookie = setup.headers.get('set-cookie').split(';')[0];
    const viewer = await request('/users', 'POST', { name: '조회자', username: 'delete-viewer', email: 'delete-viewer@example.test', role: 'viewer', password: 'test-password-1234' });
    const viewerLogin = await request('/auth/login', 'POST', { username: 'delete-viewer', password: 'test-password-1234' });
    const viewerCookie = viewerLogin.headers.get('set-cookie').split(';')[0];
    const created = await request('/installations', 'POST', { name: '제품', customer: '기록 고객', installed_on: '2026-10-01', status: 'installed' });
    const installationId = created.data.installation.id;
    const attachment = new FormData();
    attachment.append('file', new Blob(['설치 첨부']), '설치.txt');
    assert.equal((await request('/installations/' + installationId + '/files', 'POST', attachment)).status, 201);
    const fileId = (await request('/installations/' + installationId)).data.files[0].id;
    const customerId = (await request('/customers')).data.customers.find(row => row.name === '기록 고객').id;
    const log = await request('/work-logs', 'POST', { customer_id: customerId, work_date: '2026-10-01', title: '설치 확인', status: 'done' });
    assert.equal((await request('/installations/' + installationId, 'DELETE', undefined, viewerCookie)).status, 403);
    assert.equal((await request('/customers/' + customerId, 'DELETE')).data.archived, true);
    assert.equal((await request('/customers')).data.customers.some(row => row.id === customerId), false);
    const restored = await request('/customers', 'POST', { name: '기록 고객' });
    assert.equal(restored.data.customer.id, customerId);
    assert.equal((await request('/customers/' + customerId, 'DELETE')).data.archived, true);
    assert.equal((await request('/work-logs/' + log.data.log.id)).data.log.customer_name, '기록 고객');
    assert.equal((await request('/installations/' + installationId)).status, 200);
    assert.equal((await request('/work-logs/' + log.data.log.id, 'DELETE')).status, 200);
    assert.equal((await request('/installations/' + installationId, 'DELETE')).status, 200);
    assert.equal((await request('/installation-files/' + fileId + '/download')).status, 404);
    assert.equal(portal.db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE scope='installation_files' AND file_id=?").get(fileId).n, 0);
    const asset = await request('/items', 'POST', { name: '장비', asset_code: 'DELETE-001', category: 'it', status: 'active', quantity: 1, reminder_days: 7 });
    const assetFile = new FormData();
    assetFile.append('file', new Blob(['자산 첨부']), '자산.txt');
    assert.equal((await request('/items/' + asset.data.item.id + '/files', 'POST', assetFile)).status, 201);
    const assetFileId = (await request('/items/' + asset.data.item.id)).data.files[0].id;
    assert.equal((await request('/items/' + asset.data.item.id, 'DELETE')).status, 200);
    assert.equal(portal.db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE scope='files' AND file_id=?").get(assetFileId).n, 0);
    assert.equal((await request('/users/' + viewer.data.user.id, 'DELETE')).status, 200);
    assert.equal((await request('/users/' + setup.data.user.id, 'DELETE')).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
  const reopened = createPortal({ dataDir, origin });
  try { assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM customers WHERE name='기록 고객' AND active=0").get().n, 1); }
  finally { reopened.db.close(); }
});
