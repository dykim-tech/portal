import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { koreaDate } from '../server/db.mjs';

test('sticky-note todos persist and stay private to their author',async()=>{
  const origin='http://localhost:3000';
  const portal=createPortal({dataDir:mkdtempSync(join(tmpdir(),'portal-todos-')),origin});
  const server=portal.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,method='GET',body,cookie=''){
    const response=await fetch(base+'/api'+path,{method,headers:{Origin:origin,'X-Portal-Request':'1','Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    assert.equal((await request('/todos')).status,401);
    const admin=await request('/auth/setup','POST',{token:readFileSync(portal.tokenPath,'utf8'),name:'관리자',username:'admin',email:'admin@example.test',password:'test-password-1234'});
    assert.equal(admin.status,201);
    const adminCookie=admin.cookie;
    const created=await request('/todos','POST',{title:'오늘 할 일',body:'첫째 줄\n둘째 줄',target_date:koreaDate()},adminCookie);
    assert.equal(created.status,201);
    const taskId=created.data.todo.id;
    const blank=await request('/todos','POST',{title:'',body:'',target_date:koreaDate()},adminCookie);
    assert.equal(blank.status,201);
    assert.equal(blank.data.todo.title,'');
    assert.equal((await request('/todos/'+blank.data.todo.id,'DELETE',undefined,adminCookie)).status,200);
    const list=await request('/todos', 'GET',undefined,adminCookie);
    assert.equal(list.data.today_open,1);
    assert.equal(list.data.todos[0].body,'첫째 줄\n둘째 줄');
    const attachment=new FormData();attachment.append('file',new Blob(['memo attachment'],{type:'text/plain'}),'note.txt');
    const uploaded=await fetch(base+'/api/todos/'+taskId+'/files',{method:'POST',headers:{Origin:origin,'X-Portal-Request':'1',Cookie:adminCookie},body:attachment});
    assert.equal(uploaded.status,201);
    const fileId=(await uploaded.json()).id;
    assert.equal((await request('/todos','GET',undefined,adminCookie)).data.todos[0].files[0].name,'note.txt');
    const download=await fetch(base+'/api/todo-files/'+fileId+'/download',{headers:{Cookie:adminCookie}});
    assert.equal(await download.text(),'memo attachment');
    assert.equal((await request('/todos?q=%EB%91%98%EC%A7%B8','GET',undefined,adminCookie)).data.todos.length,1);
    assert.equal((await request('/todos/'+taskId,'PUT',{title:'수정됨',body:'새 내용',target_date:koreaDate()},adminCookie)).data.todo.title,'수정됨');
    assert.equal((await request('/todos/'+taskId,'PATCH',{done:true},adminCookie)).data.todo.done,1);
    assert.equal((await request('/todos','GET',undefined,adminCookie)).data.today_open,0);
    assert.equal((await request('/todos/'+taskId,'PATCH',{done:'yes'},adminCookie)).status,400);
    const viewer=await request('/users','POST',{name:'조회자',username:'viewer',email:'viewer@example.test',password:'test-password-1234',role:'viewer'},adminCookie);
    assert.equal(viewer.status,201);
    const login=await request('/auth/login','POST',{username:'viewer',password:'test-password-1234'});
    const viewerCookie=login.cookie;
    assert.deepEqual((await request('/todos','GET',undefined,viewerCookie)).data.todos,[]);
    assert.equal((await fetch(base+'/api/todo-files/'+fileId+'/download',{headers:{Cookie:viewerCookie}})).status,404);
    assert.equal((await request('/todos/'+taskId,'PUT',{title:'침범',body:'',target_date:koreaDate()},viewerCookie)).status,404);
    assert.equal((await request('/todos/'+taskId,'PATCH',{done:false},viewerCookie)).status,404);
    assert.equal((await request('/todos/'+taskId,'DELETE',undefined,viewerCookie)).status,404);
    assert.equal((await request('/todos','POST',{title:'내 메모',body:'',target_date:koreaDate()},viewerCookie)).status,201);
    assert.equal((await request('/todos/'+taskId,'DELETE',undefined,adminCookie)).status,200);
    assert.equal((await fetch(base+'/api/todo-files/'+fileId+'/download',{headers:{Cookie:adminCookie}})).status,404);
    assert.deepEqual((await request('/todos','GET',undefined,adminCookie)).data.todos,[]);
  }finally{await new Promise(resolve=>server.close(resolve));portal.db.close();}
});
