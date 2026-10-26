import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 업무기안 승인 요청 메일: 포털은 메일 서버에 직접 접속하지 않는다.
// 포털이 데이터 폴더의 mailer/outbox에 발송 요청(job.json + 첨부)을 남기면, 사용자가 로그인한 화면에서 실행되는
// Outlook 발송 도우미(scripts/windows-outlook-mailer.ps1)가 이 PC의 Outlook으로 읽음 확인을 요청해 보내고
// 결과(result.json)를 남긴다. 도우미는 보낸 메일의 수신자별 추적 정보(읽음)와 받은편지함의 읽음 확인 메일을 살펴
// mailer/status에 기록하고, 포털은 이를 읽어 승인 요청자가 읽었으면 '접수완료', 아니면 '접수중'으로 표시한다.

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const now = () => new Date().toISOString();
export const DEFAULT_CONTACTS = [
  { email: 'js@gracecns.com', name: '신종수 대표님' },
  { email: 'dykim@gracecns.com', name: '김동엽 수석' },
  { email: 'dwkang@gracecns.com', name: '강동우 전임' }
];
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const HELPER_STALE_MS = 120_000;
const TRACK_DAYS = 60;

export function validateContacts(value) {
  if (!Array.isArray(value) || value.length > 30) throw fail(400, '계정 목록을 확인해 주세요(최대 30개).');
  const seen = new Set();
  return value.map(item => {
    const email = String(item?.email ?? '').trim().toLowerCase(), name = String(item?.name ?? '').trim();
    if (!EMAIL.test(email) || email.length > 200) throw fail(400, `메일 주소를 확인해 주세요: ${email || '(빈 칸)'}`);
    if (!name || name.length > 50) throw fail(400, `${email}의 이름(직함)을 50자 이내로 입력해 주세요.`);
    if (seen.has(email)) throw fail(400, `같은 메일 주소가 두 번 있습니다: ${email}`);
    seen.add(email);
    return { email, name };
  });
}

export function initializeDraftMail(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS draft_mails (
    id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    tag TEXT NOT NULL, subject TEXT NOT NULL,
    approver_email TEXT NOT NULL, approver_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','canceled')),
    receipt TEXT NOT NULL DEFAULT 'pending' CHECK(receipt IN ('pending','read','not_read')),
    error TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]',
    requested_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, sent_at TEXT, read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS draft_mails_draft ON draft_mails(draft_id,id);
  CREATE TABLE IF NOT EXISTS draft_mail_recipients (
    mail_id INTEGER NOT NULL REFERENCES draft_mails(id) ON DELETE CASCADE,
    email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('to','cc')),
    receipt TEXT NOT NULL DEFAULT 'pending' CHECK(receipt IN ('pending','read','not_read')), receipt_at TEXT,
    PRIMARY KEY(mail_id,email)
  );`);
}

export function readContacts(db) {
  try {
    const raw = db.prepare("SELECT value FROM app_settings WHERE key='draft_contacts'").get()?.value;
    if (raw == null) return DEFAULT_CONTACTS.map(c => ({ ...c }));
    return validateContacts(JSON.parse(raw));
  } catch { return DEFAULT_CONTACTS.map(c => ({ ...c })); }
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statusLabel = { writing: '작성 중', done: '완료', submitted: '상신', approved: '승인', rejected: '반려' };

export function mailHtml({ draft, links, files, approver, cc, attachedFiles, skippedFiles }) {
  const cell = 'border:1px solid #d0d7d4;padding:8px 12px;vertical-align:top;';
  const head = cell + 'background:#eef4f1;width:110px;font-weight:bold;white-space:nowrap;';
  const rows = [['제목', esc(draft.title)], ['기안일', esc(draft.draft_date)], ['기안자', esc(draft.drafter || '—')], ['진행 상태', esc(statusLabel[draft.status] ?? draft.status)],
    ['승인 요청자', esc(`${approver.name} <${approver.email}>`)], ['참조(CC)', cc.length ? cc.map(c => esc(`${c.name} <${c.email}>`)).join('<br>') : '—']];
  const content = esc(draft.content || '(내용 없음)').replace(/\r?\n/g, '<br>');
  const linkList = links.length ? `<ul style="margin:4px 0;padding-left:20px;">${links.map(l => `<li><a href="${esc(l.url)}">${esc(l.name)}</a> <span style="color:#667;">${esc(l.url)}</span></li>`).join('')}</ul>` : '<p style="margin:4px 0;color:#667;">없음</p>';
  const fileList = files.length ? `<ul style="margin:4px 0;padding-left:20px;">${files.map(f => `<li>${esc(f.name)}${skippedFiles ? '' : ' (첨부)'}</li>`).join('')}</ul>${skippedFiles ? `<p style="margin:4px 0;color:#a33;">첨부파일 합계가 ${MAX_ATTACH_BYTES / 1048576}MB를 넘어 메일에는 붙이지 않았습니다. 필요하면 기안자에게 요청해 주세요.</p>` : ''}` : '<p style="margin:4px 0;color:#667;">없음</p>';
  return `<div style="font-family:'Malgun Gothic','맑은 고딕',sans-serif;font-size:14px;color:#172b29;line-height:1.6;">
