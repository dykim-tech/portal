import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagement } from '../public/management.js';

test('project and operations screens expose their controls without inserting document HTML',async()=>{
 const content={innerHTML:''},state={view:'projects',user:{name:'관리자'}};
 const oldDocument=globalThis.document;
 globalThis.document={querySelector:selector=>selector==='#content'?content:null};
 const fixtures={
  '/projects?page=1':{projects:[{id:4,name:'현장 설치',customer:'고객',kind:'installation',phase:'before',status:'planned',planned_start:'2026-10-04',planned_end:'2026-10-05',owner:'담당자',done_count:1,task_count:3}],total:1,page:1,page_size:50,counts:{total:1,before_count:1,during_count:0,after_count:0}},
  '/operations':{status:'running',started_at:'2026-10-04T00:00:00.000Z',uptime_seconds:3600,counts:{users:1,installations:2,projects:1,manuals:3,work_logs:4},documents:[{title:'설계도',content:'# 설계도\n![전체 구성](../public/portal-architecture.png)\n<script>bad</script>'},{title:'화면 디자인',content:'# 화면 디자인'}]}
 };
 const api=async path=>{if(!(path in fixtures))throw new Error('Unexpected request: '+path);return fixtures[path];};
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const manager=createManagement({api,esc,state,canEdit:()=>true,openDialog:()=>{},input:()=>'',toast:()=>{},fmt:value=>value,pageHead:(_tag,title)=>`<h1>${title}</h1>`,modal:{close(){}},renderView:()=>{}});
 try{
  await manager.renderProjects();
  assert.match(content.innerHTML,/프로젝트 관리/);
  assert.match(content.innerHTML,/현장 설치/);
  assert.match(content.innerHTML,/data-action="project-open"/);
  assert.match(content.innerHTML,/data-action="project-delete" data-id="4"/);
  const viewerManager=createManagement({api,esc,state,canEdit:()=>false,openDialog:()=>{},input:()=>'',toast:()=>{},fmt:value=>value,pageHead:(_tag,title)=>`<h1>${title}</h1>`,modal:{close(){}},renderView:()=>{}});
  await viewerManager.renderProjects();
  assert.doesNotMatch(content.innerHTML,/data-action="project-delete"/);
  state.view='operations';
  await manager.renderOperations();
  assert.match(content.innerHTML,/서버 시작/);
  assert.match(content.innerHTML,/설계도/);
  assert.match(content.innerHTML,/<img src="\/portal-architecture.png" alt="전체 구성"/);
  assert.doesNotMatch(content.innerHTML,/<script>bad<\/script>/);
  assert.match(content.innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/);
  await manager.action('operations-document','1');
  assert.match(content.innerHTML,/<h2>화면 디자인<\/h2>/);
 }finally{globalThis.document=oldDocument;}
});

test('project list delete confirms and refreshes without an open dialog',async()=>{
 const content={innerHTML:''},state={view:'projects',user:{name:'관리자'}};
 const oldDocument=globalThis.document,oldConfirm=globalThis.confirm;
 globalThis.document={querySelector:selector=>selector==='#content'?content:null};
 globalThis.confirm=()=>false;
 const project={id:4,name:'현장 설치',kind:'installation',phase:'before',status:'planned',task_count:3,done_count:0};
 let deleted=false;
 const api=async(path,options)=>{
  if(path==='/projects/4'&&options?.method==='DELETE'){deleted=true;return {ok:true};}
  if(path==='/projects?page=1')return {projects:deleted?[]:[project],total:deleted?0:1,page:1,page_size:50,counts:{total:deleted?0:1,before_count:deleted?0:1,during_count:0,after_count:0}};
  throw new Error('Unexpected request: '+path);
 };
 const manager=createManagement({api,esc:value=>String(value??''),state,canEdit:()=>true,openDialog:()=>{},input:()=>'',toast:()=>{},fmt:value=>value,pageHead:(_tag,title)=>`<h1>${title}</h1>`,modal:{open:false,close(){throw new Error('No dialog to close');}},renderView:()=>{}});
 try{
  await manager.renderProjects();
  assert.match(content.innerHTML,/data-action="project-delete" data-id="4"/);
  await manager.action('project-delete','4');
  assert.equal(deleted,false,'cancelling confirmation keeps the project');
  globalThis.confirm=()=>true;
  await manager.action('project-delete','4');
  assert.equal(deleted,true);
  assert.match(content.innerHTML,/표시할 프로젝트가 없습니다/);
 }finally{globalThis.document=oldDocument;globalThis.confirm=oldConfirm;}
});

test('saving a new project closes its dialog and refreshes the list',async()=>{
 const content={innerHTML:''},state={view:'projects',user:{name:'관리자'}};
 const oldDocument=globalThis.document;
 globalThis.document={querySelector:selector=>selector==='#content'?content:null};
 const project={id:7,name:'신규 설치',customer:'고객',kind:'installation',phase:'before',status:'planned',owner:'관리자',task_count:3,done_count:0};
 let opens=0,closes=0,saves=0;
 const api=async(path,options)=>{
  if(path.startsWith('/installations?'))return {installations:[]};
  if(path==='/projects'&&options?.method==='POST'){saves++;return {project};}
  if(path==='/projects?page=1')return {projects:saves?[project]:[],total:saves,page:1,page_size:50,counts:{total:saves,before_count:saves,during_count:0,after_count:0}};
  throw new Error('Unexpected request: '+path);
 };
 const manager=createManagement({api,esc:value=>String(value??''),state,canEdit:()=>true,openDialog:()=>{opens++;},input:()=>'',toast:()=>{},fmt:value=>value,pageHead:(_tag,title)=>`<h1>${title}</h1>`,modal:{close(){closes++;}},renderView:()=>{}});
 try{
  await manager.action('project-new');
  assert.equal(opens,1);
  await manager.submit({id:'project-form'},{name:project.name,kind:project.kind,phase:project.phase,status:project.status});
  assert.equal(saves,1);
  assert.equal(closes,1);
  assert.equal(opens,1,'saved project should not reopen its detail dialog');
  assert.match(content.innerHTML,/신규 설치/);
 }finally{globalThis.document=oldDocument;}
});
