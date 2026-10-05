import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtras } from '../public/extras.js';

test('TO-DO List has its own screen and work logs stay directly visible',async()=>{
  const oldDocument=globalThis.document;
  const content={innerHTML:''},requests=[],dialogs=[];
  const field={closest:()=>({insertAdjacentHTML(){}})};
  globalThis.document={querySelector(selector){
    if(selector==='#content')return content;
    if(selector.startsWith('#work-filter'))return field;
    if(selector==='#content .classified-main table')return null;
    return null;
  }};
  const state={view:'todos',user:{name:'관리자'}};
  const todos=[{id:5,title:'오늘 할 일',body:'내용',target_date:'2026-10-04',done:0},{id:6,title:'끝낸 메모',body:'완료한 내용',target_date:'2026-10-03',done:1,files:[{id:7,name:'완료자료.txt'}]}];
  const api=async (path,options)=>{
    requests.push(path);
    if(path==='/todos')return {todos,today_open:todos.filter(row=>!row.done).length};
    if(path==='/todos/5'&&options?.method==='PATCH'){todos[0].done=1;return {todo:todos[0]};}
    if(path==='/customers')return {customers:[]};
    if(path.startsWith('/work-logs?'))return {logs:[],total:0,page:1};
    throw new Error('Unexpected request: '+path);
  };
  const extras=createExtras({api,esc:value=>String(value??''),state,features:{},canEdit:()=>true,openDialog:(title,body)=>dialogs.push({title,body}),input:()=>'',toast:()=>{},fmt:value=>value,pageHead:(_tag,title)=>`<h1>${title}</h1>`,renderItems:()=>{},renderInstallations:()=>{},renderView:()=>{},modal:{},listingQuery:()=>({page:1}),decorateListing:()=>{}});
  try{
    await extras.renderTodos();
    assert.match(content.innerHTML,/<h1>TO-DO List<\/h1>/);
    assert.match(content.innerHTML,/오늘 할 일/);
    assert.match(content.innerHTML,/data-todo-field="body"/);
    assert.match(content.innerHTML,/오늘 할 일\n내용/);
    assert.match(content.innerHTML,/class="done-board"/);
    assert.match(content.innerHTML,/data-action="todo-open-done" data-id="6"/);
    assert.doesNotMatch(content.innerHTML,/data-todo-id="6"/);
    assert.doesNotMatch(content.innerHTML,/todo-search|todo-empty|할 일 검색/);
    await extras.action('todo-open-done','6',{dataset:{}});
    assert.match(dialogs[0].body,/완료한 내용/);
    assert.match(dialogs[0].body,/완료자료.txt/);
    assert.match(dialogs[0].body,/data-action="todo-restore"/);
    await extras.toggleTodo({checked:true,closest:()=>({dataset:{todoId:'5'}})});
    assert.match(content.innerHTML,/data-action="todo-open-done" data-id="5"/);
    assert.doesNotMatch(content.innerHTML,/data-todo-id="5"/);
    assert.doesNotMatch(content.innerHTML,/data-action="todo-edit"|data-todo-field="title"/);
    assert.equal(requests.some(path=>path.startsWith('/work-logs?')),false);
    requests.length=0;
    state.view='work';
    await extras.renderWork();
    assert.match(content.innerHTML,/<h1>업무관리<\/h1>/);
    assert.match(content.innerHTML,/업무일지/);
    assert.doesNotMatch(content.innerHTML,/class="todo-grid"/);
    assert.equal(requests.some(path=>path.startsWith('/todos?')),false);
  }finally{globalThis.document=oldDocument;}
});
