import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { koreaDate } from '../server/db.mjs';

test('folder movement, project phases, operations and recent dashboard data',async t=>{
 const origin='http://localhost:3100',portal=createPortal({dataDir:mkdtempSync(join(tmpdir(),'portal-management-')),origin});
 const server=portal.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 async function request(path,method='GET',body,session=cookie){const response=await fetch(base+'/api'+path,{method,headers:{Origin:origin,'X-Portal-Request':'1',Cookie:session,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};}
 try{
  const setup=await request('/auth/setup','POST',{token:readFileSync(portal.tokenPath,'utf8'),name:'관리자',username:'manager',email:'manager@example.test',password:'test-password-1234'});
  assert.equal(setup.status,201,JSON.stringify(setup.data));
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,'X-Portal-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'manager',password:'test-password-1234'})});
  cookie=login.headers.get('set-cookie').split(';')[0];
  const rootA=(await request('/folders','POST',{name:'A'})).data.id;
  const rootB=(await request('/folders','POST',{name:'B'})).data.id;
  const child=(await request('/folders','POST',{name:'문서',parent_id:rootA})).data.id;
  const grandchild=(await request('/folders','POST',{name:'세부',parent_id:child})).data.id;
  const fileForm=new FormData();fileForm.append('file',new Blob(['moved-content']),'move.txt');
  const file=(await request('/manuals?folder='+grandchild,'POST',fileForm)).data.id;
  await t.test('moving a folder keeps descendants and file content, rejects cycles and duplicate names',async()=>{
   assert.equal((await request('/folders/'+child+'/move','PUT',{parent_id:rootB})).status,200);
   const listing=(await request('/library?folder='+grandchild)).data;
   assert.deepEqual(listing.breadcrumbs.map(row=>row.name),['B','문서','세부']);
   assert.equal(listing.files[0].id,file);
   assert.equal((await request('/manuals/'+file+'/download')).data,'moved-content');
   for(const target of [child,grandchild])assert.equal((await request('/folders/'+child+'/move','PUT',{parent_id:target})).status,400);
   assert.equal((await request('/folders/'+rootB+'/move','PUT',{parent_id:grandchild})).status,400);
   const duplicate=(await request('/folders','POST',{name:'문서',parent_id:rootA})).data.id;
   assert.equal((await request('/folders/'+duplicate+'/move','PUT',{parent_id:rootB})).status,409);
   assert.equal((await request('/folders/'+child+'/move','PUT',{parent_id:null})).status,200);
   assert.equal((await request('/library?folder='+child)).data.breadcrumbs.length,1);
  });
  const today=koreaDate();
  const weekStart=new Date(Date.parse(today+'T00:00:00Z')-6*86400000).toISOString().slice(0,10);
  const oldDate=new Date(Date.parse(today+'T00:00:00Z')-7*86400000).toISOString().slice(0,10);
  const customer=(await request('/customers','POST',{name:'현장 A'})).data.customer;
  const installationBody=(name,installed_on)=>({name,customer:'현장 A',installed_on,status:'installed',quantity:1});
  const latest=(await request('/installations','POST',installationBody('새 설치',today))).data.installation;
  await request('/installations','POST',installationBody('옛 설치',oldDate));
  const logBody=(title,work_date)=>({customer_id:customer.id,work_date,title,work_type:'installation',work_mode:'visit',owner:'관리자',status:'done',content:'설치 기록'});
  const recent=(await request('/work-logs','POST',logBody('이번 주 업무',weekStart))).data.log;
  await request('/work-logs','POST',logBody('지난 업무',oldDate));
  await t.test('dashboard uses installation date and the last seven calendar days',async()=>{
   const dashboard=(await request('/dashboard')).data;
   assert.equal(dashboard.installations[0].id,latest.id);
   assert.deepEqual(dashboard.recentWork.map(row=>row.id),[recent.id]);
   assert.equal(dashboard.weekStart,weekStart);
  });
  await t.test('one activity alert can be marked read without hiding other alerts',async()=>{
   const before=(await request('/notifications')).data;
   const active=before.notifications.filter(row=>String(row.id).startsWith('activity:')&&!row.read_at);
   assert.ok(active.length>1);
   assert.equal((await request('/notifications/read','POST',{id:active[0].id})).status,200);
   const after=(await request('/notifications')).data;
   assert.ok(after.notifications.find(row=>row.id===active[0].id)?.read_at);
   assert.equal(after.unread,before.unread-1);
  });
  let projectId,taskId;
  await t.test('project lifecycle, tasks and linked installation',async()=>{
   const values={name:'현장 설치',kind:'installation',phase:'before',status:'planned',customer:'현장 A',owner:'관리자',location:'서버실',planned_start:today,planned_end:today,installation_id:latest.id,notes:'사전 준비'};
   const created=await request('/projects','POST',values);
   assert.equal(created.status,201,JSON.stringify(created.data));projectId=created.data.project.id;
   let detail=(await request('/projects/'+projectId)).data;
   assert.equal(detail.tasks.length,3);assert.equal(detail.project.installation_name,'새 설치');
   const updated=await request('/projects/'+projectId,'PUT',{...values,phase:'during',status:'in_progress',version:detail.project.version});
   assert.equal(updated.status,200,JSON.stringify(updated.data));
   assert.equal((await request('/projects/'+projectId,'PUT',{...values,version:detail.project.version})).status,409);
   const createdTask=await request('/projects/'+projectId+'/tasks','POST',{phase:'during',title:'장비 설정',due_date:today});
   assert.equal(createdTask.status,201);taskId=createdTask.data.task.id;
   assert.equal((await request('/project-tasks/'+taskId,'PUT',{done:true})).data.task.done_at!=null,true);
   assert.equal((await request('/projects?phase=during')).data.projects[0].done_count,1);
   assert.equal((await request('/project-tasks/'+taskId,'DELETE')).status,200);
   assert.equal((await request('/projects','POST',{...values,planned_end:oldDate})).status,400);
  });
  await t.test('operations documents are admin-only; viewer cannot mutate',async()=>{
   const operations=await request('/operations');
   assert.equal(operations.status,200);
   assert.equal(operations.data.counts.projects,1);
   assert.deepEqual(operations.data.documents.map(doc=>doc.title),['설계도','화면 디자인','운영자 매뉴얼']);
   assert.match(operations.data.documents[0].content,/DYKIM PORTAL 설계도/);
   await request('/users','POST',{name:'조회자',username:'viewer2',email:'viewer2@example.test',password:'test-password-1234',role:'viewer'});
   const viewerLogin=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,'X-Portal-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'viewer2',password:'test-password-1234'})});
   const viewerCookie=viewerLogin.headers.get('set-cookie').split(';')[0];
   assert.equal((await request('/operations','GET',undefined,viewerCookie)).status,403);
   assert.equal((await request('/projects','GET',undefined,viewerCookie)).status,200);
   assert.equal((await request('/projects','POST',{name:'금지'},viewerCookie)).status,403);
   assert.equal((await request('/folders/'+child+'/move','PUT',{parent_id:rootA},viewerCookie)).status,403);
   assert.equal((await request('/projects/'+projectId,'DELETE')).status,200);
   assert.equal((await request('/projects/'+projectId)).status,404);
  });
 }finally{await new Promise(resolve=>server.close(resolve));portal.db.close();}
});
