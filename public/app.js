import { createExtras } from './extras.js';
const root=document.querySelector('#app'), modal=document.querySelector('#modal');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={general:'일반 비품',it:'IT 장비',active:'사용 중',stored:'보관 중',repair:'점검·수리',retired:'사용 종료',admin:'관리자',editor:'편집자',viewer:'조회자',upcoming:'기한 예정',today:'오늘 기한',overdue:'기한 경과'};
const fields={name:'자산명',asset_code:'관리번호',category:'분류',status:'상태',quantity:'수량',location:'보관 위치',owner:'담당자',serial:'시리얼 번호',description:'설명',due_date:'관리 기한',reminder_days:'사전 알림'};
const state={user:null,view:'dashboard',page:1,filters:{},item:null,users:[],unread:0};
const fmt=v=>v?new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(v)):'—';
const canEdit=()=>['admin','editor'].includes(state.user?.role);
const options=(values,selected)=>values.map(v=>`<option value="${v}" ${v===selected?'selected':''}>${labels[v]??v}</option>`).join('');
let toastTimer, pollTimer;
function toast(message){document.querySelector('#toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>document.querySelector('#toast').textContent='',4500);}
async function api(path,options={}){
  const {body,...rest}=options;
  const response=await fetch('/api'+path,{...rest,headers:{'X-Portal-Request':'1',...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){if(response.status===401&&state.user){state.user=null;clearInterval(pollTimer);modal.close();authPage(false);}throw new Error(data.error??'요청을 처리하지 못했습니다.');}
  return data;
}
function authPage(setup){
  root.innerHTML=`<div class="auth-page"><section class="auth-story"><div class="brand"><img src="/favicon.svg" alt=""><div>PORTAL<small>PERSONAL ASSET WORKSPACE</small></div></div><div><h1>물품과 자료,<br>하나의 작업 공간.</h1><p>일반 비품부터 IT 장비까지.<br>등록된 자료와 다가오는 기한을 함께 관리하세요.</p><div class="auth-list"><div><span>01</span>비품·IT 자산 통합 관리</div><div><span>02</span>첨부자료와 변경 이력</div><div><span>03</span>기한 알림과 사용자 권한</div></div></div><footer>DYKIM · PERSONAL PORTAL</footer></section><section class="auth-form-wrap"><div class="auth-form"><p class="eyebrow">${setup?'WELCOME TO PORTAL':'YOUR WORKSPACE'}</p><h2>${setup?'첫 관리자 만들기':'로그인'}</h2><p>${setup?'서버의 초기 설정 코드로 관리자 계정을 만들어 주세요.':'등록된 계정으로 포털에 접속하세요.'}</p><form id="auth-form" data-setup="${setup}"><div class="error" role="alert"></div>${setup?'<label>초기 설정 코드<input name="token" required autocomplete="off" spellcheck="false"></label><label>관리자 이름<input name="name" required maxlength="100" autocomplete="name"></label>':''}<label>이메일<input name="email" type="email" required maxlength="254" autocomplete="username"></label><label>비밀번호<input name="password" type="password" required ${setup?'minlength="12"':''} maxlength="128" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'12자 이상 입력':'비밀번호 입력'}"></label><button class="primary">${setup?'관리자 계정 생성':'로그인'}</button></form><p class="auth-note">${setup?'초기 설정 코드는 서버의 data/setup-token.txt 파일에서 확인할 수 있습니다. 최초 등록 후 코드는 폐기됩니다.':'계정이 없거나 비밀번호를 잊으셨다면 포털 관리자에게 문의하세요.'}</p></div></section></div>`;
}
function shell(){
  const menus=[['dashboard','◫','대시보드'],['installations','⌘','설치관리'],['library','▤','자료 관리'],['items','▦','자산 관리'],['work','▤','업무관리'],['reports','▥','리포트'],...(state.user.role==='admin'?[['users','♙','사용자 관리']]:[]),['settings','⚙','설정']];
  root.innerHTML=`<div class="layout"><aside class="sidebar"><div class="brand"><img src="/favicon.svg" alt=""><div>PORTAL<small>PERSONAL WORKSPACE</small></div></div><nav class="nav" aria-label="주 메뉴">${menus.map(([view,icon,name])=>`<button data-view="${view}"><span class="nav-symbol">${icon}</span>${name}</button>`).join('')}</nav><div class="sidebar-foot"><a href="https://github.com/dykim-tech/portal" target="_blank" rel="noopener">GitHub 저장소</a><div class="account"><strong>${esc(state.user.name)}</strong><small>${labels[state.user.role]}</small><div class="account-actions"><button data-action="password">비밀번호 변경</button><button data-action="logout">로그아웃</button></div></div></div></aside><div class="workspace"><header class="topbar"><span>내 작업 공간 / <strong id="breadcrumb"></strong></span><div class="topbar-tools"><button class="small" data-view="notifications">기한 알림 <span id="nav-count" class="badge" hidden></span></button><span>${esc(state.user.name)} · ${labels[state.user.role]}</span><button class="small mobile-account" data-action="account">계정</button></div></header><main class="content" id="content"></main></div></div>`;
  updateNav();
}
function updateNav(){document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));const count=document.querySelector('#nav-count');if(count){count.textContent=state.unread;count.hidden=!state.unread;}const bread=document.querySelector('#breadcrumb');if(bread)bread.textContent={dashboard:'대시보드',installations:'설치관리',library:'자료 관리',items:'자산 관리',work:'업무관리',reports:'리포트',notifications:'기한 알림',users:'사용자 관리',settings:'설정'}[state.view];}
async function refreshCount(){const result=await api('/notifications');state.unread=result.unread;updateNav();return result;}
async function signedIn(user){state.user=user;state.view='dashboard';shell();await renderView();await refreshCount();clearInterval(pollTimer);pollTimer=setInterval(()=>{if(state.user)refreshCount().catch(()=>{});},60000);}
async function renderView(){updateNav();if(state.view==='items')await renderItems();else if(state.view==='users')await renderUsers();else if(state.view==='notifications')await renderNotifications();else if(state.view==='dashboard')await renderDashboard();else if(state.view==='installations')await renderInstallations();else if(state.view==='library')await renderLibrary();else if(state.view==='work')await extras.renderWork();else if(state.view==='reports')await extras.renderReports();else renderSettings();}
async function renderItems(){
  await extras.loadCategories('items');
  const result=await api('/items?'+new URLSearchParams({...state.filters,page:state.page}));
  if(state.view!=='items')return;
  const f=state.filters,s=result.stats;
  document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">ASSET LIBRARY</p><h1>자산 관리</h1><p>비품과 IT 장비의 최신 자료를 한눈에 확인하세요.</p></div>${canEdit()?'<button class="primary" data-action="new-item">＋ 자산 등록</button>':''}</div><div class="stats">${[['전체 자산',s.total],['일반 비품',s.general],['IT 장비',s.it],['점검·수리 중',s.repair]].map(([label,value])=>`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}<span>건</span></div></div>`).join('')}</div><section class="panel"><div class="panel-head"><h2>등록 자료 <small>${result.total}건</small></h2><small>최근 수정순</small></div><form class="filters" id="filter-form"><label>통합 검색<input name="q" placeholder="자산명, 관리번호, 담당자, 시리얼" value="${esc(f.q)}"></label><label>자산 유형<select name="category"><option value="">모든 분류</option>${options(['general','it'],f.category)}</select></label><label>상태<select name="status"><option value="">모든 상태</option>${options(['active','stored','repair','retired'],f.status)}</select></label><button class="primary">조회</button><div class="date-row"><label>수정일 시작<input name="from" type="date" value="${esc(f.from)}"></label><label>수정일 종료<input name="to" type="date" value="${esc(f.to)}"></label><label class="checkbox"><input name="due" type="checkbox" value="set" ${f.due?'checked':''}>기한이 있는 물품만</label><button type="button" class="ghost small" data-action="reset-filter">필터 초기화</button></div></form>${result.items.length?`<div class="table-wrap"><table><thead><tr><th>자산명 / 관리번호</th><th>분류</th><th>상태</th><th>담당자 / 위치</th><th>관리 기한</th><th>최근 수정</th><th>자료</th></tr></thead><tbody>${result.items.map(i=>`<tr><td><div class="item-name"><span class="item-icon" aria-hidden="true">${i.category==='it'?'▣':'▦'}</span><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)}</span></button></div></td><td>${labels[i.category]}<span class="secondary-line">${esc(extras.categoryPath('items',i.category_id))}</span></td><td><span class="badge ${i.status}">${labels[i.status]}</span></td><td>${esc(i.owner)||'—'}<span class="secondary-line">${esc(i.location)||'위치 미지정'}</span></td><td>${esc(i.due_date)||'—'}</td><td>${fmt(i.updated_at)}<span class="secondary-line">${esc(i.updated_by_name)}</span></td><td>${i.file_count}개</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><h3>${s.total?'검색 결과가 없습니다':'아직 등록된 물품이 없습니다'}</h3><p>${s.total?'검색어나 필터 조건을 바꿔 보세요.':'비품이나 IT 장비를 등록하고 자료와 관리 기한을 추가해 보세요.'}</p>${canEdit()&&!s.total?'<button data-action="new-item">첫 자산 등록</button>':''}</div>`}<div class="footer-row"><span>등록 자료 ${result.total}건 · 한국 표준시 기준</span><div class="pager"><button class="small" data-action="prev" ${state.page<=1?'disabled':''}>이전</button><span>${state.page} / ${Math.max(1,result.pages)}</span><button class="small" data-action="next" ${state.page>=result.pages?'disabled':''}>다음</button></div></div></section>`;
  extras.attachCategoryPanel('items');
}
function openDialog(title,body){modal.classList.remove('preview-dialog');modal.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="ghost small" data-action="close" aria-label="창 닫기">닫기</button></div><div class="dialog-body"><div class="error" id="dialog-error" role="alert"></div>${body}</div>`;if(!modal.open)modal.showModal();}
function input(name,label,value='',extra=''){return `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;}
function historyText(h){if(h.action!=='수정')return h.action==='등록'?'자산 정보 최초 등록':h.detail;try{return Object.entries(JSON.parse(h.detail)).map(([key,val])=>`${fields[key]??key}: ${labels[val.before]??val.before??'없음'} → ${labels[val.after]??val.after??'없음'}`).join('\n')||'변경 사항 없음';}catch{return h.detail;}}
async function itemDialog(id){
  await extras.loadCategories('items');
  const result=id?await api('/items/'+id):{item:{category:'general',status:'active',quantity:1,reminder_days:7},files:[],history:[]};
  state.item=result.item;const i=result.item,disabled=canEdit()?'':'disabled';
  openDialog(id?'자산 상세 정보':'새 자산 등록',`<form id="item-form"><div class="form-grid">${input('name','자산명 *',i.name,`required maxlength="150" ${disabled}`)}${input('asset_code','관리번호 *',i.asset_code,`required maxlength="80" placeholder="예: IT-001" ${disabled}`)}<label>분류 *<select name="category" ${disabled}>${options(['general','it'],i.category)}</select></label>${extras.leafSelect('items',i.category_id,!id)}<label>상태 *<select name="status" ${disabled}>${options(['active','stored','repair','retired'],i.status)}</select></label>${input('quantity','수량 *',i.quantity,`type="number" required min="0" max="1000000" ${disabled}`)}${input('owner','담당자',i.owner,`maxlength="200" ${disabled}`)}${input('location','보관 위치',i.location,`maxlength="200" ${disabled}`)}${input('serial','시리얼 번호',i.serial,`maxlength="200" ${disabled}`)}${input('due_date','관리 기한',i.due_date,`type="date" ${disabled}`)}${input('reminder_days','사전 알림 (일 전)',i.reminder_days,`type="number" min="0" max="365" required ${disabled}`)}<label class="full">설명·관리 메모<textarea name="description" maxlength="10000" ${disabled}>${esc(i.description)}</textarea></label></div><p class="help-line">관리 기한은 점검·보증·반납 등 필요한 날짜로 설정하세요. 사전 알림일, 기한 당일, 기한 경과 시 포털에 알림이 생성됩니다. 사용 종료 물품은 제외됩니다.</p>${canEdit()?`<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">${id?'변경 저장':'자산 등록'}</button></div>`:''}</form>${id?`<section class="subsection"><h3>첨부자료 <small>${result.files.length}개</small></h3>${result.files.length?result.files.map(f=>`<div class="file-row"><div><a href="/api/files/${f.id}">${esc(f.name)}</a><span class="secondary-line">${(f.size/1024).toFixed(1)} KB · ${fmt(f.created_at)}</span></div>${canEdit()?`<button class="small danger" data-action="delete-file" data-id="${f.id}">삭제</button>`:''}</div>`).join(''):'<p class="muted">등록된 첨부자료가 없습니다.</p>'}${canEdit()?'<form class="upload" id="upload-form"><input aria-label="첨부할 자료" type="file" name="file" required><button type="submit">자료 첨부</button></form><p class="help-line">파일당 최대 10MB · 물품당 총 50MB. 자산 정보 변경은 먼저 저장한 뒤 첨부하세요.</p>':''}</section><section class="subsection"><h3>최근 변경 이력</h3>${result.history.map(h=>`<div class="history-row"><strong>${esc(h.action)}</strong>${esc(h.actor)}<small>${fmt(h.created_at)}</small><div class="history-detail">${esc(historyText(h))}</div></div>`).join('')}</section>`:'<p class="save-note">자산 등록을 완료하면 첨부자료를 추가할 수 있습니다.</p>'}`);
}
async function renderUsers(){const {users}=await api('/users');state.users=users;if(state.view!=='users')return;document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">ACCESS MANAGEMENT</p><h1>사용자 관리</h1><p>계정별 접근 권한과 사용 상태를 관리하세요.</p></div><button class="primary" data-action="new-user">＋ 사용자 추가</button></div><div class="notice">관리자: 사용자·자료 관리 · 편집자: 물품·자료 등록 및 수정 · 조회자: 자료 열람 및 알림 확인</div><section class="panel"><div class="panel-head"><h2>등록 사용자 <small>${users.length}명</small></h2></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>이메일</th><th>권한</th><th>계정 상태</th><th>등록일</th><th>관리</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.name)} ${u.id===state.user.id?'<span class="badge">나</span>':''}</td><td>${esc(u.email)}</td><td>${labels[u.role]}</td><td><span class="badge ${u.active?'active':'retired'}">${u.active?'활성':'비활성'}</span></td><td>${fmt(u.created_at)}</td><td><button class="small" data-action="user" data-id="${u.id}">수정</button></td></tr>`).join('')}</tbody></table></div></section>`;}
function userDialog(id){const u=state.users.find(u=>u.id===Number(id))??{role:'viewer',active:true};state.editUser=u;openDialog(id?'사용자 수정':'사용자 추가',`<form id="user-form"><div class="form-grid">${input('name','이름 *',u.name,'required maxlength="100" autocomplete="off"')}${input('email','이메일 *',u.email,'type="email" required maxlength="254" autocomplete="off"')}<label>권한<select name="role">${options(['admin','editor','viewer'],u.role)}</select></label>${input('password',id?'새 비밀번호 (변경할 때만)':'초기 비밀번호 *','','type="password" minlength="12" maxlength="128" autocomplete="new-password" '+(id?'':'required'))}${id?`<label class="checkbox-line"><input name="active" type="checkbox" ${u.active?'checked':''}>계정 활성화</label>`:''}</div><p class="help-line">비밀번호는 12자 이상입니다. 비밀번호·권한 변경 또는 계정 비활성화 시 기존 로그인이 해제됩니다.</p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);}
async function renderNotifications(){const result=await refreshCount();if(state.view!=='notifications')return;document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">DEADLINE INBOX</p><h1>기한 알림</h1><p>점검, 보증, 반납 등 놓치지 않아야 할 날짜를 확인하세요.</p></div><button data-action="read-all" ${result.unread?'':'disabled'}>모두 읽음</button></div><div class="notice">읽지 않은 알림 ${result.unread}건 · 서버가 실행되는 동안 1분마다 기한을 확인합니다. 알림은 포털 내부에서 제공되며, 종료된 동안 지난 기한은 다음 실행 시 확인합니다.</div><section class="panel"><div class="panel-head"><h2>최근 알림 <small>최대 200건 표시</small></h2><button class="small" data-action="refresh-notifications">새로고침</button></div><div class="notifications">${result.notifications.length?result.notifications.map(n=>`<article class="notification ${n.read_at?'':'unread'}"><span class="badge ${n.kind}">${labels[n.kind]}</span><div class="notification-content"><p>${esc(n.title)}</p><small>${esc(n.asset_code)} · ${fmt(n.created_at)}${n.read_at?' · 읽음':''}</small></div><div class="notification-actions"><button class="small" data-action="item" data-id="${n.item_id}">물품 보기</button>${!n.read_at?`<button class="small" data-action="read" data-id="${n.id}">읽음</button>`:''}</div></article>`).join(''):'<div class="empty"><h3>도착한 기한 알림이 없습니다</h3><p>물품의 관리 기한과 사전 알림 일수를 설정하면<br>해당 날짜에 알림이 표시됩니다.</p></div>'}</div></section>`;}
function passwordDialog(){openDialog('비밀번호 변경',`<form id="password-form"><div class="form-grid"><label class="full">현재 비밀번호<input name="current" type="password" required maxlength="128" autocomplete="current-password"></label><label class="full">새 비밀번호<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></div><p class="help-line">변경 후 모든 기기에서 로그아웃됩니다.</p><div class="form-actions"><button class="primary">비밀번호 변경</button></div></form>`);}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  try{
    if(button.dataset.view){state.view=button.dataset.view;await renderView();return;}
    const action=button.dataset.action,id=button.dataset.id;if(!action)return;
    if(action==='close'){modal.close();return;}
    if(await extras.action(action,id,button))return;
    if(await featureAction(action,id,button))return;
    if(action==='new-item'||action==='item')await itemDialog(id);
    if(action==='new-user'||action==='user')userDialog(id);
    if(action==='prev'||action==='next'){state.page+=action==='prev'?-1:1;await renderItems();}
    if(action==='reset-filter'){state.filters={};state.page=1;await renderItems();}
    if(action==='logout'){await api('/auth/logout',{method:'POST',body:{}});state.user=null;clearInterval(pollTimer);modal.close();authPage(false);}
    if(action==='password')passwordDialog();
    if(action==='account')openDialog('내 계정',`<p>${esc(state.user.name)} · ${labels[state.user.role]}</p><div class="form-actions"><button data-action="password">비밀번호 변경</button><button data-action="logout">로그아웃</button></div>`);
    if(action==='delete-file'&&confirm('첨부자료를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/files/'+id,{method:'DELETE'});await itemDialog(state.item.id);await renderView();toast('첨부자료를 삭제했습니다.');}
    if(action==='read'||action==='read-all'){await api('/notifications/read',{method:'POST',body:id?{id:Number(id)}:{}});await renderNotifications();}
    if(action==='refresh-notifications')await renderNotifications();
  }catch(error){if(modal.open)document.querySelector('#dialog-error').textContent=error.message;else toast(error.message);}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.id)return;event.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])');const errorBox=form.querySelector('.error')??document.querySelector('#dialog-error');if(errorBox)errorBox.textContent='';if(submit)submit.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(form));
    if(await extras.submit(form,values))return;
    if(await featureSubmit(form,values))return;
    if(form.id==='auth-form'){const result=await api('/auth/'+(form.dataset.setup==='true'?'setup':'login'),{method:'POST',body:values});await signedIn(result.user);}
    if(form.id==='filter-form'){if(values.from&&values.to&&values.from>values.to)throw new Error('종료일은 시작일 이후로 설정해 주세요.');const categoryId=state.filters.category_id;state.filters=Object.fromEntries(Object.entries(values).filter(([,v])=>v));if(categoryId)state.filters.category_id=categoryId;state.page=1;await renderItems();}
    if(form.id==='item-form'){values.quantity=Number(values.quantity);values.reminder_days=Number(values.reminder_days);values.version=state.item.version;const saved=await api('/items'+(state.item.id?'/'+state.item.id:''),{method:state.item.id?'PUT':'POST',body:values});await renderView();await itemDialog(saved.item.id);await refreshCount();toast('자산 정보를 저장했습니다.');}
    if(form.id==='upload-form'){const file=form.elements.file.files[0];if(file.size>10*1024*1024)throw new Error('파일은 10MB 이하로 첨부해 주세요.');await api('/items/'+state.item.id+'/files',{method:'POST',body:new FormData(form)});await itemDialog(state.item.id);await renderView();toast('첨부자료를 등록했습니다.');}
    if(form.id==='user-form'){values.active=state.editUser.id?form.elements.active.checked:true;await api('/users'+(state.editUser.id?'/'+state.editUser.id:''),{method:state.editUser.id?'PUT':'POST',body:values});modal.close();await renderUsers();toast('사용자 정보를 저장했습니다.');}
    if(form.id==='password-form'){await api('/auth/password',{method:'POST',body:values});modal.close();state.user=null;clearInterval(pollTimer);authPage(false);toast('비밀번호를 변경했습니다. 다시 로그인해 주세요.');}
  }catch(error){if(errorBox&&errorBox.isConnected)errorBox.textContent=error.message;else toast(error.message);}finally{if(submit?.isConnected)submit.disabled=false;}
});
Object.assign(labels,{planned:'설치 예정',installed:'설치 완료',maintenance:'유지보수',closed:'종료'});
let pdfDoc=null,pdfPage=1,pdfRender=null;
const features={installationPage:1,installationFilters:{},installation:null,folder:null,folderDepth:0,libraryPage:1,libraryQuery:''};
const extras=createExtras({api,esc,state,features,canEdit,openDialog,input,toast,fmt,pageHead,renderItems,renderInstallations,renderView,modal,labels});
applyTheme();
try{const result=await api('/auth/me');if(result.user)await signedIn(result.user);else authPage(result.setupRequired);}catch(error){root.innerHTML=`<main class="error-page"><h1>포털에 연결할 수 없습니다</h1><p>${esc(error.message)}</p><button onclick="location.reload()">다시 시도</button></main>`;root.querySelector('button').removeAttribute('onclick');root.querySelector('button').addEventListener('click',()=>location.reload());}


