import { koreaDate, transaction } from './db.mjs';
import { storeUpload, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile } from './uploads.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const now=()=>new Date().toISOString();
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
}
export function registerTodos(app,{db,upload}){
  const owned=(req)=>{
    const row=db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(identifier(req.params.id),req.user.id);
    if(!row)throw fail(404,'할 일을 찾을 수 없습니다.');
    return row;
  };
  app.get('/api/todos',(req,res)=>{
    const q=req.query.q===undefined?'':text(req.query.q,'검색어',100);
    const rows=db.prepare(`SELECT * FROM todos WHERE user_id=? AND (?='' OR instr(title,?)>0 OR instr(body,?)>0)
      ORDER BY done ASC,target_date DESC,updated_at DESC,id DESC`).all(req.user.id,q,q,q);
    const today=koreaDate();
    const today_open=db.prepare('SELECT COUNT(*) AS count FROM todos WHERE user_id=? AND target_date=? AND done=0').get(req.user.id,today).count;
    const files=db.prepare('SELECT id,todo_id,name,size FROM todo_files WHERE todo_id IN (SELECT id FROM todos WHERE user_id=?) ORDER BY id').all(req.user.id);
    res.json({todos:rows.map(row=>({...row,files:files.filter(file=>file.todo_id===row.id)})),today,today_open});
  });
  app.post('/api/todos',(req,res)=>{
    const title=text(req.body.title,'제목',120),body=text(req.body.body,'내용',6000),targetDate=taskDate(req.body.target_date||koreaDate()),stamp=now();
    const id=Number(db.prepare('INSERT INTO todos(user_id,title,body,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(req.user.id,title,body,targetDate,stamp,stamp).lastInsertRowid);
    res.status(201).json({todo:db.prepare('SELECT * FROM todos WHERE id=?').get(id)});
  });
  app.put('/api/todos/:id',(req,res)=>{
    const row=owned(req),title=text(req.body.title,'제목',120),body=text(req.body.body,'내용',6000),targetDate=taskDate(req.body.target_date);
    db.prepare('UPDATE todos SET title=?,body=?,target_date=?,updated_at=? WHERE id=?').run(title,body,targetDate,now(),row.id);
    res.json({todo:db.prepare('SELECT * FROM todos WHERE id=?').get(row.id)});
  });
  app.patch('/api/todos/:id',(req,res)=>{
    const row=owned(req);
    if(typeof req.body.done!=='boolean')throw fail(400,'완료 상태를 확인해 주세요.');
    db.prepare('UPDATE todos SET done=?,updated_at=? WHERE id=?').run(Number(req.body.done),now(),row.id);
    res.json({todo:db.prepare('SELECT * FROM todos WHERE id=?').get(row.id)});
  });
  app.delete('/api/todos/:id',(req,res)=>{
    const row=owned(req);transaction(db,()=>{for(const file of db.prepare('SELECT id FROM todo_files WHERE todo_id=?').all(row.id))deleteUploadChunks(db,'todo_files',file.id);db.prepare('DELETE FROM todos WHERE id=?').run(row.id);});res.json({ok:true});
  });
  app.post('/api/todos/:id/files',(req,res,next)=>{owned(req);next();},upload,async(req,res)=>{
    if(!req.file)throw fail(400,'첨부할 파일을 선택해 주세요.');
    try{
      const row=owned(req);
      const decoded=Buffer.from(req.file.originalname,'latin1').toString('utf8');
      const name=(decoded.includes('\uFFFD')?req.file.originalname:decoded).replace(/[\\/\u0000-\u001f\u007f]/g,'_').slice(0,240);
      if(!name)throw fail(400,'파일 이름을 확인해 주세요.');
      const fileId=await storeUpload(db,'todo_files',req.file,fileId=>{db.prepare('INSERT INTO todo_files(id,todo_id,name,size,bytes,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(fileId,row.id,name,req.file.size,Buffer.alloc(0),req.user.id,now());return fileId;});
      res.status(201).json({id:fileId});
    }finally{discardUpload(req.file);}
  });
  app.get('/api/todo-files/:id/download',(req,res)=>{const file=getStoredFile(db,'todo_files',identifier(req.params.id));if(!file||!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(file.parent_id,req.user.id))throw fail(404,'첨부파일을 찾을 수 없습니다.');res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`});sendStoredFile(db,'todo_files',file,res);});
  app.delete('/api/todo-files/:id',(req,res)=>{const file=getStoredFile(db,'todo_files',identifier(req.params.id));if(!file||!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(file.parent_id,req.user.id))throw fail(404,'첨부파일을 찾을 수 없습니다.');transaction(db,()=>{deleteUploadChunks(db,'todo_files',file.id);db.prepare('DELETE FROM todo_files WHERE id=?').run(file.id);});res.json({ok:true});});
}
