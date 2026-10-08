import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { koreaDate, transaction } from './db.mjs';
import { storeUpload, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile } from './uploads.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const now=()=>new Date().toISOString();
const scrypt=promisify(scryptCallback);
// 메모 잠금: 메모마다 따로 정한 비밀번호(scrypt 해시만 저장). 잠긴 메모는 내용·첨부를 응답에 넣지 않는다.
async function lockHash(password){const salt=randomBytes(16).toString('hex');return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;}
async function lockMatches(password,stored){const [salt,expected]=String(stored).split(':');if(!salt||!expected)return false;const actual=await scrypt(password,salt,64),wanted=Buffer.from(expected,'hex');return wanted.length===actual.length&&timingSafeEqual(actual,wanted);}
function lockPassword(value){if(typeof value!=='string'||value.length<4||value.length>64)throw fail(400,'잠금 비밀번호는 4~64자로 입력해 주세요.');return value;}
export function publicTodo(row){if(!row)return row;const {lock_hash,...rest}=row;return lock_hash?{...rest,title:'',body:'',locked:true}:{...rest,locked:false};}
const position=value=>{const n=Number(value);if(value===null||typeof value==='boolean'||!Number.isInteger(n)||n<0||n>20000)throw fail(400,'메모 위치를 확인해 주세요.');return n;};
function identifier(value){
  if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw fail(400,'할 일 번호를 확인해 주세요.');
  return Number(value);
}
function text(value,label,max,required=false){
  if(typeof value!=='string')throw fail(400,`${label} 형식을 확인해 주세요.`);
  const result=value.trim();
  if((required&&!result)||result.length>max)throw fail(400,`${label} 항목을 확인해 주세요. (최대 ${max}자)`);
  return result;
}
function taskDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail(400,'할 일 날짜를 확인해 주세요.');
  return value;
}
export function initializeTodos(db){
  db.exec(`CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    target_date TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS todos_user_date ON todos(user_id,done,target_date DESC,updated_at DESC);
  CREATE TABLE IF NOT EXISTS todo_files (
    id INTEGER PRIMARY KEY, todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    name TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS todo_files_todo ON todo_files(todo_id);`);
  const columns=new Set(db.prepare('PRAGMA table_info(todos)').all().map(column=>column.name));
  if(!columns.has('pos_x'))db.exec('ALTER TABLE todos ADD COLUMN pos_x INTEGER');
  if(!columns.has('pos_y'))db.exec('ALTER TABLE todos ADD COLUMN pos_y INTEGER');
  if(!columns.has('lock_hash'))db.exec('ALTER TABLE todos ADD COLUMN lock_hash TEXT');
}
export function registerTodos(app,{db,upload}){
  const owned=(req)=>{
    const row=db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(identifier(req.params.id),req.user.id);
    if(!row)throw fail(404,'할 일을 찾을 수 없습니다.');
    return row;
  };
  const unlocked=(row)=>{if(row.lock_hash)throw fail(423,'잠긴 메모입니다. 잠금을 해제한 뒤 사용해 주세요.');return row;};
  const get=id=>publicTodo(db.prepare('SELECT * FROM todos WHERE id=?').get(id));
  const attempts=new Map();
  app.get('/api/todos',(req,res)=>{
    const q=req.query.q===undefined?'':text(req.query.q,'검색어',100);
    const rows=db.prepare(`SELECT * FROM todos WHERE user_id=? AND (?='' OR (lock_hash IS NULL AND (instr(title,?)>0 OR instr(body,?)>0)))
      ORDER BY done ASC,target_date DESC,updated_at DESC,id DESC`).all(req.user.id,q,q,q);
    const today=koreaDate();
    const today_open=db.prepare('SELECT COUNT(*) AS count FROM todos WHERE user_id=? AND target_date=? AND done=0').get(req.user.id,today).count;
    const files=db.prepare('SELECT id,todo_id,name,size FROM todo_files WHERE todo_id IN (SELECT id FROM todos WHERE user_id=?) ORDER BY id').all(req.user.id);
    res.json({todos:rows.map(row=>({...publicTodo(row),files:row.lock_hash?[]:files.filter(file=>file.todo_id===row.id)})),today,today_open});
  });
  app.post('/api/todos',(req,res)=>{
    const title=text(req.body.title,'제목',120),body=text(req.body.body,'내용',6000),targetDate=taskDate(req.body.target_date||koreaDate()),stamp=now();
    const placed=req.body.pos_x!==undefined&&req.body.pos_x!==null&&req.body.pos_y!==undefined&&req.body.pos_y!==null,x=placed?position(req.body.pos_x):null,y=placed?position(req.body.pos_y):null;
    const id=Number(db.prepare('INSERT INTO todos(user_id,title,body,target_date,created_at,updated_at,pos_x,pos_y) VALUES(?,?,?,?,?,?,?,?)').run(req.user.id,title,body,targetDate,stamp,stamp,x,y).lastInsertRowid);
    res.status(201).json({todo:get(id)});
  });
  app.put('/api/todos/:id',(req,res)=>{
    const row=unlocked(owned(req)),title=text(req.body.title,'제목',120),body=text(req.body.body,'내용',6000),targetDate=taskDate(req.body.target_date);
    db.prepare('UPDATE todos SET title=?,body=?,target_date=?,updated_at=? WHERE id=?').run(title,body,targetDate,now(),row.id);
    res.json({todo:get(row.id)});
  });
  app.patch('/api/todos/:id',(req,res)=>{
    const row=owned(req);
    if(typeof req.body.done!=='boolean')throw fail(400,'완료 상태를 확인해 주세요.');
    db.prepare('UPDATE todos SET done=?,updated_at=? WHERE id=?').run(Number(req.body.done),now(),row.id);
    res.json({todo:get(row.id)});
  });
  // 메모지 위치(메모 보드 안 좌표, px). 수정 시각은 바꾸지 않는다(대시보드 정렬 유지).
  app.put('/api/todos/:id/position',(req,res)=>{
    const row=owned(req),x=position(req.body.x),y=position(req.body.y);
    db.prepare('UPDATE todos SET pos_x=?,pos_y=? WHERE id=?').run(x,y,row.id);
    res.json({ok:true,x,y});
  });
  app.post('/api/todos/:id/lock',async(req,res)=>{
    const row=unlocked(owned(req)),hash=await lockHash(lockPassword(req.body.password));
    db.prepare('UPDATE todos SET lock_hash=? WHERE id=? AND lock_hash IS NULL').run(hash,row.id);
    res.json({todo:get(row.id)});
  });
  // 잠금 해제: 비밀번호가 맞으면 잠금을 없앤다. 5번 틀리면 1분 동안 시도할 수 없다.
  app.post('/api/todos/:id/unlock',async(req,res)=>{
    const row=owned(req);
    if(!row.lock_hash)return res.json({todo:get(row.id)});
    const state=attempts.get(row.id);
    if(state?.until>Date.now())throw fail(429,'비밀번호를 여러 번 틀렸습니다. 1분 뒤에 다시 시도해 주세요.');
    if(typeof req.body.password!=='string'||!req.body.password||req.body.password.length>64||!await lockMatches(req.body.password,row.lock_hash)){
      const count=(state&&!(state.until>0&&state.until<=Date.now())?state.count:0)+1;
      attempts.set(row.id,count>=5?{count:0,until:Date.now()+60000}:{count,until:0});
      throw fail(403,'잠금 비밀번호가 맞지 않습니다.');
    }
    attempts.delete(row.id);
    db.prepare('UPDATE todos SET lock_hash=NULL WHERE id=?').run(row.id);
    const files=db.prepare('SELECT id,todo_id,name,size FROM todo_files WHERE todo_id=? ORDER BY id').all(row.id);
    res.json({todo:{...get(row.id),files}});
  });
  app.delete('/api/todos/:id',(req,res)=>{
    const row=owned(req);transaction(db,()=>{for(const file of db.prepare('SELECT id FROM todo_files WHERE todo_id=?').all(row.id))deleteUploadChunks(db,'todo_files',file.id);db.prepare('DELETE FROM todos WHERE id=?').run(row.id);});res.json({ok:true});
  });
  app.post('/api/todos/:id/files',(req,res,next)=>{unlocked(owned(req));next();},upload,async(req,res)=>{
    if(!req.file)throw fail(400,'첨부할 파일을 선택해 주세요.');
    try{
      const row=unlocked(owned(req));
      const decoded=Buffer.from(req.file.originalname,'latin1').toString('utf8');
      const name=(decoded.includes('\uFFFD')?req.file.originalname:decoded).replace(/[\\/\u0000-\u001f\u007f]/g,'_').slice(0,240);
      if(!name)throw fail(400,'파일 이름을 확인해 주세요.');
      const fileId=await storeUpload(db,'todo_files',req.file,fileId=>{db.prepare('INSERT INTO todo_files(id,todo_id,name,size,bytes,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId,row.id,name,req.file.size,Buffer.alloc(0),req.user.id,now());return fileId;});
      res.status(201).json({id:fileId});
    }finally{discardUpload(req.file);}
  });
  app.get('/api/todo-files/:id/download',(req,res)=>{const file=getStoredFile(db,'todo_files',identifier(req.params.id));if(!file||!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=? AND lock_hash IS NULL').get(file.parent_id,req.user.id))throw fail(404,'첨부파일을 찾을 수 없습니다.');res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`});sendStoredFile(db,'todo_files',file,res);});
  app.delete('/api/todo-files/:id',(req,res)=>{const file=getStoredFile(db,'todo_files',identifier(req.params.id));if(!file||!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=? AND lock_hash IS NULL').get(file.parent_id,req.user.id))throw fail(404,'첨부파일을 찾을 수 없습니다.');transaction(db,()=>{deleteUploadChunks(db,'todo_files',file.id);db.prepare('DELETE FROM todo_files WHERE id=?').run(file.id);});res.json({ok:true});});
}
