import { koreaDate, transaction } from './db.mjs';
import { storeUpload, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile, readStoredFile } from './uploads.mjs';
import { createDraftMailer, initializeDraftMail, readContacts, validateContacts } from './draft-mail.mjs';
import { draftPdf, draftDocx, draftHwpx, exportFormats } from './draft-export.mjs';

// 업무기안: 간단 양식(제목·기안일·기안자·내용) + 첨부파일 + 참고 링크 + 진행 상태.
// 모든 사용자가 열람하고 편집자·관리자가 작성·수정·삭제한다. 상태가 '작성 중'이 아니면 PDF·Word·한글 문서로 저장할 수 있다.
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const id = value => { if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail(400, '번호를 확인해 주세요.'); return Number(value); };
const text = (value, label, max, required = false) => {
  if (value != null && typeof value !== 'string') throw fail(400, `${label} 형식을 확인해 주세요.`);
  const result = (value ?? '').trim();
  if (required && !result) throw fail(400, `${label}을(를) 입력해 주세요.`);
  if (result.length > max) throw fail(400, `${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return result;
};
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(400, `${label}을(를) 확인해 주세요.`);
  return value;
};
export const draftStatuses = { writing: '작성 중', done: '완료', submitted: '상신', approved: '승인', rejected: '반려' };
const status = value => { if (!Object.hasOwn(draftStatuses, value)) throw fail(400, '진행 상태를 확인해 주세요.'); return value; };
const linkUrl = value => {
  let url = text(value, '링크 주소', 2000, true);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  let parsed; try { parsed = new URL(url); } catch { throw fail(400, '링크 주소를 확인해 주세요.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw fail(400, 'http:// 또는 https:// 로 시작하는 웹 주소만 저장할 수 있습니다.');
  return parsed.href;
};
// 파일 이름에 쓸 수 없는 문자는 바꾸고 길이를 줄인다.
const safeName = value => String(value).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '업무기안';

export function initializeDrafts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL, draft_date TEXT NOT NULL, drafter TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'writing' CHECK(status IN ('writing','done','submitted','approved','rejected')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drafts_date ON drafts(draft_date DESC,id DESC);
  CREATE TABLE IF NOT EXISTS draft_links (
    id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS draft_links_draft ON draft_links(draft_id,id);
  CREATE TABLE IF NOT EXISTS draft_files (
    id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS draft_files_draft ON draft_files(draft_id);`);
  // 승인 요청자(메일 받는 사람 1명)와 참조(CC) 목록. 설정의 '업무기안 메일 계정' 목록에서 고른다.
  const columns = new Set(db.prepare('PRAGMA table_info(drafts)').all().map(c => c.name));
  if (!columns.has('approver_email')) db.exec("ALTER TABLE drafts ADD COLUMN approver_email TEXT NOT NULL DEFAULT ''");
  if (!columns.has('cc_emails')) db.exec("ALTER TABLE drafts ADD COLUMN cc_emails TEXT NOT NULL DEFAULT '[]'");
  initializeDraftMail(db);
}
const ccList = value => { try { const list = JSON.parse(value ?? '[]'); return Array.isArray(list) ? list.filter(e => typeof e === 'string') : []; } catch { return []; } };

