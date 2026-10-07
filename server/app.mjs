import express from 'express';
import { initializeFeatures, registerFeatures } from './features.mjs';
import { categoryInput, categoryDescendants } from './categories.mjs';
import { initializeWork, registerWork } from './work.mjs';
import { registerReports } from './reports.mjs';
import helmet from 'helmet';
import multer from 'multer';
import { initializeUploadChunks, createUploadMiddleware, storeUpload, purgeOrphanChunks, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile } from './uploads.mjs';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction, scanDeadlines } from './db.mjs';
import { listing } from './listing.mjs';
import { registerBackups, recoverInterruptedRestore } from './backups.mjs';
import { initializeActivity, recordMutation, scanMissing, scanMonthly, activityForUser, activityUnread, readActivity } from './activity.mjs';
import { initializeProjects, registerProjects } from './projects.mjs';
import { registerOperations } from './operations.mjs';
import { registerLeave } from './leave.mjs';
import { createSelfCheck } from './self-check.mjs';
import { registerUsage } from './usage.mjs';
import { initializeTodos, registerTodos } from './todos.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const roles = ['admin', 'editor', 'viewer'];
const statuses = ['active', 'stored', 'repair', 'retired'];
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const menuOrder = value => { try { const order = JSON.parse(value ?? 'null'); return Array.isArray(order) ? order.filter(id => typeof id === 'string') : null; } catch { return null; } };
const publicUser = user => ({ id: user.id, name: user.name, username: user.username, email: user.email, role: user.role, active: Boolean(user.active), created_at: user.created_at, menu_order: menuOrder(user.menu_order) });
function text(value, label, max = 200, required = false) {
  if (value !== undefined && typeof value !== 'string') throw fail(400, `${label} 형식이 올바르지 않습니다.`);
  const result = (value ?? '').trim();
  if ((required && !result) || result.length > max) throw fail(400, `${label} 항목을 확인해 주세요. (최대 ${max}자)`);
  return result;
}
function integer(value, label, min, max) {
  if (value === '' || typeof value === 'boolean' || value === null || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw fail(400, `${label} 값이 올바르지 않습니다.`);
  return Number(value);
}
function date(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw fail(400, '날짜를 확인해 주세요.');
  return value;
}
function email(value) {
  const result = text(value, '이메일', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw fail(400, '이메일을 확인해 주세요.');
  return result;
}
function username(value) {
  const result = text(value, '아이디', 32, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(result)) throw fail(400, '아이디는 영문·숫자로 시작하는 2~32자의 영문, 숫자, 점, 밑줄, 하이픈으로 입력해 주세요.');
  return result;
}
async function passwordHash(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw fail(400, '비밀번호는 12~128자로 입력해 주세요.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(value, salt, 64)).toString('hex')}`;
}
async function passwordMatches(value, encoded) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, expected] = encoded.split(':');
  const actual = await scrypt(value, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function itemData(body, db) {
  if (!['general','it'].includes(body.category) || !statuses.includes(body.status)) throw fail(400, '분류 또는 상태를 확인해 주세요.');
  return {
    name: text(body.name, '물품명', 150, true), asset_code: text(body.asset_code, '관리번호', 80, true),
    category: body.category, status: body.status, quantity: integer(body.quantity, '수량', 0, 1000000),
    location: text(body.location, '위치'), owner: text(body.owner, '담당자'), serial: text(body.serial, '시리얼 번호'),
    description: text(body.description, '설명', 10000), due_date: date(body.due_date), reminder_days: integer(body.reminder_days, '사전 알림 일수', 0, 365), category_id: categoryInput(db, 'items', body.category_id)
  };
}

export function createPortal(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  recoverInterruptedRestore(dataDir);
  const backupDir = resolve(options.backupDir ?? process.env.BACKUP_DIR ?? './backups');
  const db = openDatabase(dataDir);
  initializeFeatures(db);
  initializeUploadChunks(db);
  initializeWork(db);
  initializeTodos(db);
  initializeProjects(db);
  initializeActivity(db);
  const app = express();
  const instanceId = randomBytes(12).toString('hex');
  const maintenance = { restoring: false };
  const origin = new URL(options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000').origin;
  const secure = options.secure ?? process.env.COOKIE_SECURE === 'true';
  if (process.env.NODE_ENV === 'production' && (!secure || !origin.startsWith('https://'))) throw new Error('Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true.');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  const tokenPath = join(dataDir, 'setup-token.txt');
  let setupToken;
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    setupToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : randomBytes(24).toString('hex');
    writeFileSync(tokenPath, setupToken, { mode: 0o600 });
  }
  const dummyHashPromise = passwordHash(randomBytes(24).toString('hex'));
  app.disable('x-powered-by');
  app.use(helmet({ strictTransportSecurity: secure ? undefined : false, contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': secure ? [] : null, 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'] } } }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (req.get('Origin') !== origin || req.get('X-Portal-Request') !== '1')) return res.status(403).json({ error: '요청 출처를 확인할 수 없습니다. 설정된 포털 주소로 접속해 주세요.' });
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, _res, next) => {
    const token = /(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (token) {
      req.sessionHash = hash(token);
      req.user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.active=1').get(req.sessionHash, Date.now());
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    if (maintenance.restoring && req.path !== '/health') return res.status(503).json({ error: '백업 시점으로 복구하는 중입니다. 잠시 후 다시 접속해 주세요.' });
    next();
  });
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  function session(res, user) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, Date.now()+43200000);
    res.cookie('portal_session', token, { ...cookieOptions, maxAge: 43200000 });
  }
  function limiter(req, suffix = '') {
    const keys = [hash(`ip:${req.ip}:${suffix}`)];
    if (typeof req.body.username === 'string') keys.push(hash(`account:${req.body.username.toLowerCase().trim()}:${suffix}`));
    for (const key of keys) {
      const row = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
      if (row && row.reset_at > Date.now() && row.attempts >= 15) throw fail(429, '시도 횟수가 많습니다. 15분 뒤 다시 시도해 주세요.');
    }
    for (const key of keys) db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END').run(key, Date.now()+900000, Date.now(), Date.now());
  }
  const requireAuth = (req, _res, next) => req.user ? next() : next(fail(401, '로그인이 필요합니다.'));
  const requireRole = allowed => (req, _res, next) => allowed.includes(req.user?.role) ? next() : next(fail(403, '이 작업에 대한 권한이 없습니다.'));
  const item = id => { const row = db.prepare('SELECT * FROM items WHERE id=?').get(id); if (!row) throw fail(404, '물품을 찾을 수 없습니다.'); return row; };
  const history = (id, actor, action, detail) => db.prepare('INSERT INTO history(item_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(id, actor, action, detail, now());

  // ok는 웹 서버 응답 여부, database는 SQLite 읽기 확인 결과('ok' 또는 'error')다.
  app.get('/api/health', (_req,res) => { let database='ok'; try { db.prepare('SELECT 1 FROM users LIMIT 1').get(); } catch { database='error'; } res.json({ ok: true, database, version: 3, instance_id: instanceId, restore_result: options.restoreResult ?? null }); });
  app.get('/api/auth/me', (req,res) => res.json({ user: req.user ? publicUser(req.user) : null, setupRequired: Boolean(setupToken) }));
  app.post('/api/auth/setup', async (req,res) => {
    limiter(req, 'setup');
    if (!setupToken) throw fail(409, '초기 설정이 이미 완료되었습니다.');
    if (typeof req.body.token !== 'string' || !timingSafeEqual(Buffer.from(hash(req.body.token)), Buffer.from(hash(setupToken)))) throw fail(403, '초기 설정 코드를 확인해 주세요.');
    const name = text(req.body.name, '이름', 100, true), loginId = username(req.body.username), mail = email(req.body.email), password = await passwordHash(req.body.password);
    const id = transaction(db, () => {
      if (db.prepare('SELECT id FROM users LIMIT 1').get()) throw fail(409, '초기 설정이 이미 완료되었습니다.');
      return Number(db.prepare("INSERT INTO users(name,username,email,password,role,created_at) VALUES(?,?,?,?,'admin',?)").run(name, loginId, mail, password, now()).lastInsertRowid);
    });
    setupToken = null;
    if (existsSync(tokenPath)) unlinkSync(tokenPath);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    session(res,user); res.status(201).json({ user: publicUser(user) });
  });
  app.post('/api/auth/login', async (req,res) => {
    limiter(req);
    const loginId = username(req.body.username);
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(loginId);
    const valid = await passwordMatches(req.body.password, user?.password ?? await dummyHashPromise);
    if (!valid || !user?.active) throw fail(401, '아이디 또는 비밀번호를 확인해 주세요.');
    session(res,user); res.json({ user: publicUser(user) });
  });
  app.use('/api', requireAuth);
  // 메뉴 순서는 로그인한 사용자 계정에 저장해 로그아웃·다른 브라우저에서도 유지한다.
  app.put('/api/auth/menu-order', (req, res) => {
    const order = req.body?.order;
    if (order !== null && (!Array.isArray(order) || order.length > 40 || order.some(id => typeof id !== 'string' || !/^[a-z]{2,24}$/.test(id)) || new Set(order).size !== order.length)) throw fail(400, '메뉴 순서를 확인해 주세요.');
    db.prepare('UPDATE users SET menu_order=? WHERE id=?').run(order === null ? null : JSON.stringify(order), req.user.id);
    res.json({ ok: true, menu_order: order });
  });
  app.use('/api', (req, res, next) => {
    const send = res.json.bind(res);
    res.json = body => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { recordMutation(db, req, body); } catch (error) { console.error('Activity notification failed:', error); }
      }
      return send(body);
    };
    next();
  });
  app.post('/api/auth/logout', (req,res) => { db.prepare('DELETE FROM sessions WHERE hash=?').run(req.sessionHash); res.clearCookie('portal_session',cookieOptions).json({ ok: true }); });
  app.post('/api/auth/password', async (req,res) => {
    limiter(req,'password');
    if (!await passwordMatches(req.body.current, req.user.password)) throw fail(400, '현재 비밀번호가 일치하지 않습니다.');
    const next = await passwordHash(req.body.password);
    transaction(db, () => { db.prepare('UPDATE users SET password=? WHERE id=?').run(next,req.user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id); });
    res.clearCookie('portal_session',cookieOptions).json({ ok: true });
  });
  app.get('/api/users', requireRole(['admin']), (_req,res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser) }));
  app.post('/api/users', requireRole(['admin']), async (req,res) => {
    const name = text(req.body.name,'이름',100,true), loginId=username(req.body.username), mail=email(req.body.email);
    if (!roles.includes(req.body.role)) throw fail(400,'권한을 확인해 주세요.');
    const password=await passwordHash(req.body.password);
    const id=db.prepare('INSERT INTO users(name,username,email,password,role,created_at) VALUES(?,?,?,?,?,?)').run(name,loginId,mail,password,req.body.role,now()).lastInsertRowid;
    res.status(201).json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
  });
  app.put('/api/users/:id', requireRole(['admin']), async (req,res) => {
    const id=integer(req.params.id,'사용자',1,Number.MAX_SAFE_INTEGER);
    const original=db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!original) throw fail(404,'사용자를 찾을 수 없습니다.');
    const name=text(req.body.name,'이름',100,true), loginId=username(req.body.username), mail=email(req.body.email), role=req.body.role;
    if (!roles.includes(role) || typeof req.body.active!=='boolean') throw fail(400,'사용자 설정을 확인해 주세요.');
    if (id===req.user.id && (role!=='admin' || !req.body.active)) throw fail(400,'본인의 관리자 권한을 해제하거나 계정을 비활성화할 수 없습니다.');
    const password=req.body.password ? await passwordHash(req.body.password) : original.password;
    transaction(db,()=>{
      db.prepare('UPDATE users SET name=?,username=?,email=?,role=?,active=?,password=? WHERE id=?').run(name,loginId,mail,role,Number(req.body.active),password,id);
      if (password!==original.password || role!==original.role || !req.body.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    });
    res.json({ok:true});
  });
  app.delete('/api/users/:id', requireRole(['admin']), (req,res) => {
    const id=integer(req.params.id,'사용자',1,Number.MAX_SAFE_INTEGER);
    if(id===req.user.id) throw fail(400,'본인 계정은 삭제할 수 없습니다.');
    if(!db.prepare('SELECT id FROM users WHERE id=?').get(id)) throw fail(404,'사용자를 찾을 수 없습니다.');
    const references=[['items','created_by'],['items','updated_by'],['files','uploaded_by'],['history','actor_id'],['notifications','user_id'],['installations','created_by'],['installations','updated_by'],['installation_files','uploaded_by'],['manuals','uploaded_by'],['work_logs','created_by'],['work_logs','updated_by']];
    if(references.some(([table,column])=>db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(id))) throw fail(409,'작성·수정 이력이 있는 계정은 삭제할 수 없습니다. 계정을 비활성화해 주세요.');
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    res.json({ok:true});
  });
  app.get('/api/items', (req,res) => {
    const clauses=[], params=[];
    const q=text(req.query.q,'검색어',200);
    if(q){ clauses.push("(i.name LIKE ? ESCAPE '\\' OR i.asset_code LIKE ? ESCAPE '\\' OR i.owner LIKE ? ESCAPE '\\' OR i.serial LIKE ? ESCAPE '\\')"); const pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`; params.push(pattern,pattern,pattern,pattern); }
    for(const key of ['category','status']) if(req.query[key]){clauses.push(`i.${key}=?`);params.push(text(req.query[key],key,30));}
    if(req.query.category_id){const ids=categoryDescendants(db,'items',req.query.category_id);clauses.push(`i.category_id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids);}
    if(req.query.from){clauses.push('i.updated_at>=?');params.push(date(req.query.from)+'T00:00:00+09:00'); params[params.length-1]=new Date(params.at(-1)).toISOString();}
    if(req.query.to){clauses.push('i.updated_at<=?');params.push(new Date(date(req.query.to)+'T23:59:59.999+09:00').toISOString());}
    if(req.query.due==='set') clauses.push('i.due_date IS NOT NULL');
    const list=listing(req.query,{name:'i.name COLLATE NOCASE',asset_code:'i.asset_code COLLATE NOCASE',category:'i.category',status:'i.status',owner:'i.owner COLLATE NOCASE',due_date:'i.due_date',updated_at:'i.updated_at',file_count:'file_count'},'updated_at','desc','i.id');
    const page=list.page, limit=list.size;
    const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
    const total=db.prepare(`SELECT COUNT(*) AS n FROM items i ${where}`).get(...params).n;
    const items=db.prepare(`SELECT i.*,u.name AS updated_by_name,(SELECT COUNT(*) FROM files f WHERE f.item_id=i.id) AS file_count FROM items i JOIN users u ON u.id=i.updated_by ${where} ORDER BY ${list.orderBy} LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit);
    res.json({items,total,page,page_size:limit,pages:Math.ceil(total/limit),stats:db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(category='general'),0) AS general,COALESCE(SUM(category='it'),0) AS it,COALESCE(SUM(status='repair'),0) AS repair FROM items").get()});
  });
  app.get('/api/items/:id',(req,res)=>{const current=item(req.params.id);res.json({item:current,files:db.prepare('SELECT id,name,size,created_at FROM files WHERE item_id=? ORDER BY id DESC').all(current.id),history:db.prepare('SELECT h.*,u.name AS actor FROM history h JOIN users u ON u.id=h.actor_id WHERE item_id=? ORDER BY h.id DESC LIMIT 100').all(current.id)});});
  app.post('/api/items',requireRole(['admin','editor']),(req,res)=>{
    const data=itemData(req.body, db),stamp=now();
    const id=transaction(db,()=>{const id=Number(db.prepare(`INSERT INTO items(${Object.keys(data).join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(Object.keys(data).length+4).fill('?').join(',')})`).run(...Object.values(data),req.user.id,req.user.id,stamp,stamp).lastInsertRowid);history(id,req.user.id,'등록',JSON.stringify(data));return id;});
    scanDeadlines(db);res.status(201).json({item:item(id)});
  });
  app.put('/api/items/:id',requireRole(['admin','editor']),(req,res)=>{
    const data=itemData(req.body, db),version=integer(req.body.version,'버전',1,Number.MAX_SAFE_INTEGER);
    transaction(db,()=>{
      const original=item(req.params.id);
      if(original.version!==version) throw fail(409,'다른 사용자가 수정했습니다. 창을 닫고 최신 자료를 다시 열어 주세요.');
      db.prepare(`UPDATE items SET ${Object.keys(data).map(k=>`${k}=?`).join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...Object.values(data),req.user.id,now(),original.id);
      history(original.id,req.user.id,'수정',JSON.stringify(Object.fromEntries(Object.keys(data).filter(k=>data[k]!==original[k]).map(k=>[k,{before:original[k],after:data[k]}]))));
      if(data.due_date!==original.due_date || data.status==='retired') db.prepare('DELETE FROM notifications WHERE item_id=?').run(original.id);
    });
    scanDeadlines(db);res.json({item:item(req.params.id)});
  });
  app.delete('/api/items/:id',requireRole(['admin','editor']),(req,res)=>{
    const current=item(req.params.id);
    transaction(db,()=>{
      for(const file of db.prepare('SELECT id FROM files WHERE item_id=?').all(current.id)) deleteUploadChunks(db,'files',file.id);
      db.prepare('DELETE FROM items WHERE id=?').run(current.id);
    });
    res.json({ok:true});
  });
  const upload=createUploadMiddleware(dataDir);
  app.post('/api/items/:id/files',requireRole(['admin','editor']), (req,res,next)=>{item(req.params.id);next();},upload,async(req,res)=>{
    if(!req.file) throw fail(400,'첨부할 파일을 선택해 주세요.');
    try {
      // Multer exposes multipart filenames as latin1; modern browsers send UTF-8.
      const decoded=Buffer.from(req.file.originalname,'latin1').toString('utf8');
      const name=text((decoded.includes('\uFFFD')?req.file.originalname:decoded).replace(/[\\/\u0000-\u001f\u007f]/g,'_'),'파일명',240,true);
      await storeUpload(db,'files',req.file,fileId=>{
        db.prepare('INSERT INTO files(id,item_id,name,size,bytes,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId,req.params.id,name,req.file.size,Buffer.alloc(0),req.user.id,now());
        db.prepare('UPDATE items SET updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(now(),req.user.id,req.params.id);
        history(req.params.id,req.user.id,'자료 등록',name);
      });
      res.status(201).json({ok:true});
    } finally { discardUpload(req.file); }
  });
  app.get('/api/files/:id',(req,res)=>{const file=getStoredFile(db,'files',req.params.id);if(!file)throw fail(404,'파일을 찾을 수 없습니다.');res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`});sendStoredFile(db,'files',file,res);});
  app.delete('/api/files/:id',requireRole(['admin','editor']),(req,res)=>{
    const file=db.prepare('SELECT id,item_id,name FROM files WHERE id=?').get(req.params.id);if(!file)throw fail(404,'파일을 찾을 수 없습니다.');
    transaction(db,()=>{deleteUploadChunks(db,'files',file.id);db.prepare('DELETE FROM files WHERE id=?').run(file.id);db.prepare('UPDATE items SET updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(now(),req.user.id,file.item_id);history(file.item_id,req.user.id,'자료 삭제',file.name);});res.json({ok:true});
  });
  app.get('/api/notifications',(req,res)=>{
    scanDeadlines(db);
    const deadlines=db.prepare('SELECT n.*,i.asset_code FROM notifications n JOIN items i ON i.id=n.item_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 200').all(req.user.id)
      .map(row=>({...row,id:`deadline:${row.id}`,scope:'items',detail:row.asset_code}));
    const activity=activityForUser(db,req.user);
    const notifications=[...deadlines,...activity].sort((a,b)=>b.created_at.localeCompare(a.created_at)||String(b.id).localeCompare(String(a.id))).slice(0,200);
    const unread=db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).n+activityUnread(db,req.user);
    res.json({notifications,unread});
  });
  app.post('/api/notifications/read',(req,res)=>{
    const value=req.body.id;
    if(value){
      if(/^activity:[1-9]\d*$/.test(String(value))) readActivity(db,req.user,value);
      else if(/^(?:deadline:)?[1-9]\d*$/.test(String(value))) db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(),Number(String(value).replace('deadline:','')),req.user.id);
      else throw fail(400,'알림 번호를 확인해 주세요.');
    }else{
      db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(),req.user.id);
      readActivity(db,req.user);
    }
    res.json({ok:true});
  });
  registerFeatures(app, { db, requireRole, upload });
  registerWork(app, { db, requireRole, upload });
  registerTodos(app, { db, upload });
  registerProjects(app, { db, requireRole });
  const selfCheck = options.selfCheck === false ? null : createSelfCheck({ dataDir });
  registerOperations(app, { db, requireRole, instanceId, selfCheck });
  registerUsage(app, { db, requireRole, dataDir, backupDir });
  registerLeave(app, { db, requireRole });
  purgeOrphanChunks(db);
  registerReports(app, { db });
  const pruneBackups = registerBackups(app, { db, backupDir, requireRole, maintenance, onRestore: options.onRestore });
  app.use('/api',(_req,_res,next)=>next(fail(404,'요청한 기능을 찾을 수 없습니다.')));
  for (const dir of ['build','cmaps','standard_fonts','wasm']) app.use('/vendor/pdfjs/'+dir, express.static(resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/pdfjs-dist',dir)));
  app.use(express.static(resolve(dirname(fileURLToPath(import.meta.url)),'../public'),{etag:true}));
  app.use((err,_req,res,_next)=>{
    if(err.code==='SQLITE_CONSTRAINT_UNIQUE' && /users\.username|users_username_unique/.test(err.message))return res.status(409).json({error:'이미 사용 중인 아이디입니다.'});
    if(err.code==='SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message))return res.status(409).json({error:'같은 이름이나 관리번호가 이미 등록되어 있습니다.'});
    if(err instanceof multer.MulterError)return res.status(400).json({error:'첨부 요청이 올바르지 않습니다.'});
    // 사용자가 업로드를 취소하거나 창을 닫아 연결이 끊긴 경우는 서버 오류로 기록하지 않는다.
    if(err.code==='ECONNABORTED'||err.code==='ECONNRESET'||/Request aborted/i.test(err.message))return res.headersSent?res.end():res.status(400).json({error:'업로드가 중단되었습니다.'});
    const status=err.status??500;if(status>=500&&!err.expose)console.error(err);
    // 5xx는 내부 정보를 숨기고 일반 문구를 보낸다. 사용자에게 알려야 하는 안내(expose: true, 예: 한글 글꼴 없음)만 그대로 보낸다.
    res.status(status).json({error:status>=500&&!err.expose?'처리 중 오류가 발생했습니다. 다시 시도해 주세요.':err.message});
  });
  let lastDailyScan='';
  const tick=()=>{
    if (maintenance.restoring) return;
    scanDeadlines(db);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(today!==lastDailyScan){scanMissing(db);scanMonthly(db);lastDailyScan=today;}
  };
  tick();
  return { app, db, tokenPath, tick, pruneBackups, instanceId, maintenance, selfCheck };
}

