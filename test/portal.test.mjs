import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';
import { openDatabase, scanDeadlines, koreaDate } from '../server/db.mjs';
const origin='http://localhost:3000', password='test-only-password-1234';
test('portal integration', async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'portal-test-'));
  const portal=createPortal({dataDir,origin,secure:false});
  const server=portal.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  async function request(path,{method='GET',body,session=cookie,headers={}}={}){
    const response=await fetch(base+'/api'+path,{method,headers:{Origin:origin,'X-Portal-Request':'1',...(body instanceof FormData?{}:{'Content-Type':'application/json'}),Cookie:session,...headers},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
    return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text(),headers:response.headers};
  }
  let item,viewer,editor,viewerCookie,editorCookie;
  try{
    await t.test('anonymous reads and cross-origin writes rejected',async()=>{
      assert.equal((await request('/items')).status,401);
      assert.equal((await request('/auth/login',{method:'POST',body:{},headers:{Origin:'https://attacker.invalid'}})).status,403);
      assert.equal((await request('/auth/login',{method:'POST',body:{},headers:{'X-Portal-Request':''}})).status,403);
    });
    await t.test('one-time setup and protected session',async()=>{
      assert.equal((await request('/auth/setup',{method:'POST',body:{token:'wrong'}})).status,403);
      const result=await request('/auth/setup',{method:'POST',body:{token:readFileSync(portal.tokenPath,'utf8'),name:'테스트 관리자',username:'admin',email:'admin@example.test',password}});
      assert.equal(result.status,201);assert.equal(result.data.user.role,'admin');assert.equal(result.data.user.password,undefined);
      assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Strict/);
      cookie=result.headers.get('set-cookie').split(';')[0];assert.equal(existsSync(portal.tokenPath),false);
      assert.equal((await request('/auth/setup',{method:'POST',body:{}})).status,409);
    });
    await t.test('user creation and role boundaries',async()=>{
      for(const role of ['viewer','editor']){
        const result=await request('/users',{method:'POST',body:{name:role,username:role,email:`${role}@example.test`,password,role}});assert.equal(result.status,201);
        const login=await request('/auth/login',{method:'POST',body:{username:role,password},session:''});assert.equal(login.status,200);
        if(role==='viewer'){viewer=result.data.user;viewerCookie=login.headers.get('set-cookie').split(';')[0];}else{editor=result.data.user;editorCookie=login.headers.get('set-cookie').split(';')[0];}
      }
      assert.equal((await request('/users',{session:viewerCookie})).status,403);
      assert.equal((await request('/users',{method:'POST',session:editorCookie,body:{}})).status,403);
      assert.equal((await request('/items',{method:'POST',session:viewerCookie,body:{}})).status,403);
      assert.equal((await request('/users/1',{method:'PUT',body:{name:'관리자',username:'admin',email:'admin@example.test',role:'viewer',active:true}})).status,400);
    });
    await t.test('record validation and duplicate codes',async()=>{
      const result=await request('/items',{method:'POST',session:editorCookie,body:{name:'테스트 노트북 100%',asset_code:'IT-001',category:'it',status:'active',quantity:1,owner:'담당자',location:'사무실',serial:'SN-001',description:'<script>alert(1)</script>',due_date:koreaDate(),reminder_days:7}});
      assert.equal(result.status,201);item=result.data.item;
      assert.equal((await request('/items',{method:'POST',body:item})).status,409);
      assert.equal((await request('/items',{method:'POST',body:{...item,asset_code:'IT-002',quantity:-1}})).status,400);
      assert.equal((await request('/items',{method:'POST',body:{...item,asset_code:'IT-002',due_date:'2026-02-30'}})).status,400);
    });
    await t.test('literal wildcard search, category and date filters',async()=>{
      assert.equal((await request('/items?q=100%25')).data.total,1);
      assert.equal((await request('/items?q=unknown')).data.total,0);
      assert.equal((await request('/items?category=general')).data.total,0);
      assert.equal((await request('/items?category=it&due=set')).data.total,1);
      assert.equal((await request('/items?from=2100-01-01')).data.total,0);
      assert.equal((await request('/items?from='+koreaDate()+'&to='+koreaDate())).data.total,1);
      assert.equal((await request('/items?page=0')).status,400);
    });
    await t.test('concurrent edits protected and history saved',async()=>{
      const result=await request('/items/'+item.id,{method:'PUT',body:{...item,location:'보관실'}});assert.equal(result.status,200);
      assert.equal((await request('/items/'+item.id,{method:'PUT',body:item})).status,409);item=result.data.item;
      const detail=(await request('/items/'+item.id)).data;assert.equal(detail.history.length,2);assert.match(detail.history[0].detail,/보관실/);
    });
    await t.test('authenticated attachment upload, download and removal',async()=>{
      const form=new FormData();form.append('file',new Blob(['hello portal']),'점검기록.txt');
      assert.equal((await request('/items/'+item.id+'/files',{method:'POST',body:form})).status,201);
      const detail=(await request('/items/'+item.id)).data;const attachment=detail.files[0];assert.equal(attachment.name,'점검기록.txt');
      assert.equal((await request('/files/'+attachment.id,{session:''})).status,401);
      const file=await request('/files/'+attachment.id,{session:viewerCookie});assert.equal(file.data,'hello portal');assert.match(file.headers.get('content-disposition'),/attachment/);
      assert.equal((await request('/files/'+attachment.id,{method:'DELETE',session:viewerCookie})).status,403);
      assert.equal((await request('/files/'+attachment.id,{method:'DELETE'})).status,200);
      assert.equal((await request('/files/'+attachment.id)).status,404);
    });
    await t.test('notifications deduplicated, per-user read state and date removal',async()=>{
      const before=(await request('/notifications')).data;assert.equal(before.notifications.length,1);assert.equal(before.notifications[0].kind,'today');
      assert.equal((await request('/notifications')).data.notifications.length,1);
      await request('/notifications/read',{method:'POST',body:{id:before.notifications[0].id},session:viewerCookie});
      assert.equal((await request('/notifications')).data.unread,1);
      await request('/notifications/read',{method:'POST',body:{}});assert.equal((await request('/notifications')).data.unread,0);
      const current=(await request('/items/'+item.id)).data.item;
      await request('/items/'+item.id,{method:'PUT',body:{...current,due_date:null}});assert.equal((await request('/notifications')).data.notifications.length,0);
    });
    await t.test('disabling user revokes sessions',async()=>{
      assert.equal((await request('/users/'+viewer.id,{method:'PUT',body:{...viewer,active:false}})).status,200);
      assert.equal((await request('/items',{session:viewerCookie})).status,401);
      assert.equal((await request('/auth/login',{method:'POST',body:{username:viewer.username,password}})).status,401);
    });
    await t.test('password changes invalidate sessions',async()=>{
      assert.equal((await request('/auth/password',{method:'POST',session:editorCookie,body:{current:password,password:'changed-test-password-1234'}})).status,200);
      assert.equal((await request('/items',{session:editorCookie})).status,401);
    });
    await t.test('login rate limit',async()=>{
      let last;for(let i=0;i<16;i++)last=await request('/auth/login',{method:'POST',body:{username:'missing',password:'wrong'}});assert.equal(last.status,429);
    });
    await t.test('logout revokes session',async()=>{assert.equal((await request('/auth/logout',{method:'POST',body:{}})).status,200);assert.equal((await request('/items')).status,401);});
  }finally{await new Promise(resolve=>server.close(resolve));portal.db.close();}
  await t.test('database survives reopen',()=>{
    const reopened=createPortal({dataDir,origin,secure:false});assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM items').get().n,1);assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,3);assert.equal(existsSync(reopened.tokenPath),false);reopened.db.close();
  });
});
test('deadline boundaries use Asia/Seoul and catch up after offline periods',()=>{
  const db=openDatabase(mkdtempSync(join(tmpdir(),'portal-deadline-')));
  try{
    db.prepare("INSERT INTO users(id,name,email,password,role,created_at) VALUES(1,'test','test@example.test','test','admin','2026-01-01')").run();
    db.prepare("INSERT INTO items(name,asset_code,category,status,quantity,due_date,reminder_days,created_by,updated_by,created_at,updated_at) VALUES('test','IT-1','it','active',1,'2026-10-01',2,1,1,'2026-01-01','2026-01-01')").run();
    const count=()=>db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
    scanDeadlines(db,new Date('2026-09-28T14:59:59Z'));assert.equal(count(),0);
    scanDeadlines(db,new Date('2026-09-28T15:00:00Z'));assert.equal(count(),1);
    scanDeadlines(db,new Date('2026-09-29T15:00:00Z'));assert.equal(count(),1);
    scanDeadlines(db,new Date('2026-09-30T15:00:00Z'));assert.equal(count(),2);
    scanDeadlines(db,new Date('2026-10-04T00:00:00Z'));assert.equal(count(),3);
    scanDeadlines(db,new Date('2026-10-05T00:00:00Z'));assert.equal(count(),3);
    db.prepare("UPDATE items SET due_date='2026-10-06',status='retired'").run();scanDeadlines(db,new Date('2026-10-05T00:00:00Z'));assert.equal(count(),3);
  }finally{db.close();}
});
