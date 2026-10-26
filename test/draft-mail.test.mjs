import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { DEFAULT_CONTACTS, mailHtml, validateContacts } from '../server/draft-mail.mjs';

test('contacts validation and mail body escaping', () => {
  assert.deepEqual(validateContacts([{ email: ' JS@GraceCNS.com ', name: ' 신종수 대표님 ' }]), [{ email: 'js@gracecns.com', name: '신종수 대표님' }]);
  assert.throws(() => validateContacts([{ email: 'bad', name: 'x' }]), /메일 주소/);
  assert.throws(() => validateContacts([{ email: 'a@b.co', name: '' }]), /이름/);
  assert.throws(() => validateContacts([{ email: 'a@b.co', name: 'x' }, { email: 'A@b.co', name: 'y' }]), /두 번/);
  const html = mailHtml({ draft: { title: '<script>', draft_date: '2026-10-26', drafter: '김동엽', status: 'done', content: 'a\nb & c' }, links: [{ name: 'L', url: 'https://x.test/?a=1&b=2' }], files: [{ name: 'a.pdf', size: 1 }],
    approver: { email: 'js@gracecns.com', name: '신종수 대표님' }, cc: [{ email: 'dwkang@gracecns.com', name: '강동우 전임' }], attachedFiles: true, skippedFiles: false });
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert.ok(html.includes('a<br>b &amp; c'));
  assert.ok(html.includes('신종수 대표님 &lt;js@gracecns.com&gt;') && html.includes('강동우 전임'));
  assert.ok(html.includes('https://x.test/?a=1&amp;b=2'));
});

