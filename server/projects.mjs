import { transaction } from './db.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const id=value=>{if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw fail(400,'번호를 확인해 주세요.');return Number(value);};
const text=(value,label,max=200,required=false)=>{if(value!=null&&typeof value!=='string')throw fail(400,`${label} 형식을 확인해 주세요.`);const result=(value??'').trim();if((required&&!result)||result.length>max)throw fail(400,`${label}을 확인해 주세요.`);return result;};
const date=(value,label)=>{if(value==null||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail(400,`${label}을 확인해 주세요.`);return value;};
const choice=(value,values,label)=>{if(!values.includes(value))throw fail(400,`${label}을 확인해 주세요.`);return value;};
const now=()=>new Date().toISOString();

export function initializeProjects(db){
 db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('installation','other')),
  phase TEXT NOT NULL CHECK(phase IN ('before','during','after')),
  status TEXT NOT NULL CHECK(status IN ('planned','in_progress','on_hold','completed')),
  customer TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  planned_start TEXT, planned_end TEXT, actual_start TEXT, actual_end TEXT,
  installation_id INTEGER REFERENCES installations(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS projects_recent ON projects(updated_at DESC,id DESC);
 CREATE TABLE IF NOT EXISTS project_tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK(phase IN ('before','during','after')),
  title TEXT NOT NULL, due_date TEXT, done_at TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS project_tasks_project ON project_tasks(project_id,phase,id);`);
}

export function registerProjects(app,{db,requireRole}){
 const edit=requireRole(['admin','editor']);
 const project=value=>{const row=db.prepare('SELECT p.*,i.name installation_name FROM projects p LEFT JOIN installations i ON i.id=p.installation_id WHERE p.id=?').get(id(value));if(!row)throw fail(404,'프로젝트를 찾을 수 없습니다.');return row;};
 const task=value=>{const row=db.prepare('SELECT * FROM project_tasks WHERE id=?').get(id(value));if(!row)throw fail(404,'할 일을 찾을 수 없습니다.');return row;};
 function input(body){
  const kind=choice(body.kind,['installation','other'],'프로젝트 유형');
  const phase=choice(body.phase,['before','during','after'],'진행 단계');
  const status=choice(body.status,['planned','in_progress','on_hold','completed'],'진행 상태');
  const planned_start=date(body.planned_start,'예정 시작일'),planned_end=date(body.planned_end,'예정 종료일');
  const actual_start=date(body.actual_start,'실제 시작일'),actual_end=date(body.actual_end,'실제 종료일');
  if(planned_start&&planned_end&&planned_end<planned_start)throw fail(400,'예정 종료일은 시작일 이후여야 합니다.');
  if(actual_start&&actual_end&&actual_end<actual_start)throw fail(400,'실제 종료일은 시작일 이후여야 합니다.');
  const installation_id=body.installation_id==null||body.installation_id===''?null:id(body.installation_id);
  if(installation_id&&!db.prepare('SELECT id FROM installations WHERE id=?').get(installation_id))throw fail(400,'연결할 설치 정보를 찾을 수 없습니다.');
  return {name:text(body.name,'프로젝트명',150,true),kind,phase,status,customer:text(body.customer,'고객사',150),owner:text(body.owner,'담당자',150),location:text(body.location,'설치 위치',200),planned_start,planned_end,actual_start,actual_end,installation_id,notes:text(body.notes,'메모',10000)};
 }
 app.get('/api/projects',(req,res)=>{
  const clauses=[],params=[];
  const q=text(req.query.q,'검색어',200);
  if(q){const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';clauses.push("(p.name LIKE ? ESCAPE '\\' OR p.customer LIKE ? ESCAPE '\\' OR p.owner LIKE ? ESCAPE '\\')");params.push(term,term,term);}
  for(const [field,values] of [['kind',['installation','other']],['phase',['before','during','after']],['status',['planned','in_progress','on_hold','completed']]]){
   if(req.query[field]){clauses.push(`p.${field}=?`);params.push(choice(req.query[field],values,field));}
  }
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  const page=req.query.page==null?1:id(req.query.page);
  const total=db.prepare(`SELECT COUNT(*) n FROM projects p ${where}`).get(...params).n;
  const projects=db.prepare(`SELECT p.*,i.name installation_name,
   (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id=p.id) task_count,
   (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id=p.id AND t.done_at IS NOT NULL) done_count
   FROM projects p LEFT JOIN installations i ON i.id=p.installation_id ${where}
   ORDER BY CASE p.status WHEN 'completed' THEN 1 ELSE 0 END,p.planned_start IS NULL,p.planned_start ASC,p.updated_at DESC,p.id DESC LIMIT 50 OFFSET ?`).all(...params,(page-1)*50);
  res.json({projects,total,page,page_size:50,counts:db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN phase='before' THEN 1 ELSE 0 END) before_count, SUM(CASE WHEN phase='during' THEN 1 ELSE 0 END) during_count, SUM(CASE WHEN phase='after' THEN 1 ELSE 0 END) after_count FROM projects").get()});
 });
 app.get('/api/projects/:id',(req,res)=>{const row=project(req.params.id);res.json({project:row,tasks:db.prepare('SELECT * FROM project_tasks WHERE project_id=? ORDER BY CASE phase WHEN \'before\' THEN 0 WHEN \'during\' THEN 1 ELSE 2 END,due_date IS NULL,due_date,id').all(row.id)});});
 app.post('/api/projects',edit,(req,res)=>{
  const values=input(req.body),stamp=now();
  const projectId=transaction(db,()=>{
   const result=db.prepare(`INSERT INTO projects(${Object.keys(values).join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(Object.keys(values).length+4).fill('?').join(',')})`).run(...Object.values(values),req.user.id,req.user.id,stamp,stamp);
   const projectId=Number(result.lastInsertRowid);
   if(values.kind==='installation')for(const [phase,title] of [['before','사전 준비'],['during','설치 진행'],['after','검수 및 인수인계']])db.prepare('INSERT INTO project_tasks(project_id,phase,title,created_at) VALUES(?,?,?,?)').run(projectId,phase,title,stamp);
   return projectId;
  });
  res.status(201).json({project:project(projectId)});
 });
 app.put('/api/projects/:id',edit,(req,res)=>{
  const original=project(req.params.id),values=input(req.body);
  if(original.version!==Number(req.body.version))throw fail(409,'다른 사용자가 수정했습니다. 최신 프로젝트를 다시 열어 주세요.');
  db.prepare(`UPDATE projects SET ${Object.keys(values).map(key=>key+'=?').join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=?`).run(...Object.values(values),req.user.id,now(),original.id);
  res.json({project:project(original.id)});
 });
 app.delete('/api/projects/:id',edit,(req,res)=>{const row=project(req.params.id);db.prepare('DELETE FROM projects WHERE id=?').run(row.id);res.json({ok:true});});
 app.post('/api/projects/:id/tasks',edit,(req,res)=>{
  const row=project(req.params.id),phase=choice(req.body.phase,['before','during','after'],'단계');
  const title=text(req.body.title,'할 일',200,true),due_date=date(req.body.due_date,'예정일');
  const result=db.prepare('INSERT INTO project_tasks(project_id,phase,title,due_date,created_at) VALUES(?,?,?,?,?)').run(row.id,phase,title,due_date,now());
  db.prepare('UPDATE projects SET updated_by=?,updated_at=? WHERE id=?').run(req.user.id,now(),row.id);
  res.status(201).json({task:task(result.lastInsertRowid)});
 });
 app.put('/api/project-tasks/:id',edit,(req,res)=>{
  const row=task(req.params.id),done=req.body.done;
  if(typeof done!=='boolean')throw fail(400,'완료 상태를 확인해 주세요.');
  db.prepare('UPDATE project_tasks SET done_at=? WHERE id=?').run(done?now():null,row.id);
  db.prepare('UPDATE projects SET updated_by=?,updated_at=? WHERE id=?').run(req.user.id,now(),row.project_id);
  res.json({task:task(row.id)});
 });
 app.delete('/api/project-tasks/:id',edit,(req,res)=>{const row=task(req.params.id);db.prepare('DELETE FROM project_tasks WHERE id=?').run(row.id);db.prepare('UPDATE projects SET updated_by=?,updated_at=? WHERE id=?').run(req.user.id,now(),row.project_id);res.json({ok:true});});
}
