import { extname } from 'node:path';
import { transaction, koreaDate } from './db.mjs';
import { writeUploadChunks, discardUpload, deleteUploadChunks, getStoredFile, sendStoredFile, uploadHeader, assertUploadSize } from './uploads.mjs';
import { initializeCategories, registerCategories, categoryInput, categoryDescendants } from './categories.mjs';
import { listing } from './listing.mjs';
const now=()=>new Date().toISOString();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const val=(value,label,max=200,required=false)=>{if(value!=null&&typeof value!=='string')throw fail(400,`${label} 형식을 확인해 주세요.`);const s=(value??'').trim();if(s.length>max||(required&&!s))throw fail(400,`${label} 항목을 확인해 주세요.`);return s;};
const id=v=>{if(!/^\d+$/.test(String(v))||Number(v)<1)throw fail(400,'식별자가 올바르지 않습니다.');return Number(v);};
const date=(v,label='설치일')=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw fail(400,`${label}을 확인해 주세요.`);return v;};
function filename(original){const decoded=Buffer.from(original,'latin1').toString('utf8');return val((decoded.includes('\uFFFD')?original:decoded).replace(/[\\/\u0000-\u001f\u007f]/g,'_'),'파일명',240,true);}
function previewType(name,bytes){
  const ext=extname(name).toLowerCase();const b=Buffer.from(bytes);
  if(ext==='.pdf'&&b.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(ext==='.png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(['.jpg','.jpeg'].includes(ext)&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(ext==='.gif'&&/^GIF8[79]a/.test(b.subarray(0,6).toString()))return 'image/gif';
  if(ext==='.webp'&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(['.txt','.md','.csv','.log'].includes(ext))return 'text/plain; charset=utf-8';
  return null;
}
export function initializeFeatures(db){
 db.exec(`CREATE TABLE IF NOT EXISTS installations (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,customer TEXT NOT NULL,location TEXT NOT NULL DEFAULT '',installed_on TEXT NOT NULL,
 completed_on TEXT,quantity INTEGER NOT NULL DEFAULT 1,contact TEXT NOT NULL DEFAULT '',
 engineer TEXT NOT NULL DEFAULT '',product_version TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES folders(id),name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS folder_unique ON folders(COALESCE(parent_id,0),name);
 CREATE TABLE IF NOT EXISTS manuals(id INTEGER PRIMARY KEY,folder_id INTEGER REFERENCES folders(id),name TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL,preview_type TEXT,uploaded_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS manuals_folder ON manuals(folder_id);
 CREATE TABLE IF NOT EXISTS installation_files(id INTEGER PRIMARY KEY,installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,name TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL,preview_type TEXT,uploaded_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS installation_files_installation ON installation_files(installation_id);
 PRAGMA user_version=2;`);
 const columns=new Set(db.prepare('PRAGMA table_info(installations)').all().map(column=>column.name));
 if(!columns.has('completed_on'))db.exec('ALTER TABLE installations ADD COLUMN completed_on TEXT');
 if(!columns.has('quantity'))db.exec('ALTER TABLE installations ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
 if(!columns.has('contact'))db.exec("ALTER TABLE installations ADD COLUMN contact TEXT NOT NULL DEFAULT ''");
 initializeCategories(db);
 flattenLibraryFolders(db);
}
// Keep folder IDs and file references while reducing legacy paths to two levels.
export function flattenLibraryFolders(db){
 const folders=db.prepare('SELECT id,parent_id,name FROM folders ORDER BY id').all();
 const byId=new Map(folders.map(folder=>[folder.id,folder]));
 transaction(db,()=>{
  for(const folder of folders){
   const path=[folder];let parent=byId.get(folder.parent_id);
   while(parent){path.unshift(parent);parent=byId.get(parent.parent_id);}
   if(path.length<=2)continue;
   const root=path[0],base=path.slice(1).map(part=>part.name).join(' · ');
   let name=base.slice(0,100),suffix=1;
   while(db.prepare('SELECT id FROM folders WHERE parent_id=? AND name=? AND id<>?').get(root.id,name,folder.id)){
    const ending=` (${++suffix})`;name=base.slice(0,100-ending.length)+ending;
   }
   db.prepare('UPDATE folders SET parent_id=?,name=? WHERE id=?').run(root.id,name,folder.id);
  }
 });
}
export function registerFeatures(app,{db,requireRole,upload}){
 const edit=requireRole(['admin','editor']);
 registerCategories(app,{db,requireRole});
 const getFolder=value=>{if(value==null||value==='')return null;const folder=db.prepare('SELECT * FROM folders WHERE id=?').get(id(value));if(!folder)throw fail(404,'폴더를 찾을 수 없습니다.');return folder;};
 const middleFolder=value=>{const folder=getFolder(value);if(!folder||!folder.parent_id||getFolder(folder.parent_id).parent_id)throw fail(400,'중분류를 선택해 주세요.');return folder;};
 const folderName=value=>{const name=val(value,'분류명',100,true);if(/[\\/\u0000-\u001f\u007f]/.test(name)||['.','..'].includes(name))throw fail(400,'분류 이름에 경로 문자나 제어 문자를 사용할 수 없습니다.');return name;};
 const installation=value=>{const result=db.prepare('SELECT * FROM installations WHERE id=?').get(id(value));if(!result)throw fail(404,'설치 정보를 찾을 수 없습니다.');return result;};
 function installationData(body){
  if(!['planned','installed','maintenance','closed'].includes(body.status))throw fail(400,'설치 상태를 확인해 주세요.');
  const installed_on=date(body.installed_on,'설치시작일');
  const completed_on=body.completed_on==null||body.completed_on===''?null:date(body.completed_on,'설치종료일');
  if(completed_on&&completed_on<installed_on)throw fail(400,'설치종료일은 설치시작일 이후로 입력해 주세요.');
  const quantity=body.quantity===undefined?1:Number(body.quantity);
  if(body.quantity===''||body.quantity===null||typeof body.quantity==='boolean'||!Number.isInteger(quantity)||quantity<1||quantity>1000000)throw fail(400,'수량은 1~1,000,000 사이의 정수로 입력해 주세요.');
  return {name:val(body.name,'제품명',150,true),customer:val(body.customer,'고객사',150,true),location:val(body.location,'설치 위치'),installed_on,completed_on,quantity,contact:val(body.contact,'담당자'),engineer:val(body.engineer,'설치엔지니어'),product_version:val(body.product_version,'세부내용',500),status:body.status,notes:val(body.notes,'비고',10000),category_id:categoryInput(db,'installations',body.category_id)};
 }
 app.get('/api/dashboard',(req,res)=>{
   const today=koreaDate();const upcoming=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
   res.json({counts:{assets:db.prepare('SELECT COUNT(*) n FROM items').get().n,installations:db.prepare('SELECT COUNT(*) n FROM installations').get().n,manuals:db.prepare('SELECT COUNT(*) n FROM manuals').get().n,unread:db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).n},deadlines:db.prepare("SELECT id,name,asset_code,due_date,status FROM items WHERE due_date<=? AND status!='retired' ORDER BY due_date,id LIMIT 8").all(upcoming),recent:db.prepare('SELECT id,name,asset_code,updated_at,category FROM items ORDER BY updated_at DESC LIMIT 6').all(),installations:db.prepare('SELECT * FROM installations ORDER BY updated_at DESC LIMIT 5').all(),today});
 });
 app.get('/api/installations',(req,res)=>{
   const clauses=[],params=[];const q=val(req.query.q,'검색어',200);
   if(q){clauses.push("(name LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\' OR product_version LIKE ? ESCAPE '\\' OR contact LIKE ? ESCAPE '\\' OR engineer LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')");const p='%'+q.replace(/[\\%_]/g,'\\$&')+'%';params.push(p,p,p,p,p,p);}
   if(req.query.status){clauses.push('status=?');params.push(val(req.query.status,'상태',30));}
   if(req.query.category_id){const ids=categoryDescendants(db,'installations',req.query.category_id);clauses.push(`category_id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids);}
   if(req.query.from){clauses.push('installed_on>=?');params.push(date(req.query.from));}if(req.query.to){clauses.push('installed_on<=?');params.push(date(req.query.to));}
   const list=listing(req.query,{id:'installations.id',customer:'installations.customer COLLATE NOCASE',name:'installations.name COLLATE NOCASE',product_version:'installations.product_version COLLATE NOCASE',quantity:'installations.quantity',installed_on:'installations.installed_on',completed_on:'installations.completed_on',contact:'installations.contact COLLATE NOCASE',engineer:'installations.engineer COLLATE NOCASE',notes:'installations.notes COLLATE NOCASE',updated_at:'installations.updated_at'},'updated_at','desc','installations.id');
   const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
   res.json({installations:db.prepare(`SELECT installations.*,(SELECT COUNT(*) FROM installation_files f WHERE f.installation_id=installations.id) AS file_count FROM installations ${where} ORDER BY ${list.orderBy} LIMIT ? OFFSET ?`).all(...params,list.size,(list.page-1)*list.size),total:db.prepare(`SELECT COUNT(*) n FROM installations ${where}`).get(...params).n,page:list.page,page_size:list.size});
 });
 app.get('/api/installations/:id',(req,res)=>{const record=installation(req.params.id);res.json({installation:record,files:db.prepare('SELECT id,name,size,preview_type,created_at FROM installation_files WHERE installation_id=? ORDER BY id DESC').all(record.id)});});
 app.post('/api/installations',edit,(req,res)=>{const data=installationData(req.body),stamp=now();const result=db.prepare(`INSERT INTO installations(${Object.keys(data).join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(Object.keys(data).length+4).fill('?').join(',')})`).run(...Object.values(data),req.user.id,req.user.id,stamp,stamp);db.prepare('INSERT OR IGNORE INTO customers(name,created_at,updated_at) VALUES(?,?,?)').run(data.customer,stamp,stamp);res.status(201).json({installation:installation(result.lastInsertRowid) });});
 app.put('/api/installations/:id',edit,(req,res)=>{const data=installationData(req.body);transaction(db,()=>{const original=installation(req.params.id);if(original.version!==Number(req.body.version))throw fail(409,'다른 사용자가 수정했습니다. 최신 설치 정보를 다시 열어 주세요.');db.prepare(`UPDATE installations SET ${Object.keys(data).map(k=>k+'=?').join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...Object.values(data),req.user.id,now(),original.id);db.prepare('INSERT OR IGNORE INTO customers(name,created_at,updated_at) VALUES(?,?,?)').run(data.customer,now(),now());});res.json({installation:installation(req.params.id)});});
 app.delete('/api/installations/:id',edit,(req,res)=>{const record=installation(req.params.id);transaction(db,()=>{const files=db.prepare('SELECT id FROM installation_files WHERE installation_id=?').all(record.id);for(const file of files)deleteUploadChunks(db,'installation_files',file.id);db.prepare('DELETE FROM installations WHERE id=?').run(record.id);});res.json({ok:true});});
 app.get('/api/library',(req,res)=>{
   const folder=getFolder(req.query.folder),folderId=folder?.id??null;
   const breadcrumbs=[];let cursor=folder;while(cursor){breadcrumbs.unshift({id:cursor.id,name:cursor.name});cursor=cursor.parent_id?getFolder(cursor.parent_id):null;}
   const q=val(req.query.q,'검색어',200),pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
   const list=listing(req.query,{name:'m.name COLLATE NOCASE',type:"lower(substr(m.name, instr(m.name,'.')+1))",size:'m.size',created_at:'m.created_at'},'name','asc','m.id');
   const where="folder_id IS ? AND name LIKE ? ESCAPE '\\'";
   res.json({folder,breadcrumbs,tree:db.prepare('SELECT id,parent_id,name FROM folders ORDER BY name').all(),folders:db.prepare("SELECT * FROM folders WHERE parent_id IS ? AND name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE").all(folderId,pattern),files:db.prepare(`SELECT m.id,m.folder_id,m.name,m.size,m.preview_type,m.created_at,u.name AS uploaded_by_name FROM manuals m JOIN users u ON u.id=m.uploaded_by WHERE ${where.replace('name LIKE','m.name LIKE')} ORDER BY ${list.orderBy} LIMIT ? OFFSET ?`).all(folderId,pattern,list.size,(list.page-1)*list.size),total:db.prepare(`SELECT COUNT(*) n FROM manuals WHERE ${where}`).get(folderId,pattern).n,page:list.page,page_size:list.size});
 });
 app.post('/api/folders',edit,(req,res)=>{const parent=getFolder(req.body.parent_id),name=folderName(req.body.name);if(parent?.parent_id)throw fail(400,'분류는 대분류·중분류 2단계까지 만들 수 있습니다.');const result=db.prepare('INSERT INTO folders(parent_id,name,created_at) VALUES(?,?,?)').run(parent?.id??null,name,now());res.status(201).json({id:Number(result.lastInsertRowid)});});
 app.put('/api/folders/:id',edit,(req,res)=>{const folder=getFolder(req.params.id),name=folderName(req.body.name);db.prepare('UPDATE folders SET name=? WHERE id=?').run(name,folder.id);res.json({folder:getFolder(folder.id)});});
 app.delete('/api/folders/:id',edit,(req,res)=>{const folder=getFolder(req.params.id);if(db.prepare('SELECT id FROM folders WHERE parent_id=? LIMIT 1').get(folder.id)||db.prepare('SELECT id FROM manuals WHERE folder_id=? LIMIT 1').get(folder.id))throw fail(409,'비어 있는 폴더만 삭제할 수 있습니다.');db.prepare('DELETE FROM folders WHERE id=?').run(folder.id);res.json({ok:true});});
 const installationFile=value=>{const file=getStoredFile(db,'installation_files',id(value));if(!file)throw fail(404,'첨부자료를 찾을 수 없습니다.');return file;};
 app.post('/api/installations/:id/files',edit,(req,res,next)=>{installation(req.params.id);next();},upload,(req,res)=>{
   if(!req.file)throw fail(400,'첨부할 파일을 선택해 주세요.');
   try {
     assertUploadSize(req.file);
     const record=installation(req.params.id),name=filename(req.file.originalname);
     transaction(db,()=>{
       const result=db.prepare('INSERT INTO installation_files(installation_id,name,size,bytes,preview_type,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(record.id,name,req.file.size,Buffer.alloc(0),previewType(name,uploadHeader(req.file.path)),req.user.id,now());
       writeUploadChunks(db,'installation_files',Number(result.lastInsertRowid),req.file);
       db.prepare('UPDATE installations SET version=version+1,updated_by=?,updated_at=? WHERE id=?').run(req.user.id,now(),record.id);
     });
     res.status(201).json({ok:true});
   } finally { discardUpload(req.file); }
 });
 app.get('/api/installation-files/:id/download',(req,res)=>{const file=installationFile(req.params.id);res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`});sendStoredFile(db,'installation_files',file,res);});
 app.get('/api/installation-files/:id/preview',(req,res)=>{const file=installationFile(req.params.id);if(!file.preview_type)throw fail(415,'이 파일은 다운로드하여 확인해 주세요.');res.set({'Content-Type':file.preview_type,'Content-Disposition':`inline; filename="preview${extname(file.name).replace(/[^.a-zA-Z0-9]/g,'')}"`,'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'"});sendStoredFile(db,'installation_files',file,res);});
 app.delete('/api/installation-files/:id',edit,(req,res)=>{const file=installationFile(req.params.id);transaction(db,()=>{deleteUploadChunks(db,'installation_files',file.id);db.prepare('DELETE FROM installation_files WHERE id=?').run(file.id);db.prepare('UPDATE installations SET version=version+1,updated_by=?,updated_at=? WHERE id=?').run(req.user.id,now(),file.parent_id);});res.json({ok:true});});

 app.post('/api/manuals',edit,(req,res,next)=>{middleFolder(req.query.folder);next();},upload,(req,res)=>{
   if(!req.file)throw fail(400,'등록할 파일을 선택해 주세요.');
   try {
     assertUploadSize(req.file);
     const folder=middleFolder(req.query.folder),name=filename(req.file.originalname);
     const fileId=transaction(db,()=>{
       const result=db.prepare('INSERT INTO manuals(folder_id,name,size,bytes,preview_type,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(folder?.id??null,name,req.file.size,Buffer.alloc(0),previewType(name,uploadHeader(req.file.path)),req.user.id,now());
       const fileId=Number(result.lastInsertRowid);
       writeUploadChunks(db,'manuals',fileId,req.file);
       return fileId;
     });
     res.status(201).json({id:fileId});
   } finally { discardUpload(req.file); }
 });
 const manual=value=>{const file=getStoredFile(db,'manuals',id(value));if(!file)throw fail(404,'자료를 찾을 수 없습니다.');return file;};
 app.get('/api/manuals/:id',(req,res)=>{const file=manual(req.params.id);res.json({file:{id:file.id,folder_id:file.parent_id,name:file.name,size:file.size,preview_type:file.preview_type,created_at:file.created_at}});});
 app.put('/api/manuals/:id',edit,(req,res)=>{
   const file=manual(req.params.id),name=val(req.body.name===undefined?file.name:req.body.name,'자료명',240,true);
   if(/[\\/\u0000-\u001f\u007f]/.test(name)||['.','..'].includes(name))throw fail(400,'자료 이름에 경로 문자나 제어 문자를 사용할 수 없습니다.');
   if(extname(name).toLowerCase()!==extname(file.name).toLowerCase())throw fail(400,'파일 확장자는 변경할 수 없습니다.');
   const folderId=req.body.folder_id===undefined||String(req.body.folder_id??'')===String(file.parent_id??'')?file.parent_id:middleFolder(req.body.folder_id).id;
   db.prepare('UPDATE manuals SET name=?,folder_id=? WHERE id=?').run(name,folderId,file.id);
   res.json({ok:true});
 });
 app.get('/api/manuals/:id/download',(req,res)=>{const file=manual(req.params.id);res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`});sendStoredFile(db,'manuals',file,res);});
 app.get('/api/manuals/:id/preview',(req,res)=>{
   const file=manual(req.params.id);if(!file.preview_type)throw fail(415,'이 파일은 다운로드하여 확인해 주세요.');
   res.set({'Content-Type':file.preview_type,'Content-Disposition':`inline; filename="preview${extname(file.name).replace(/[^.a-zA-Z0-9]/g,'')}"`,'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'"});sendStoredFile(db,'manuals',file,res);
 });
 app.delete('/api/manuals/:id',edit,(req,res)=>{const file=manual(req.params.id);transaction(db,()=>{deleteUploadChunks(db,'manuals',file.id);db.prepare('DELETE FROM manuals WHERE id=?').run(file.id);});res.json({ok:true});});
}