function applyTheme(mode){if(!mode){try{mode=localStorage.getItem('portal-theme')??'light';}catch{mode='light';}}document.documentElement.dataset.theme=mode==='dark'?'dark':'light';if(mode){try{localStorage.setItem('portal-theme',mode);}catch{}}}
function pageHead(tag,title,subtitle,action=''){return `<div class="page-head"><div><p class="eyebrow">${esc(tag)}</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;}
async function renderDashboard(){
 const d=await api('/dashboard');if(state.view!=='dashboard')return;
 document.querySelector('#content').innerHTML=pageHead('WORKSPACE OVERVIEW','대시보드',`${state.user.name}님, 오늘의 설치·자료·자산 현황입니다.`)+`<div class="stats">${[['등록 자산',d.counts.assets,'items'],['설치 정보',d.counts.installations,'installations'],['등록 자료',d.counts.manuals,'library'],['읽지 않은 알림',d.counts.unread,'notifications']].map(([name,n,view])=>`<button class="stat stat-button" data-view="${view}"><div class="stat-label">${name}</div><div class="stat-value">${n}<span>건</span></div></button>`).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2>다가오는 관리 기한</h2><button class="small" data-view="notifications">기한 알림 보기</button></div>${d.deadlines.length?d.deadlines.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)}</span></button><span class="badge ${i.due_date<d.today?'overdue':i.due_date===d.today?'today':'upcoming'}">${esc(i.due_date)}${i.due_date<d.today?' · 경과':i.due_date===d.today?' · 오늘':''}</span></div>`).join(''):'<div class="empty"><h3>7일 이내 예정된 기한이 없습니다</h3><p>자산의 관리 기한을 등록하면 여기에 표시됩니다.</p></div>'}</section><section class="panel"><div class="panel-head"><h2>최근 설치 정보</h2><button class="small" data-view="installations">전체 보기</button></div>${d.installations.length?d.installations.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.customer)} · ${i.installed_on}</span></button><span class="badge ${i.status}">${labels[i.status]}</span></div>`).join(''):'<div class="empty"><h3>아직 설치 정보가 없습니다</h3><p>사업장과 설치 제품 정보를 등록해 보세요.</p></div>'}</section><section class="panel full"><div class="panel-head"><h2>최근 업데이트한 자산</h2><button class="small" data-view="items">자산 관리</button></div>${d.recent.length?d.recent.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)} · ${labels[i.category]}</span></button><small>${fmt(i.updated_at)}</small></div>`).join(''):'<div class="empty"><h3>등록된 자산이 없습니다</h3><p>일반 비품과 IT 장비를 등록하고 관리하세요.</p></div>'}</section></div>`;
}
async function renderInstallations(){
  const d=await api('/installations?'+new URLSearchParams({...features.installationFilters,page:features.installationPage}));
  if(state.view!=='installations')return;
  const f=features.installationFilters;
  const shortDate=value=>value?value.slice(2).replaceAll('-','.'): '—';
  const rows=d.installations.map((i,index)=>`<tr>
    <td class="installation-number">${(d.page-1)*25+index+1}</td>
    <td class="installation-customer">${esc(i.customer)}</td>
    <td><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.name)}</button><span class="secondary-line">${esc(labels[i.status])}</span></td>
    <td class="installation-text">${esc(i.product_version)||'—'}</td>
    <td class="installation-number">${i.quantity??1}</td>
    <td>${shortDate(i.installed_on)}</td><td>${shortDate(i.completed_on)}</td>
    <td>${esc(i.contact)||'—'}</td><td>${esc(i.engineer)||'—'}</td>
    <td class="installation-text">${esc(i.notes)||'—'}</td>
  </tr>`).join('');
  document.querySelector('#content').innerHTML=pageHead('INSTALLATION RECORDS','설치관리','고객사별 설치 내역을 표 형태로 등록하고 조회하세요.',canEdit()?'<button class="primary" data-action="new-installation">＋ 설치 정보 등록</button>':'')+
    `<section class="panel"><div class="panel-head"><h2>설치 정보 <small>${d.total}건</small></h2></div>
    <form class="filters installation-filters" id="installation-filter">
      <label>검색<input name="q" value="${esc(f.q)}" placeholder="고객사, 제품명, 세부내용, 담당자"></label>
      <label>상태<select name="status"><option value="">모든 상태</option>${options(['planned','installed','maintenance','closed'],f.status)}</select></label>
      <label>설치시작일 시작<input name="from" type="date" value="${esc(f.from)}"></label>
      <label>설치시작일 종료<input name="to" type="date" value="${esc(f.to)}"></label>
      <button class="primary">조회</button><button type="button" data-action="reset-installations">초기화</button>
    </form>
    ${d.installations.length?`<div class="table-wrap"><table class="installation-sheet"><thead><tr><th>구분</th><th>고객사</th><th>제품명</th><th>세부내용</th><th>수량</th><th>설치시작일</th><th>설치종료일</th><th>담당자</th><th>설치엔지니어</th><th>비고</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty"><h3>표시할 설치 정보가 없습니다</h3><p>설치 정보를 등록하거나 검색 조건을 변경해 주세요.</p></div>'}
    <div class="footer-row"><span>설치 정보 ${d.total}건</span><div class="pager"><button class="small" data-action="installation-prev" ${d.page<=1?'disabled':''}>이전</button><span>${d.page} / ${Math.max(1,Math.ceil(d.total/25))}</span><button class="small" data-action="installation-next" ${d.page>=Math.ceil(d.total/25)?'disabled':''}>다음</button></div></div></section>`;
}
async function installationDialog(id){
  const result=id?await api('/installations/'+id):{installation:{status:'installed',installed_on:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date()),quantity:1},files:[]};
  const i=result.installation,disabled=canEdit()?'':'disabled';features.installation=i;
  openDialog(id?'설치 정보 상세':'설치 정보 등록',`<form id="installation-form"><div class="form-grid">
    ${input('customer','고객사 *',i.customer,`required maxlength="150" ${disabled}`)}
    ${input('name','제품명 *',i.name,`required maxlength="150" ${disabled}`)}
    ${input('product_version','세부내용',i.product_version,`maxlength="500" ${disabled}`)}
    ${input('quantity','수량 *',i.quantity??1,`type="number" min="1" max="1000000" step="1" required ${disabled}`)}
    ${input('installed_on','설치시작일 *',i.installed_on,`type="date" required ${disabled}`)}
    ${input('completed_on','설치종료일',i.completed_on,`type="date" ${disabled}`)}
    ${input('contact','담당자',i.contact,`maxlength="200" ${disabled}`)}
    ${input('engineer','설치엔지니어',i.engineer,`maxlength="200" ${disabled}`)}
    <label class="full">비고<textarea name="notes" maxlength="10000" ${disabled}>${esc(i.notes)}</textarea></label>
    <label>상태<select name="status" ${disabled}>${options(['planned','installed','maintenance','closed'],i.status)}</select></label>
    ${input('location','설치 위치',i.location,`maxlength="200" ${disabled}`)}
  </div>${canEdit()?'<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div>':''}</form>${id?`<section class="subsection"><h3>첨부자료 <small>${result.files.length}개</small></h3>${result.files.length?result.files.map(f=>`<div class="file-row"><div><strong>${esc(f.name)}</strong><span class="secondary-line">${fileSize(f.size)} · ${fmt(f.created_at)}</span></div><div class="file-actions">${f.preview_type?`<a href="/api/installation-files/${f.id}/preview" target="_blank" rel="noopener">미리보기</a>`:''}<a href="/api/installation-files/${f.id}/download">다운로드</a>${canEdit()?`<button class="small danger" data-action="installation-delete-file" data-id="${f.id}">삭제</button>`:''}</div></div>`).join(''):'<p class="muted">등록된 첨부자료가 없습니다.</p>'}${canEdit()?'<form class="upload" id="installation-upload"><input aria-label="첨부할 자료" type="file" name="file" required><button type="submit">자료 첨부</button></form><p class="help-line">파일당 최대 10MB · 설치 정보당 총 50MB.</p>':''}</section>`:'<p class="save-note">설치 정보를 먼저 저장하면 자료를 첨부할 수 있습니다.</p>'}`);
}
function fileSize(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';}
function fileType(name){return name.includes('.')?name.split('.').pop().slice(0,8).toUpperCase():'FILE';}
function folderTree(tree,parent=null,depth=0){return tree.filter(f=>f.parent_id===parent).map(f=>`<button class="folder-tree-link ${features.folder===f.id?'selected':''}" data-action="folder" data-id="${f.id}"><span>${'　'.repeat(depth)}▱</span>${esc(f.name)}</button>${folderTree(tree,f.id,depth+1)}`).join('');}
async function renderLibrary(){
 const d=await api('/library?'+new URLSearchParams({folder:features.folder??'',q:features.libraryQuery,page:features.libraryPage}));if(state.view!=='library')return;
 features.folderDepth=d.breadcrumbs.length;
 const controls=canEdit()?`<div class="head-actions">${features.folderDepth<3?`<button data-action="new-folder">＋ ${['대분류','중분류','소분류'][features.folderDepth]} 등록</button>`:''}${features.folderDepth===3?'<button class="primary" data-action="upload-manual">＋ 자료 등록</button>':''}</div>`:'';
 document.querySelector('#content').innerHTML=pageHead('DOCUMENT LIBRARY','자료 관리','대분류 · 중분류 · 소분류 순서로 자료를 정리하고 미리 확인하세요.',controls)+`<section class="panel explorer"><aside class="folder-tree"><div class="folder-tree-title">자료 분류</div><button class="folder-tree-link ${features.folder===null?'selected':''}" data-action="folder"><span>▱</span>전체 자료</button>${folderTree(d.tree)}</aside><div class="explorer-main"><div class="explorer-toolbar"><nav class="breadcrumbs" aria-label="폴더 경로"><button data-action="folder">전체 자료</button>${d.breadcrumbs.map(f=>`<span>/</span><button data-action="folder" data-id="${f.id}">${esc(f.name)}</button>`).join('')}</nav><form id="library-search" class="library-search"><input name="q" aria-label="현재 폴더 검색" placeholder="현재 폴더에서 검색" value="${esc(features.libraryQuery)}"><button>검색</button></form></div><div class="table-wrap"><table class="file-table"><thead><tr><th>이름</th><th>유형</th><th>크기</th><th>등록일</th><th>관리</th></tr></thead><tbody>${d.folders.map(f=>`<tr><td><button class="file-name" data-action="folder" data-id="${f.id}"><span class="folder-icon" aria-hidden="true">▰</span>${esc(f.name)}</button></td><td>${['대분류','중분류','소분류'][features.folderDepth]??'폴더'}</td><td>—</td><td>${fmt(f.created_at)}</td><td>${canEdit()?`<button class="small danger" data-action="delete-folder" data-id="${f.id}">삭제</button>`:''}</td></tr>`).join('')}${d.files.map(f=>`<tr><td><button class="file-name" data-action="preview" data-id="${f.id}"><span class="extension-icon">${esc(fileType(f.name))}</span><span>${esc(f.name)}<span class="secondary-line">${esc(f.uploaded_by_name)}</span></span></button></td><td>${esc(fileType(f.name))}</td><td>${fileSize(f.size)}</td><td>${fmt(f.created_at)}</td><td><div class="file-actions"><a href="/api/manuals/${f.id}/download">다운로드</a>${canEdit()?`<button class="small danger" data-action="delete-manual" data-id="${f.id}">삭제</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>${!d.folders.length&&!d.files.length?'<div class="empty"><h3>표시할 폴더나 파일이 없습니다</h3><p>새 폴더를 만들거나 자료를 등록하세요.<br>검색 중이라면 검색어를 바꿔 보세요.</p></div>':''}<div class="footer-row"><span>폴더 ${d.folders.length}개 · 파일 ${d.total}개</span><div class="pager"><button class="small" data-action="library-prev" ${d.page<=1?'disabled':''}>이전</button><span>${d.page} / ${Math.max(1,Math.ceil(d.total/50))}</span><button class="small" data-action="library-next" ${d.page>=Math.ceil(d.total/50)?'disabled':''}>다음</button></div></div></div></section><p class="help-line">대분류→중분류→소분류에서 자료를 등록합니다. 파일당 최대 10MB · PDF, PNG, JPG, GIF, WebP, 텍스트 파일 미리보기 지원. Office·HWP 등 그 외 파일은 다운로드로 확인하세요.</p>`;
}
async function previewDialog(id){
 const {file:f}=await api('/manuals/'+id);const url='/api/manuals/'+f.id+'/preview';
 openDialog(f.name,`<div class="preview-toolbar"><span>${fileSize(f.size)} · ${fmt(f.created_at)}</span><a href="/api/manuals/${f.id}/download">다운로드</a></div>${f.preview_type?.startsWith('image/')?`<div class="image-preview"><img src="${url}" alt="${esc(f.name)}"></div>`:f.preview_type==='application/pdf'?'<div class="pdf-controls"><button class="small" data-action="pdf-prev">이전 페이지</button><span id="pdf-page-label">불러오는 중</span><button class="small" data-action="pdf-next">다음 페이지</button></div><div id="pdf-surface" class="pdf-surface"></div>':f.preview_type?`<iframe class="document-preview" src="${url}" title="${esc(f.name)} 미리보기" sandbox></iframe><p class="help-line">브라우저에서 미리보기가 표시되지 않으면 다운로드로 확인해 주세요.</p>`:'<div class="empty"><h3>이 형식은 미리보기를 지원하지 않습니다</h3><p>다운로드하여 해당 프로그램에서 열어 주세요.</p></div>'}`);modal.classList.add('preview-dialog');
 if(f.preview_type==='application/pdf')await loadPdf(url);
}
function renderSettings(){
 const dark=document.documentElement.dataset.theme==='dark';
 document.querySelector('#content').innerHTML=pageHead('PREFERENCES','설정','작업 환경과 계정 설정을 관리하세요.')+`<section class="panel settings-panel"><div class="panel-head"><h2>화면 모드</h2><small>이 브라우저에 저장됩니다.</small></div><div class="theme-options"><button class="theme-option ${!dark?'selected':''}" data-action="theme" data-mode="light" aria-pressed="${!dark}"><span class="theme-swatch light-swatch">Aa</span><strong>일반 모드</strong><small>밝은 배경의 기본 화면</small></button><button class="theme-option ${dark?'selected':''}" data-action="theme" data-mode="dark" aria-pressed="${dark}"><span class="theme-swatch dark-swatch">Aa</span><strong>다크 모드</strong><small>눈부심이 적은 어두운 화면</small></button></div></section><section class="panel settings-panel"><div class="panel-head"><h2>내 계정</h2></div><div class="settings-account"><div><strong>${esc(state.user.name)}</strong><p class="muted">${esc(state.user.email)} · ${labels[state.user.role]}</p></div><button data-action="password">비밀번호 변경</button></div></section>`;
}
async function featureAction(action,id,button){
 switch(action){
 case 'new-installation':case 'installation':await installationDialog(id);return true;
 case 'reset-installations':features.installationFilters={};features.installationPage=1;await renderInstallations();return true;
 case 'installation-prev':case 'installation-next':features.installationPage+=action.endsWith('prev')?-1:1;await renderInstallations();return true;
 case 'folder':features.folder=id?Number(id):null;features.libraryPage=1;features.libraryQuery='';await renderLibrary();return true;
 case 'library-prev':case 'library-next':features.libraryPage+=action.endsWith('prev')?-1:1;await renderLibrary();return true;
 case 'new-folder':if(features.folderDepth>=3)throw new Error('소분류 아래에는 분류를 더 만들 수 없습니다.');openDialog(['대분류','중분류','소분류'][features.folderDepth]+' 등록',`<form id="folder-form">${input('name','분류명 *','','required maxlength="100"')}<div class="form-actions"><button class="primary">분류 등록</button></div></form>`);return true;
 case 'upload-manual':if(features.folderDepth!==3)throw new Error('소분류를 선택한 뒤 자료를 등록해 주세요.');openDialog('자료 등록','<form id="manual-form"><label>등록할 파일<input name="file" type="file" required></label><p class="help-line">현재 폴더에 등록됩니다. 파일당 최대 10MB입니다.</p><div class="form-actions"><button class="primary">자료 등록</button></div></form>');return true;
 case 'preview':await previewDialog(id);return true;
 case 'pdf-prev':case 'pdf-next':pdfPage+=action==='pdf-prev'?-1:1;await renderPdfPage();return true;
 case 'delete-folder':if(confirm('비어 있는 분류를 삭제할까요?')){await api('/folders/'+id,{method:'DELETE'});await renderLibrary();toast('분류를 삭제했습니다.');}return true;
 case 'delete-manual':if(confirm('자료를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/manuals/'+id,{method:'DELETE'});await renderLibrary();toast('자료를 삭제했습니다.');}return true;
 case 'installation-delete-file':if(confirm('첨부자료를 삭제할까요?')){await api('/installation-files/'+id,{method:'DELETE'});await installationDialog(features.installation.id);await renderView();toast('첨부자료를 삭제했습니다.');}return true;
 case 'theme':applyTheme(button.dataset.mode);renderSettings();return true;
 default:return false;
 }
}
async function featureSubmit(form,values){
 switch(form.id){
 case 'installation-filter':if(values.from&&values.to&&values.from>values.to)throw new Error('종료일은 시작일 이후로 설정해 주세요.');features.installationFilters=Object.fromEntries(Object.entries(values).filter(([,v])=>v));features.installationPage=1;await renderInstallations();return true;
 case 'installation-form':values.version=features.installation.version;values.category_id=features.installation.category_id??null;{const saved=await api('/installations'+(features.installation.id?'/'+features.installation.id:''),{method:features.installation.id?'PUT':'POST',body:values});await renderView();await installationDialog(saved.installation.id);toast('설치 정보를 저장했습니다.');}return true;
 case 'folder-form':await api('/folders',{method:'POST',body:{...values,parent_id:features.folder}});modal.close();await renderLibrary();toast('분류를 만들었습니다.');return true;
 case 'manual-form':if(features.folderDepth!==3)throw new Error('소분류를 선택해 주세요.');if(form.elements.file.files[0].size>10*1024*1024)throw new Error('파일은 10MB 이하로 등록해 주세요.');await api('/manuals?'+new URLSearchParams({folder:features.folder??''}),{method:'POST',body:new FormData(form)});modal.close();await renderLibrary();toast('자료를 등록했습니다.');return true;
 case 'installation-upload':{const file=form.elements.file.files[0];if(file.size>10*1024*1024)throw new Error('파일은 10MB 이하로 첨부해 주세요.');await api('/installations/'+features.installation.id+'/files',{method:'POST',body:new FormData(form)});await installationDialog(features.installation.id);await renderView();toast('첨부자료를 등록했습니다.');}return true;
 case 'library-search':features.libraryQuery=values.q;features.libraryPage=1;await renderLibrary();return true;
 default:return false;
 }
}

async function loadPdf(url){
 if(pdfDoc)await pdfDoc.destroy();
 const pdfjs=await import('/vendor/pdfjs/build/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.min.mjs';
 pdfDoc=await pdfjs.getDocument({url,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/',isEvalSupported:false}).promise;pdfPage=1;await renderPdfPage();
}
async function renderPdfPage(){
 const surface=document.querySelector('#pdf-surface');if(!surface||!pdfDoc)return;
 if(pdfRender){pdfRender.cancel();try{await pdfRender.promise;}catch{}}
 const page=await pdfDoc.getPage(pdfPage);const base=page.getViewport({scale:1});const scale=Math.min(2,(surface.clientWidth-24)/base.width);const viewport=page.getViewport({scale:Math.max(.3,scale)});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;canvas.setAttribute('aria-label','PDF '+pdfPage+' 페이지');surface.replaceChildren(canvas);
 document.querySelector('#pdf-page-label').textContent=pdfPage+' / '+pdfDoc.numPages;document.querySelector('[data-action=pdf-prev]').disabled=pdfPage<=1;document.querySelector('[data-action=pdf-next]').disabled=pdfPage>=pdfDoc.numPages;
 pdfRender=page.render({canvasContext:canvas.getContext('2d'),viewport});await pdfRender.promise;pdfRender=null;
}
modal.addEventListener('close',()=>{if(pdfRender){pdfRender.cancel();pdfRender=null;}if(pdfDoc){pdfDoc.destroy();pdfDoc=null;}});