test('draft approval mail: approver/CC selection, queue, helper result, read tracking and cancel', async () => {
  const origin = 'http://localhost:3000', dataDir = mkdtempSync(join(tmpdir(), 'portal-draft-mail-'));
  const portal = createPortal({ dataDir, origin, selfCheck: false, draftMailPollMs: 0 });
  const server = portal.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + path, { method, headers: { Origin: origin, 'X-Portal-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  const mailer = portal.app.locals.draftMailer, outbox = join(dataDir, 'mailer', 'outbox');
  try {
    const admin = (await request('/auth/setup', 'POST', { token: readFileSync(portal.tokenPath, 'utf8'), name: '관리자', username: 'admin', email: 'admin@example.test', password: 'test-password-1234' })).cookie;
    await request('/users', 'POST', { name: '편집자', username: 'editor', email: 'editor@example.test', password: 'test-password-1234', role: 'editor' }, admin);
    await request('/users', 'POST', { name: '조회자', username: 'viewer', email: 'viewer@example.test', password: 'test-password-1234', role: 'viewer' }, admin);
    const editor = (await request('/auth/login', 'POST', { username: 'editor', password: 'test-password-1234' })).cookie;
    const viewer = (await request('/auth/login', 'POST', { username: 'viewer', password: 'test-password-1234' })).cookie;

    // 계정 목록: 기본 3개, 관리자만 수정
    assert.deepEqual((await request('/draft-contacts', 'GET', undefined, viewer)).data.contacts, DEFAULT_CONTACTS);
    assert.equal((await request('/draft-contacts', 'PUT', { contacts: DEFAULT_CONTACTS }, editor)).status, 403);
    assert.equal((await request('/draft-contacts', 'PUT', { contacts: [] }, admin)).status, 400);

    // 승인 요청자·CC는 목록에서만, CC에서 승인 요청자는 빠진다
    assert.equal((await request('/drafts', 'POST', { title: 'x', draft_date: '2026-10-26', approver_email: 'other@example.com' }, editor)).status, 400);
    assert.equal((await request('/drafts', 'POST', { title: 'x', draft_date: '2026-10-26', cc_emails: ['other@example.com'] }, editor)).status, 400);
    const created = await request('/drafts', 'POST', { title: '장비 구매 기안', draft_date: '2026-10-26', drafter: '김동엽', content: '구매 요청', approver_email: 'JS@gracecns.com', cc_emails: ['js@gracecns.com', 'dwkang@gracecns.com'] }, editor);
    assert.equal(created.status, 201);
    const draft = created.data.draft;
    assert.equal(draft.approver_email, 'js@gracecns.com'); assert.deepEqual(draft.cc_emails, ['dwkang@gracecns.com']);

    // 작성 중이면 보낼 수 없음, 조회자는 보낼 수 없음, 버전이 다르면 거부
    assert.equal((await request(`/drafts/${draft.id}/mail`, 'POST', { version: draft.version }, editor)).status, 409);
    const done = (await request(`/drafts/${draft.id}`, 'PUT', { ...draft, status: 'done', version: draft.version }, editor)).data.draft;
    assert.deepEqual(done.cc_emails, ['dwkang@gracecns.com']);
    assert.equal((await request(`/drafts/${draft.id}/mail`, 'POST', { version: done.version }, viewer)).status, 403);
    assert.equal((await request(`/drafts/${draft.id}/mail`, 'POST', { version: done.version - 1 }, editor)).status, 409);
    const sent = await request(`/drafts/${draft.id}/mail`, 'POST', { version: done.version }, editor);
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    const mailId = sent.data.id;
    assert.equal(sent.data.mail_helper.running, false);
    const job = JSON.parse(readFileSync(join(outbox, `mail-${mailId}`, 'job.json'), 'utf8'));
    assert.equal(job.subject, `[업무기안] 장비 구매 기안 (No.${draft.id}-1)`);
    assert.deepEqual(job.to, [{ email: 'js@gracecns.com', name: '신종수 대표님' }]);
    assert.deepEqual(job.cc, [{ email: 'dwkang@gracecns.com', name: '강동우 전임' }]);
    assert.equal(job.read_receipt, true);
    assert.deepEqual(job.attachments, ['files/장비 구매 기안_2026-10-26.pdf']);
    assert.equal(readFileSync(join(outbox, `mail-${mailId}`, job.attachments[0])).subarray(0, 5).toString(), '%PDF-');
    assert.ok(job.html.includes('구매 요청'));

    let detail = (await request(`/drafts/${draft.id}`, 'GET', undefined, viewer)).data;
    assert.equal(detail.mails[0].status, 'queued');
    assert.deepEqual(detail.mails[0].recipients.map(r => [r.kind, r.email, r.receipt]), [['to', 'js@gracecns.com', 'pending'], ['cc', 'dwkang@gracecns.com', 'pending']]);

    // 도우미 흉내: 발송 결과 → 보냄(접수중)
    writeFileSync(join(dataDir, 'mailer', 'heartbeat.json'), JSON.stringify({ at: new Date().toISOString(), account: 'dykim@gracecns.com' }));
    writeFileSync(join(outbox, `mail-${mailId}`, 'result.json'), '﻿' + JSON.stringify({ ok: true, sent_at: '2026-10-26T01:00:00.000Z', account: 'dykim@gracecns.com' }));
    mailer.poll();
    assert.equal(existsSync(join(outbox, `mail-${mailId}`)), false);
    detail = (await request(`/drafts/${draft.id}`, 'GET', undefined, viewer)).data;
    assert.deepEqual([detail.mails[0].status, detail.mails[0].receipt, detail.mails[0].account], ['sent', 'pending', 'dykim@gracecns.com']);
    assert.equal(detail.mail_helper.running, true);
    const tracking = JSON.parse(readFileSync(join(dataDir, 'mailer', 'tracking.json'), 'utf8'));
    assert.deepEqual(tracking.mails.map(m => [m.id, m.tag, m.recipients]), [[mailId, `No.${draft.id}-1`, ['js@gracecns.com', 'dwkang@gracecns.com']]]);
    let list = (await request('/drafts', 'GET', undefined, viewer)).data.drafts[0];
    assert.deepEqual([list.mail_status, list.mail_receipt], ['sent', 'pending']);

    // CC만 읽음 → 아직 접수중, 승인 요청자 읽음 → 접수완료 (읽음은 되돌리지 않음)
    const status = recipients => writeFileSync(join(dataDir, 'mailer', 'status', `mail-${mailId}.json`), JSON.stringify({ id: mailId, recipients }));
    status([{ email: 'DWKANG@gracecns.com', status: 'read', at: '2026-10-26T02:00:00Z' }, { email: 'stranger@example.com', status: 'read' }]);
    mailer.poll();
    detail = (await request(`/drafts/${draft.id}`, 'GET', undefined, viewer)).data;
    assert.equal(detail.mails[0].receipt, 'pending');
    assert.equal(detail.mails[0].recipients[1].receipt, 'read');
    status([{ email: 'js@gracecns.com', status: 'read', at: '2026-10-26T03:00:00Z' }]);
    mailer.poll();
    status([{ email: 'js@gracecns.com', status: 'not_read' }]);
    mailer.poll();
    detail = (await request(`/drafts/${draft.id}`, 'GET', undefined, viewer)).data;
    assert.deepEqual([detail.mails[0].receipt, detail.mails[0].read_at], ['read', '2026-10-26T03:00:00.000Z']);
    list = (await request('/drafts', 'GET', undefined, viewer)).data.drafts[0];
    assert.equal(list.mail_receipt, 'read');
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'mailer', 'tracking.json'), 'utf8')).mails, []);

    // 취소: 대기 중이면 취소, 도우미가 가져간 뒤에는 409
    const second = (await request(`/drafts/${draft.id}/mail`, 'POST', { version: done.version }, editor)).data.id;
    assert.equal((await request(`/draft-mails/${second}/cancel`, 'POST', {}, editor)).status, 200);
    assert.equal(existsSync(join(outbox, `mail-${second}`)), false);
    assert.equal((await request(`/draft-mails/${second}/cancel`, 'POST', {}, editor)).status, 409);
    const third = (await request(`/drafts/${draft.id}/mail`, 'POST', { version: done.version }, editor)).data.id;
    assert.equal(JSON.parse(readFileSync(join(outbox, `mail-${third}`, 'job.json'), 'utf8')).tag, `No.${draft.id}-3`);
    renameSync(join(outbox, `mail-${third}`, 'job.json'), join(outbox, `mail-${third}`, 'job.sending'));
    assert.equal((await request(`/draft-mails/${third}/cancel`, 'POST', {}, editor)).status, 409);
    writeFileSync(join(outbox, `mail-${third}`, 'result.json'), JSON.stringify({ ok: false, error: 'Outlook send failed: test' }));
    mailer.poll();
    detail = (await request(`/drafts/${draft.id}`, 'GET', undefined, viewer)).data;
    assert.deepEqual(detail.mails.map(m => m.status), ['failed', 'canceled', 'sent']);
    assert.match(detail.mails[0].error, /test/);

    // 기안을 지우면 메일 기록도 지워진다
    assert.equal((await request(`/drafts/${draft.id}`, 'DELETE', undefined, editor)).status, 200);
    assert.equal(portal.db.prepare('SELECT COUNT(*) n FROM draft_mails').get().n, 0);
    assert.equal(readdirSync(outbox).length, 0);
  } finally { await new Promise(r => server.close(r)); portal.db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