<p>${esc(approver.name)}께,</p><p>아래 업무기안의 검토와 승인을 요청드립니다.${attachedFiles ? ' 기안서 PDF를 첨부했습니다.' : ''}</p>
<table style="border-collapse:collapse;margin:12px 0;min-width:420px;">${rows.map(([k, v]) => `<tr><th style="${head}text-align:left;">${k}</th><td style="${cell}">${v}</td></tr>`).join('')}</table>
<h3 style="font-size:15px;margin:16px 0 6px;">내용</h3><div style="border:1px solid #d0d7d4;padding:10px 12px;">${content}</div>
<h3 style="font-size:15px;margin:16px 0 6px;">참고 링크</h3>${linkList}
<h3 style="font-size:15px;margin:16px 0 6px;">첨부파일</h3>${fileList}
<p style="margin-top:20px;color:#667;font-size:12px;">이 메일은 DYKIM PORTAL 업무기안에서 보냈습니다. 메일을 열 때 읽음 확인을 묻는 창이 나오면 '예'를 눌러 주세요. 접수 확인에 사용됩니다.</p></div>`;
}

// 첨부 파일 이름: Windows에서 쓸 수 없는 문자를 바꾸고 같은 이름은 번호를 붙인다.
function attachmentName(name, used) {
  let base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 150) || 'file';
  let candidate = base, n = 2;
  while (used.has(candidate.toLowerCase())) { const dot = base.lastIndexOf('.'); candidate = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`; n++; }
  used.add(candidate.toLowerCase());
  return candidate;
}

