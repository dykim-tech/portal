import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortal } from '../server/app.mjs';

test('customer memo and dropped attachments remain available with role permissions',async()=>{
  const origin='http://localhost:3000';
  const portal=createPortal({dataDir:mkdtempSync(join(tmpdir(),'portal-customer-files-')),origin});
  const server=portal.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,method='GET',body,cookie='')=>{
    const response=await fetch(base+'/api'+path,{method,headers:{Origin:origin,'X-Portal-Request':'1','Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    const setup=await request('/auth/setup','POST',{token:readFileSync(portal.tokenPath,'utf8'),name:'관리자',username:'admin',email:'admin@example.test',password:'test-password-1234'});
    const admin=setup.cookie;
    const created=await request('/customers','POST',{name:'고객사',contact:'010-1234',notes:'현장 메모',active:true},admin);
    assert.equal(created.status,201);
    const customerId=created.data.customer.id;
    const body=new FormData();body.append('file',new Blob(['customer attachment']),'info.txt');
    const response=await fetch(base+'/api/customers/'+customerId+'/files',{method:'POST',headers:{Origin:origin,'X-Portal-Request':'1',Cookie:admin},body});
    assert.equal(response.status,201);
    const fileId=(await response.json()).id;
    const customers=await request('/customers','GET',undefined,admin);
    assert.equal(customers.data.customers[0].notes,'현장 메모');
    assert.equal(customers.data.customers[0].files[0].name,'info.txt');
    const download=await fetch(base+'/api/customer-files/'+fileId+'/download',{headers:{Cookie:admin}});
    assert.equal(await download.text(),'customer attachment');
    const viewer=await request('/users','POST',{name:'조회자',username:'viewer',email:'viewer@example.test',password:'test-password-1234',role:'viewer'},admin);
    assert.equal(viewer.status,201);
    const login=await request('/auth/login','POST',{username:'viewer',password:'test-password-1234'});
    assert.equal((await request('/customers/'+customerId+'/files','POST',{},login.cookie)).status,403);
    assert.equal((await request('/customer-files/'+fileId,'DELETE',undefined,login.cookie)).status,403);
    assert.equal((await request('/customer-files/'+fileId,'DELETE',undefined,admin)).status,200);
    assert.equal((await fetch(base+'/api/customer-files/'+fileId+'/download',{headers:{Cookie:admin}})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));portal.db.close();}
});
