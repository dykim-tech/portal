import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('meeting minutes: everyone reads, editors write, actions and files', async () => {
  const origin = 'http://localhost:3000', dataDir = mkdtempSync(join(tmpdir(), 'portal-meetings-'));
  const portal = createPortal({ dataDir, origin, selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  try {
    const admin = (await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).cookie;
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' }, admin);
    const viewer = (await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;
    assert.equal((await request('/meetings')).status, 401);

    assert.equal((await request('/meetings', 'POST', { title: '', meeting_date: '2026-10-12' }, admin)).status, 400);
    assert.equal((await request('/meetings', 'POST', { title: '주간 회의', meeting_date: '2026-10-12', start_time: '11:00', end_time: '10:00' }, admin)).status, 400);
    assert.equal((await request('/meetings', 'POST', { title: '조회자 작성', meeting_date: '2026-10-12' }, viewer)).status, 403);
    const created = await request('/meetings', 'POST', { title: '주간 기술 회의', meeting_date: '2026-10-12', start_time: '10:00', end_time: '11:00', location: '본사 회의실', attendees: '김동엽, 강동우', content: 'VPN 테스트 결과 공유', decisions: 'FortiClient로 통일' }, admin);
    assert.equal(created.status, 201);
    const id = created.data.meeting.id;
    await request('/meetings', 'POST', { title: '지난 회의', meeting_date: '2026-09-01' }, admin);

    let list = (await request('/meetings', 'GET', undefined, viewer)).data;
    assert.deepEqual(list.meetings.map(m => m.title), ['주간 기술 회의', '지난 회의']);
    assert.equal((await request('/meetings?q=' + encodeURIComponent('FortiClient'), 'GET', undefined, viewer)).data.total, 1);
    assert.equal((await request('/meetings?from=2026-10-01&to=2026-10-31', 'GET', undefined, viewer)).data.total, 1);

    const added = await request(`/meetings/${id}/actions`, 'POST', { task: '사용자 안내 메일 발송', owner: '강동우', due_date: '2026-10-15' }, admin);
    assert.equal(added.status, 201);
    assert.equal((await request(`/meetings/${id}/actions`, 'POST', { task: '조회자' }, viewer)).status, 403);
    assert.equal((await request(`/meeting-actions/${added.data.action.id}`, 'PUT', { done: true }, admin)).data.action.done_at !== null, true);

    const form = new FormData(); form.append('file', new Blob(['minutes attachment']), '회의자료.txt');
    const uploaded = await fetch(`${base}/api/meetings/${id}/files`, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: admin }, body: form });
    assert.equal(uploaded.status, 201);
    const fileId = (await uploaded.json()).id;

    const detail = (await request(`/meetings/${id}`, 'GET', undefined, viewer)).data;
    assert.equal(detail.meeting.decisions, 'FortiClient로 통일');
    assert.equal(detail.actions.length, 1); assert.equal(detail.files[0].name, '회의자료.txt');
    assert.equal(await (await fetch(`${base}/api/meeting-files/${fileId}/download`, { headers: { Cookie: viewer } })).text(), 'minutes attachment');
    list = (await request('/meetings', 'GET', undefined, admin)).data;
    const summary = list.meetings.find(m => m.id === id);
    assert.deepEqual([summary.action_count, summary.open_action_count, summary.file_count], [1, 0, 1]);

    const version = detail.meeting.version;
    assert.equal((await request(`/meetings/${id}`, 'PUT', { ...detail.meeting, title: '주간 기술 회의(수정)', version }, admin)).status, 200);
    assert.equal((await request(`/meetings/${id}`, 'PUT', { ...detail.meeting, version }, admin)).status, 409);
    assert.equal((await request(`/meetings/${id}`, 'DELETE', undefined, viewer)).status, 403);
    assert.equal((await request(`/meetings/${id}`, 'DELETE', undefined, admin)).status, 200);
    assert.equal((await request(`/meetings/${id}`, 'GET', undefined, admin)).status, 404);
    assert.equal((await fetch(`${base}/api/meeting-files/${fileId}/download`, { headers: { Cookie: admin } })).status, 404);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