const writeJson = (path, value) => { const temp = path + '.tmp'; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

export function createDraftMailer({ db, dataDir }) {
  const root = join(dataDir, 'mailer'), outbox = join(root, 'outbox'), statusDir = join(root, 'status');
  const ensure = () => { mkdirSync(outbox, { recursive: true }); mkdirSync(statusDir, { recursive: true }); };
  const jobDir = mailId => join(outbox, `mail-${mailId}`);

  function helper() {
    try {
      const beat = readJson(join(root, 'heartbeat.json'));
      const at = Date.parse(beat.at);
      return { running: Number.isFinite(at) && Date.now() - at < HELPER_STALE_MS, at: Number.isFinite(at) ? new Date(at).toISOString() : null, account: String(beat.account ?? ''), error: String(beat.error ?? '') };
    } catch { return { running: false, at: null, account: '', error: '' }; }
  }

  // 발송 요청 만들기: 첨부를 먼저 쓰고 job.json을 마지막에 써서, 도우미가 반쯤 만든 요청을 집지 않게 한다.
  function queue({ draft, links, files, approver, cc, pdf, pdfName, readFile, userId }) {
    ensure();
    const seq = db.prepare('SELECT COUNT(*) n FROM draft_mails WHERE draft_id=?').get(draft.id).n + 1;
    const tag = `No.${draft.id}-${seq}`;
    const subject = `[업무기안] ${draft.title} (${tag})`.slice(0, 240);
    const total = files.reduce((sum, f) => sum + f.size, 0), skippedFiles = total > MAX_ATTACH_BYTES;
    const mailId = Number(db.prepare('INSERT INTO draft_mails(draft_id,tag,subject,approver_email,approver_name,requested_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(draft.id, tag, subject, approver.email, approver.name, userId, now()).lastInsertRowid);
    const addRecipient = db.prepare('INSERT INTO draft_mail_recipients(mail_id,email,name,kind) VALUES(?,?,?,?)');
    addRecipient.run(mailId, approver.email, approver.name, 'to');
    for (const c of cc) addRecipient.run(mailId, c.email, c.name, 'cc');
    const temp = jobDir(mailId) + '.tmp';
    try {
      rmSync(temp, { recursive: true, force: true });
      mkdirSync(join(temp, 'files'), { recursive: true });
      const used = new Set(), attachments = [];
      const pdfFile = attachmentName(pdfName, used); writeFileSync(join(temp, 'files', pdfFile), pdf); attachments.push(pdfFile);
      if (!skippedFiles) for (const file of files) { const name = attachmentName(file.name, used); writeFileSync(join(temp, 'files', name), readFile(file)); attachments.push(name); }
      const html = mailHtml({ draft, links, files, approver, cc, attachedFiles: true, skippedFiles });
      writeJson(join(temp, 'job.json'), { id: mailId, tag, subject, to: [approver], cc, html, attachments: attachments.map(name => 'files/' + name), read_receipt: true, created_at: now() });
      renameSync(temp, jobDir(mailId));
      db.prepare('UPDATE draft_mails SET attachments=? WHERE id=?').run(JSON.stringify(attachments), mailId);
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      db.prepare("UPDATE draft_mails SET status='failed',error=? WHERE id=?").run('발송 요청 파일을 만들지 못했습니다: ' + error.message, mailId);
      throw fail(500, '발송 요청을 만들지 못했습니다. 데이터 폴더 쓰기 권한을 확인해 주세요.');
    }
    return mailId;
  }

  function cancel(mailId) {
    const row = db.prepare('SELECT * FROM draft_mails WHERE id=?').get(mailId);
    if (!row) throw fail(404, '발송 기록을 찾을 수 없습니다.');
    if (row.status !== 'queued') throw fail(409, '발송 대기 중인 메일만 취소할 수 있습니다.');
    const dir = jobDir(mailId);
    try { renameSync(join(dir, 'job.json'), join(dir, 'job.canceled')); }
    catch { if (existsSync(dir)) throw fail(409, 'Outlook 발송 도우미가 이미 보내는 중입니다. 잠시 뒤 결과를 확인해 주세요.'); }
    rmSync(dir, { recursive: true, force: true });
    db.prepare("UPDATE draft_mails SET status='canceled' WHERE id=?").run(mailId);
    return row;
  }

  const rank = { pending: 0, not_read: 1, read: 2 };
  function applyStatus(mailId, recipients) {
    const mail = db.prepare('SELECT * FROM draft_mails WHERE id=?').get(mailId);
    if (!mail) return;
    const current = db.prepare('SELECT * FROM draft_mail_recipients WHERE mail_id=?').all(mailId);
    const update = db.prepare('UPDATE draft_mail_recipients SET receipt=?,receipt_at=? WHERE mail_id=? AND email=?');
    for (const item of Array.isArray(recipients) ? recipients : []) {
      const email = String(item?.email ?? '').trim().toLowerCase(), status = item?.status;
      if (!['read', 'not_read'].includes(status)) continue;
      const row = current.find(r => r.email === email);
      if (!row || rank[status] <= rank[row.receipt]) continue;
      const at = Number.isFinite(Date.parse(item.at)) ? new Date(item.at).toISOString() : now();
      update.run(status, at, mailId, email);
      if (email === mail.approver_email) db.prepare('UPDATE draft_mails SET receipt=?,read_at=? WHERE id=?').run(status, at, mailId);
    }
  }

  let lastTracking = '';
  function poll() {
    if (!db.isOpen) return;
    ensure();
    cleanupTemp(outbox);
    // 1) 발송 결과
    for (const name of readdirSync(outbox)) {
      const match = /^mail-(\d+)$/.exec(name); if (!match) continue;
      const dir = join(outbox, name), mailId = Number(match[1]);
      const mail = db.prepare('SELECT id,status FROM draft_mails WHERE id=?').get(mailId);
      if (!mail) { if (!existsSync(join(dir, 'job.sending'))) rmSync(dir, { recursive: true, force: true }); continue; }
      if (!existsSync(join(dir, 'result.json'))) continue;
      let result; try { result = readJson(join(dir, 'result.json')); } catch { continue; }
      if (mail.status === 'queued') {
        if (result.ok) db.prepare("UPDATE draft_mails SET status='sent',sent_at=?,account=?,error='' WHERE id=?").run(Number.isFinite(Date.parse(result.sent_at)) ? new Date(result.sent_at).toISOString() : now(), String(result.account ?? '').slice(0, 200), mailId);
        else db.prepare("UPDATE draft_mails SET status='failed',error=? WHERE id=?").run(String(result.error ?? '알 수 없는 오류').slice(0, 1000), mailId);
      }
      rmSync(dir, { recursive: true, force: true });
    }
    // 2) 읽음 정보
    for (const name of readdirSync(statusDir)) {
      const match = /^mail-(\d+)\.json$/.exec(name); if (!match) continue;
      try { applyStatus(Number(match[1]), readJson(join(statusDir, name)).recipients); } catch {}
      rmSync(join(statusDir, name), { force: true });
    }
    // 3) 도우미가 살펴볼 메일 목록(보낸 지 60일 이내, 아직 읽음 확인이 끝나지 않은 메일)
    const since = new Date(Date.now() - TRACK_DAYS * 86400000).toISOString();
    const mails = db.prepare(`SELECT id,tag,subject,sent_at FROM draft_mails m WHERE status='sent' AND sent_at>=? AND EXISTS(SELECT 1 FROM draft_mail_recipients r WHERE r.mail_id=m.id AND r.receipt!='read') ORDER BY id`).all(since);
    const recipients = db.prepare('SELECT email,kind FROM draft_mail_recipients WHERE mail_id=? ORDER BY kind DESC,email');
    const tracking = JSON.stringify({ mails: mails.map(m => ({ ...m, recipients: recipients.all(m.id).map(r => r.email) })) });
    if (tracking !== lastTracking || !existsSync(join(root, 'tracking.json'))) { writeJson(join(root, 'tracking.json'), JSON.parse(tracking)); lastTracking = tracking; }
  }

  function mailsFor(draftId) {
    const recipients = db.prepare('SELECT email,name,kind,receipt,receipt_at FROM draft_mail_recipients WHERE mail_id=? ORDER BY kind DESC,rowid');
    return db.prepare('SELECT m.*,u.name requested_by_name FROM draft_mails m LEFT JOIN users u ON u.id=m.requested_by WHERE m.draft_id=? ORDER BY m.id DESC').all(draftId)
      .map(m => ({ ...m, attachments: (() => { try { return JSON.parse(m.attachments); } catch { return []; } })(), recipients: recipients.all(m.id) }));
  }

  // 도우미가 오래 꺼져 있어 남은 요청은 그대로 두고(도우미가 켜지면 보냄), 상태만 화면에 알린다.
  function start(intervalMs = 15_000) {
    const tick = () => { try { poll(); } catch (error) { if (db.isOpen) console.error('draft mail poll failed:', error.message); } };
    tick();
    const timer = setInterval(tick, intervalMs); timer.unref?.();
    return () => clearInterval(timer);
  }

  return { queue, cancel, poll, start, helper, mailsFor, paths: { root, outbox, statusDir } };
}

// 오래된 임시 폴더(만들다 중단된 요청) 정리용: 하루 지난 *.tmp 폴더 삭제
export function cleanupTemp(outbox) {
  try {
    for (const name of readdirSync(outbox)) if (name.endsWith('.tmp')) { const path = join(outbox, name); if (Date.now() - statSync(path).mtimeMs > 86400000) rmSync(path, { recursive: true, force: true }); }
  } catch {}
}
