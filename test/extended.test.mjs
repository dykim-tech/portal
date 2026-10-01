import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('categories, installation files, customer work logs, and CSV reports', async () => {
  const origin = 'http://localhost:3101';
  const portal = createPortal({ dataDir: mkdtempSync(join(tmpdir(), 'portal-extended-')), origin });
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
    const setup = await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', email: 'admin@example.test', password: 'test-password-1234' });
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
    const created = await request('/installations', 'POST', { name: '서버 설치', customer: '테스트 고객', installed_on: '2026-10-01', status: 'installed', category_id: installLeaf, notes: '완료' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const installationId = created.data.installation.id;
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
    const small = (await request('/folders', 'POST', { name: '설치 안내', parent_id: middle })).data.id;
    assert.equal((await request('/folders', 'POST', { name: '너무 깊음', parent_id: small })).status, 400);
    const manual = new FormData();
    manual.append('file', new Blob(['설치 순서']), '안내.txt');
    assert.equal((await request('/manuals?folder=' + small, 'POST', manual)).status, 201);
    assert.equal((await request('/library?folder=' + small)).data.total, 1);

    const customers = await request('/customers');
    const customer = customers.data.customers.find(row => row.name === '테스트 고객');
    assert.ok(customer, 'Installation customer is available for work logs');
    const log = await request('/work-logs', 'POST', { customer_id: customer.id, work_date: '2026-10-01', title: '점검', owner: '담당자', status: 'done', content: '정상 작동' });
    assert.equal(log.status, 201, JSON.stringify(log.data));
    assert.equal((await request('/work-logs?customer_id=' + customer.id)).data.total, 1);
    assert.equal((await request('/work-logs?from=2026-10-02')).data.total, 0);
    const report = await request('/reports?from=2026-10-01&to=2026-10-01');
    assert.deepEqual([report.data.counts.installations, report.data.counts.items, report.data.counts.manuals, report.data.counts.work_logs], [1, 1, 1, 1]);
    const installationCsv = await request('/reports/installations.csv');
    assert.equal(installationCsv.status, 200);
    assert.match(installationCsv.data, /고객사 \/ 서버 \/ 신규 설치/);
    assert.match(installationCsv.data, /서버 설치/);
    const workCsv = await request('/reports/work-logs.csv?from=2026-10-02');
    assert.equal(workCsv.status, 200);
    assert.doesNotMatch(workCsv.data, /정상 작동/);
    const viewer = await request('/users', 'POST', { name: '조회자', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' });
    assert.equal(viewer.status, 201);
    const login = await request('/auth/login', 'POST', { email: 'viewer@example.test', password: 'test-password-1234' });
    const viewerCookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/reports', 'GET', undefined, viewerCookie)).status, 200);
    assert.equal((await request('/categories', 'POST', { scope: 'items', name: '금지' }, viewerCookie)).status, 403);
    assert.equal((await request('/work-logs', 'POST', { customer_id: customer.id, work_date: '2026-10-01', title: '금지', status: 'done' }, viewerCookie)).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    portal.db.close();
  }
});