export function registerDrafts(app, { db, requireRole, upload, dataDir, mailPollMs }) {
  const edit = requireRole(['admin', 'editor']), admin = requireRole(['admin']);
  const mailer = createDraftMailer({ db, dataDir });
  if (mailPollMs !== 0) mailer.start(mailPollMs);
  app.locals.draftMailer = mailer;
  const draft = value => {
    const row = db.prepare('SELECT d.*,cu.name created_by_name,uu.name updated_by_name FROM drafts d LEFT JOIN users cu ON cu.id=d.created_by LEFT JOIN users uu ON uu.id=d.updated_by WHERE d.id=?').get(id(value));
    if (!row) throw fail(404, '업무기안을 찾을 수 없습니다.');
    return { ...row, cc_emails: ccList(row.cc_emails) };
  };
  const link = value => { const row = db.prepare('SELECT * FROM draft_links WHERE id=?').get(id(value)); if (!row) throw fail(404, '링크를 찾을 수 없습니다.'); return row; };
  const draftFile = value => { const file = getStoredFile(db, 'draft_files', id(value)); if (!file) throw fail(404, '첨부파일을 찾을 수 없습니다.'); return file; };
  const touch = (draftId, userId) => db.prepare('UPDATE drafts SET version=version+1,updated_by=?,updated_at=? WHERE id=?').run(userId, now(), draftId);
  const links = draftId => db.prepare('SELECT id,name,url,created_at FROM draft_links WHERE draft_id=? ORDER BY id').all(draftId);
  const files = draftId => db.prepare('SELECT id,name,size,created_at FROM draft_files WHERE draft_id=? ORDER BY id').all(draftId);
  // 승인 요청자·CC는 설정의 계정 목록에서만 고른다(목록에서 빠진 계정도 이미 저장된 기안에서는 그대로 둘 수 있다).
  const recipientsInput = (body, original) => {
    const allowed = new Set([...readContacts(db).map(c => c.email), ...(original ? [original.approver_email, ...original.cc_emails] : [])].filter(Boolean));
    const approver = String(body.approver_email ?? '').trim().toLowerCase();
    if (approver && !allowed.has(approver)) throw fail(400, '승인 요청자는 등록된 계정 중에서 골라 주세요.');
    const raw = body.cc_emails == null ? [] : body.cc_emails;
    if (!Array.isArray(raw) || raw.length > 20) throw fail(400, 'CC를 확인해 주세요.');
    const cc = [...new Set(raw.map(e => String(e).trim().toLowerCase()).filter(e => e && e !== approver))];
    if (cc.some(e => !allowed.has(e))) throw fail(400, 'CC는 등록된 계정 중에서 골라 주세요.');
    return { approver_email: approver, cc_emails: JSON.stringify(cc) };
  };
  const input = (body, original) => ({
    title: text(body.title, '제목', 200, true), draft_date: date(body.draft_date, '기안일'), drafter: text(body.drafter, '기안자', 100),
    content: text(body.content, '내용', 50000), status: status(body.status ?? 'writing'), ...recipientsInput(body, original),
  });

  app.get('/api/drafts', (req, res) => {
    const clauses = [], params = [];
    const q = text(req.query.q, '검색어', 200);
    if (q) { const term = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; clauses.push("(d.title LIKE ? ESCAPE '\\' OR d.drafter LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')"); params.push(term, term, term); }
    if (req.query.status) { clauses.push('d.status=?'); params.push(status(req.query.status)); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const page = req.query.page == null ? 1 : id(req.query.page), pageSize = 20;
    const total = db.prepare(`SELECT COUNT(*) n FROM drafts d ${where}`).get(...params).n;
    const drafts = db.prepare(`SELECT d.id,d.title,d.draft_date,d.drafter,d.status,d.updated_at,uu.name updated_by_name,
      (SELECT COUNT(*) FROM draft_files f WHERE f.draft_id=d.id) file_count,
      (SELECT COUNT(*) FROM draft_links l WHERE l.draft_id=d.id) link_count,
      (SELECT m.status FROM draft_mails m WHERE m.draft_id=d.id ORDER BY m.id DESC LIMIT 1) mail_status,
      (SELECT m.receipt FROM draft_mails m WHERE m.draft_id=d.id ORDER BY m.id DESC LIMIT 1) mail_receipt
      FROM drafts d LEFT JOIN users uu ON uu.id=d.updated_by ${where} ORDER BY d.draft_date DESC,d.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    const counts = Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM drafts GROUP BY status').all().map(row => [row.status, row.n]));
    res.json({ drafts, total, page, page_size: pageSize, counts });
  });
  app.get('/api/drafts/:id', (req, res) => { const row = draft(req.params.id); res.json({ draft: row, links: links(row.id), files: files(row.id), mails: mailer.mailsFor(row.id), mail_helper: mailer.helper() }); });
  app.post('/api/drafts', edit, (req, res) => {
    const data = input(req.body), stamp = now();
    const result = db.prepare(`INSERT INTO drafts(${Object.keys(data).join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(Object.keys(data).length + 4).fill('?').join(',')})`).run(...Object.values(data), req.user.id, req.user.id, stamp, stamp);
    res.status(201).json({ draft: draft(result.lastInsertRowid) });
  });
  app.put('/api/drafts/:id', edit, (req, res) => {
    const data = input(req.body, draft(req.params.id));
    transaction(db, () => {
      const original = draft(req.params.id);
      if (original.version !== Number(req.body.version)) throw fail(409, '다른 사용자가 먼저 수정했습니다. 업무기안을 다시 열어 주세요.');
      db.prepare(`UPDATE drafts SET ${Object.keys(data).map(key => key + '=?').join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...Object.values(data), req.user.id, now(), original.id);
    });
    res.json({ draft: draft(req.params.id) });
  });
  app.delete('/api/drafts/:id', edit, (req, res) => {
    const row = draft(req.params.id);
    transaction(db, () => {
      for (const file of db.prepare('SELECT id FROM draft_files WHERE draft_id=?').all(row.id)) deleteUploadChunks(db, 'draft_files', file.id);
      db.prepare('DELETE FROM drafts WHERE id=?').run(row.id);
    });
    res.json({ ok: true, id: row.id, title: row.title });
  });

  // 참고 링크(URL)
  app.post('/api/drafts/:id/links', edit, (req, res) => {
    const row = draft(req.params.id), url = linkUrl(req.body.url);
    const name = text(req.body.name, '링크 이름', 200) || (() => { const parsed = new URL(url); return (parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname)).slice(0, 200); })();
    const created = transaction(db, () => { const result = db.prepare('INSERT INTO draft_links(draft_id,name,url,created_at) VALUES(?,?,?,?)').run(row.id, name, url, now()); touch(row.id, req.user.id); return Number(result.lastInsertRowid); });
    res.status(201).json({ link: link(created) });
  });
  app.delete('/api/draft-links/:id', edit, (req, res) => {
    const row = link(req.params.id);
    transaction(db, () => { db.prepare('DELETE FROM draft_links WHERE id=?').run(row.id); touch(row.draft_id, req.user.id); });
    res.json({ ok: true, link: row });
  });

  // 첨부파일
  app.post('/api/drafts/:id/files', edit, (req, res, next) => { draft(req.params.id); next(); }, upload, async (req, res) => {
    if (!req.file) throw fail(400, '첨부할 파일을 선택해 주세요.');
    try {
      const row = draft(req.params.id);
      const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const name = (decoded.includes('�') ? req.file.originalname : decoded).replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 240);
      if (!name) throw fail(400, '파일 이름을 확인해 주세요.');
      const fileId = await storeUpload(db, 'draft_files', req.file, fileId => {
        db.prepare('INSERT INTO draft_files(id,draft_id,name,size,bytes,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId, row.id, name, req.file.size, Buffer.alloc(0), req.user.id, now());
        touch(row.id, req.user.id);
        return fileId;
      });
      res.status(201).json({ id: fileId, file: { id: fileId, name } });
    } finally { discardUpload(req.file); }
  });
  app.get('/api/draft-files/:id/download', (req, res) => {
    const file = draftFile(req.params.id);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    sendStoredFile(db, 'draft_files', file, res);
  });
  app.delete('/api/draft-files/:id', edit, (req, res) => {
    const file = draftFile(req.params.id);
    transaction(db, () => { deleteUploadChunks(db, 'draft_files', file.id); db.prepare('DELETE FROM draft_files WHERE id=?').run(file.id); touch(file.parent_id, req.user.id); });
    res.json({ ok: true, file: { id: file.id, name: file.name } });
  });

  // 업무기안 메일 계정 목록(승인 요청자·CC 후보): 모두 조회, 관리자만 수정
  app.get('/api/draft-contacts', (_req, res) => res.json({ contacts: readContacts(db) }));
  app.put('/api/draft-contacts', admin, (req, res) => {
    const contacts = validateContacts(req.body?.contacts);
    if (!contacts.length) throw fail(400, '계정을 하나 이상 등록해 주세요.');
    db.prepare("INSERT INTO app_settings(key,value) VALUES('draft_contacts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(contacts));
    res.json({ contacts });
  });

  // 승인 요청 메일 보내기: 이 PC의 Outlook 발송 도우미가 실제로 보낸다(server/draft-mail.mjs).
  app.post('/api/drafts/:id/mail', edit, async (req, res) => {
    const row = draft(req.params.id);
    if (row.version !== Number(req.body?.version)) throw Object.assign(fail(409, '기안이 그 사이 수정되었습니다. 창을 다시 연 뒤 보내 주세요.'), { expose: true });
    if (row.status === 'writing') throw Object.assign(fail(409, "작성 중인 기안은 보낼 수 없습니다. 상태를 바꿔 저장한 뒤 보내 주세요."), { expose: true });
    if (!row.approver_email) throw Object.assign(fail(400, '승인 요청자를 골라 저장한 뒤 보내 주세요.'), { expose: true });
    const names = new Map(readContacts(db).map(c => [c.email, c.name]));
    const person = email => ({ email, name: names.get(email) ?? email.split('@')[0] });
    const data = { ...row, links: links(row.id), files: files(row.id), printed_on: koreaDate() };
    const pdf = await draftPdf(data);
    const mailId = mailer.queue({ draft: row, links: data.links, files: data.files, approver: person(row.approver_email), cc: row.cc_emails.map(person), pdf,
      pdfName: `${safeName(row.title)}_${row.draft_date}.pdf`, readFile: file => readStoredFile(db, 'draft_files', getStoredFile(db, 'draft_files', file.id)), userId: req.user.id });
    try { mailer.poll(); } catch {}
    res.status(201).json({ id: mailId, draft: { id: row.id, title: row.title }, mails: mailer.mailsFor(row.id), mail_helper: mailer.helper() });
  });
  app.post('/api/draft-mails/:id/cancel', edit, (req, res) => {
    const mail = mailer.cancel(id(req.params.id));
    res.json({ ok: true, draft: { id: mail.draft_id, title: mail.subject } });
  });

  // 문서로 저장: ?format=pdf|docx|hwpx
  app.get('/api/drafts/:id/export', async (req, res) => {
    const row = draft(req.params.id), format = String(req.query.format ?? 'pdf');
    const kind = exportFormats[format];
    if (!kind) throw fail(400, '저장 형식은 PDF, Word, 한글 중에서 골라 주세요.');
    if (row.status === 'writing') throw Object.assign(fail(409, "작성 중인 기안은 문서로 저장할 수 없습니다. 상태를 '완료'로 바꾼 뒤 저장해 주세요."), { expose: true });
    const data = { ...row, links: links(row.id), files: files(row.id), printed_on: koreaDate() };
    const buffer = format === 'pdf' ? await draftPdf(data) : format === 'docx' ? draftDocx(data) : draftHwpx(data);
    const filename = `${safeName(row.title)}_${row.draft_date}.${kind.ext}`;
    res.set({ 'Content-Type': kind.type, 'Content-Length': String(buffer.length), 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="draft.${kind.ext}"; filename*=UTF-8''${encodeURIComponent(filename)}` });
    res.end(buffer);
  });
}
