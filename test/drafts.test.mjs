import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createPortal } from '../server/app.mjs';

// 간단한 ZIP 읽기(테스트용): 항목 이름 순서, 압축 방식, 내용
function unzip(buffer) {
  const entries = []; let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const method = buffer.readUInt16LE(at + 8), size = buffer.readUInt32LE(at + 18), nameLength = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength), data = buffer.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    entries.push({ name, method, text: () => (method ? inflateRawSync(data) : data).toString('utf8') });
    at += 30 + nameLength + extra + size;
  }
  return entries;
}

test('work drafts: write, links, files, status and export to PDF/Word/HWPX', async () => {
  const origin = 'http://localhost:3000', dataDir = mkdtempSync(join(tmpdir(), 'portal-drafts-'));
  const portal = createPortal({ dataDir, origin, selfCheck: false });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  try {
    const admin = (await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).cookie;
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' }, admin);
    const viewer = (await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;

    assert.equal((await request('/drafts', 'POST', { title: '', draft_date: '2026-10-12' }, admin)).status, 400);
    assert.equal((await request('/drafts', 'POST', { title: 'x', draft_date: '2026-10-12', status: 'unknown' }, admin)).status, 400);
    assert.equal((await request('/drafts', 'POST', { title: 'x', draft_date: '2026-10-12' }, viewer)).status, 403);
    const created = await request('/drafts', 'POST', { title: 'GYSMONI 설치 지원 기안', draft_date: '2026-10-12', drafter: '김동엽', content: '1. 목적\n  설치 지원 <A&B>' }, admin);
    assert.equal(created.status, 201); assert.equal(created.data.draft.status, 'writing');
    const id = created.data.draft.id;

    const link = await request(`/drafts/${id}/links`, 'POST', { name: '', url: 'example.com/manual?a=1&b=2' }, admin);
    assert.equal(link.status, 201); assert.equal(link.data.link.url, 'https://example.com/manual?a=1&b=2'); assert.equal(link.data.link.name, 'example.com/manual');
    assert.equal((await request(`/drafts/${id}/links`, 'POST', { url: 'javascript:alert(1)' }, admin)).status, 400);
    const form = new FormData(); form.append('file', new Blob(['plan']), '설치계획서.txt');
    const uploaded = await fetch(`${base}/api/drafts/${id}/files`, { method: 'POST', headers: { Origin: origin, 'X-Portal-Request': '1', Cookie: admin }, body: form });
    assert.equal(uploaded.status, 201);

    // 작성 중에는 문서로 저장할 수 없다.
    assert.equal((await fetch(`${base}/api/drafts/${id}/export?format=pdf`, { headers: { Cookie: admin } })).status, 409);
    const detail = (await request(`/drafts/${id}`, 'GET', undefined, viewer)).data;
    assert.equal(detail.links.length, 1); assert.equal(detail.files[0].name, '설치계획서.txt');
    assert.equal((await request(`/drafts/${id}`, 'PUT', { ...detail.draft, status: 'done', version: detail.draft.version }, admin)).status, 200);
    assert.equal((await request(`/drafts/${id}`, 'PUT', { ...detail.draft, version: detail.draft.version }, admin)).status, 409);
    assert.equal((await fetch(`${base}/api/drafts/${id}/export?format=txt`, { headers: { Cookie: viewer } })).status, 400);

    const docx = await fetch(`${base}/api/drafts/${id}/export?format=docx`, { headers: { Cookie: viewer } });
    assert.equal(docx.status, 200);
    assert.match(decodeURIComponent(docx.headers.get('content-disposition')), /GYSMONI 설치 지원 기안_2026-10-12\.docx/);
    const word = unzip(Buffer.from(await docx.arrayBuffer()));
    const documentXml = word.find(e => e.name === 'word/document.xml').text();
    assert.match(documentXml, /GYSMONI 설치 지원 기안/); assert.match(documentXml, /설치 지원 &lt;A&amp;B&gt;/); assert.match(documentXml, /설치계획서\.txt/);
    assert.match(word.find(e => e.name === 'word/_rels/document.xml.rels').text(), /https:\/\/example\.com\/manual\?a=1&amp;b=2/);

    const hwpx = await fetch(`${base}/api/drafts/${id}/export?format=hwpx`, { headers: { Cookie: viewer } });
    assert.equal(hwpx.status, 200);
    const hangul = unzip(Buffer.from(await hwpx.arrayBuffer()));
    assert.equal(hangul[0].name, 'mimetype'); assert.equal(hangul[0].method, 0); assert.equal(hangul[0].text(), 'application/hwp+zip');
    const section = hangul.find(e => e.name === 'Contents/section0.xml').text();
    assert.match(section, /<hp:secPr/); assert.match(section, /업무 기안서/); assert.match(section, /김동엽/); assert.match(section, /rowCnt="4" colCnt="2"/);
    const ids = [...section.matchAll(/<hp:p id="(\d+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'paragraph ids are unique');

    const pdf = await fetch(`${base}/api/drafts/${id}/export?format=pdf`, { headers: { Cookie: viewer } });
    if (pdf.status === 503) assert.match((await pdf.json()).error, /한글 글꼴/); // 한글 글꼴이 없는 PC
    else { assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-'); }

    const list = (await request('/drafts?status=done', 'GET', undefined, viewer)).data;
    assert.equal(list.total, 1); assert.equal(list.drafts[0].file_count, 1); assert.equal(list.drafts[0].link_count, 1); assert.equal(list.counts.done, 1);
    assert.equal((await request(`/draft-links/${link.data.link.id}`, 'DELETE', undefined, viewer)).status, 403);
    assert.equal((await request(`/drafts/${id}`, 'DELETE', undefined, admin)).status, 200);
    assert.equal((await request(`/drafts/${id}`, 'GET', undefined, admin)).status, 404);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); }
});
