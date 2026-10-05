import { createExtras } from './extras.js';
import { createManagement } from './management.js';
import { notificationHtml } from './notifications.js';
import { orderedMenuIds, moveMenuId } from './navigation.js';
const root=document.querySelector('#app'), modal=document.querySelector('#modal');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={general:'일반 비품',it:'IT 장비',active:'사용 중',stored:'보관 중',repair:'점검·수리',retired:'사용 종료',admin:'관리자',editor:'편집자',viewer:'조회자',upcoming:'기한 예정',today:'오늘 기한',overdue:'기한 경과'};
const fields={name:'자산명',asset_code:'관리번호',category:'분류',status:'상태',quantity:'수량',location:'보관 위치',owner:'담당자',serial:'시리얼 번호',description:'설명',due_date:'관리 기한',reminder_days:'사전 알림'};
const state={user:null,view:'dashboard',page:1,filters:{},item:null,users:[],unread:0,backups:[]};
const allowedPageSizes=[25,50,70,100];
function storedPageSize(key){try{const value=Number(localStorage.getItem('portal-page-size-'+key));return allowedPageSizes.includes(value)?value:50;}catch{return 50;}}
const tableState={items:{size:storedPageSize('items'),sort:'updated_at',direction:'desc'},installations:{size:storedPageSize('installations'),sort:'updated_at',direction:'desc'},library:{size:storedPageSize('library'),sort:'name',direction:'asc'},work:{size:storedPageSize('work'),sort:'work_date',direction:'desc'},users:{size:storedPageSize('users'),page:1,sort:'username',direction:'asc'}};
const tableColumns={items:['name','category','status','owner','due_date','updated_at','file_count'],installations:['id','customer','name','product_version','quantity','installed_on','completed_on','contact','engineer','notes'],library:['name','type','size','created_at',null],work:['work_date','customer','title','work_type','work_mode','owner','status','updated_at',null],users:['name','username','email','role','active','created_at',null]};
const fmt=v=>v?new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(v)):'—';
const canEdit=()=>['admin','editor'].includes(state.user?.role);
const options=(values,selected)=>values.map(v=>`<option value="${v}" ${v===selected?'selected':''}>${labels[v]??v}</option>`).join('');
let toastTimer, pollTimer;
let sidebarMenus=[],sidebarMenuOrder=[];
const sidebarMenuKey=()=>`portal-sidebar-menu-${state.user.id}`;
function saveSidebarMenu(){try{localStorage.setItem(sidebarMenuKey(),JSON.stringify(sidebarMenuOrder));}catch{toast('메뉴 순서를 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');}}
// 도구 메뉴: 자주 쓰는 외부 서비스를 새 탭에서 연다. 포털은 이 서비스들에 로그인하거나 파일을 저장하지 않는다.
const externalTools=[
  {name:'draw.io',url:'https://app.diagrams.net/',description:'다이어그램·구성도 그리기'},
  {name:'Claude',url:'https://claude.ai/',description:'Anthropic AI 어시스턴트'},
  {name:'ChatGPT',url:'https://chatgpt.com/',description:'OpenAI AI 어시스턴트'},
  {name:'Google Drive',url:'https://drive.google.com/',description:'Google 클라우드 파일 저장소'},
  {name:'Notion',url:'https://www.notion.so/',description:'문서·메모·업무 관리 워크스페이스'},
  // 이 PC에 설치된 Obsidian 앱을 obsidian:// 주소로 실행한다(웹 서비스가 아니므로 새 탭을 열지 않음).
  {name:'Obsidian',url:'obsidian://open',description:'메모·지식 관리 (이 PC의 Obsidian 앱 실행)',app:true},
  // VS Code는 설치 때 등록된 vscode: 주소로 실행한다.
  {name:'Visual Studio Code',url:'vscode://',description:'코드 편집기 (이 PC의 VS Code 실행)',app:true},
];
function renderTools(){
  document.querySelector('#content').innerHTML=pageHead('TOOLS','도구','자주 쓰는 웹 도구와 PC 앱을 바로 엽니다.')+`<section class="panel tools-panel"><div class="tools-grid">${externalTools.map(tool=>`<a class="tool-card" href="${esc(tool.url)}" ${tool.app?'':'target="_blank" rel="noopener noreferrer"'}><span class="tool-initial" aria-hidden="true">${esc(tool.name.slice(0,1).toUpperCase())}</span><span class="tool-text"><strong>${esc(tool.name)}</strong><small>${esc(tool.description)}</small><small class="tool-url">${tool.app?'PC 앱 실행':esc(tool.url.replace(/^https:\/\//,'').replace(/\/$/,''))+' ↗'}</small></span></a>`).join('')}</div></section><p class="help-line">웹 도구는 새 탭에서 열리며 인터넷 연결과 해당 서비스 계정이 필요합니다. 'PC 앱 실행' 도구(Obsidian·Visual Studio Code)는 이 PC에 설치된 앱을 실행하며, 처음 누를 때 브라우저가 앱 열기를 물으면 허용하세요.</p>`;
}
function renderSidebarMenu(){
  const nav=document.querySelector('#sidebar-nav');if(!nav)return;
  const names=new Map(sidebarMenus);
  nav.innerHTML=sidebarMenuOrder.map(id=>`<button type="button" data-view="${id}">${esc(names.get(id))}</button>`).join('');
  updateNav();
}
function renderSettingsMenu(){
  const container=document.querySelector('#settings-menu-order');if(!container)return;
  const names=new Map(sidebarMenus);
  container.innerHTML=`<div class="settings-menu-list">${sidebarMenuOrder.map((id,index)=>{const name=esc(names.get(id));return `<div class="settings-menu-row"><span>${name}</span><button type="button" class="small" data-action="menu-up" data-id="${id}" aria-label="${name} 위로 이동" ${index===0?'disabled':''}>↑</button><button type="button" class="small" data-action="menu-down" data-id="${id}" aria-label="${name} 아래로 이동" ${index===sidebarMenuOrder.length-1?'disabled':''}>↓</button></div>`;}).join('')}</div><button type="button" data-action="menu-reset">기본 순서로 되돌리기</button>`;
}
// 브라우저 뒤로가기 처리: 포털 화면 이동을 브라우저 기록에 남기고, 대시보드 아래에 '보호 기록'을 하나 둔다.
// 뒤로가기가 보호 기록에 닿으면 다시 대시보드로 돌려 놓아 포털 밖으로 나가지 않는다. 창이 열려 있으면 뒤로가기는 창만 닫는다.
// (Chrome은 사용자 조작 없이 추가된 기록을 뒤로가기에서 건너뛰므로, 보호 기록은 첫 클릭·키 입력 때 만든다.)
let historyIndex=0,historyGuarded=false;
function guardHistory(){
  if(historyGuarded||!state.user)return;
  historyGuarded=true;
  history.replaceState({portal:true,guard:true},'');
  history.pushState({portal:true,view:'dashboard',index:0},'');
  historyIndex=0;
  if(state.view!=='dashboard'){historyIndex=1;history.pushState({portal:true,view:state.view,index:1},'');}
}
for(const type of ['pointerdown','keydown'])document.addEventListener(type,guardHistory,{capture:true});
async function navigateTo(view){
  if(view!==state.view){guardHistory();state.view=view;historyIndex++;history.pushState({portal:true,view,index:historyIndex},'');}
  await renderView();
}
async function navigateBack(){if(historyGuarded&&historyIndex>0)history.back();else if(state.view!=='dashboard'){state.view='dashboard';historyIndex=0;await renderView();}}
window.addEventListener('popstate',event=>{
  if(!state.user)return;
  const entry=event.state;
  if(modal.open){modal.close();history.pushState({portal:true,view:state.view,index:historyIndex},'');return;}
  if(entry?.guard){
    history.pushState({portal:true,view:'dashboard',index:0},'');historyIndex=0;
    if(state.view!=='dashboard'){state.view='dashboard';renderView().catch(error=>toast(error.message));}
    toast('대시보드가 첫 화면입니다.');
    return;
  }
  if(!entry?.portal)return;
  historyIndex=entry.index??0;
  if(entry.view&&entry.view!==state.view){state.view=entry.view;renderView().catch(error=>toast(error.message));}
  else updateNav();
});
function toast(message){document.querySelector('#toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>document.querySelector('#toast').textContent='',4500);}
async function api(path,options={}){
  const {body,...rest}=options;
  const response=await fetch('/api'+path,{...rest,headers:{'X-Portal-Request':'1',...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){if(response.status===401&&state.user){state.user=null;clearInterval(pollTimer);modal.close();authPage(false);}throw new Error(data.error??'요청을 처리하지 못했습니다.');}
  return data;
}
function authPage(setup){
  root.innerHTML=`<div class="auth-page"><section class="auth-story"><div class="brand"><img src="/favicon.svg" alt=""><div>PORTAL<small>PERSONAL ASSET WORKSPACE</small></div></div><div><h1>물품과 자료,<br>하나의 작업 공간.</h1><p>일반 비품부터 IT 장비까지.<br>등록된 자료와 다가오는 기한을 함께 관리하세요.</p><div class="auth-list"><div><span>01</span>비품·IT 자산 통합 관리</div><div><span>02</span>첨부자료와 변경 이력</div><div><span>03</span>알림과 사용자 권한</div></div></div><footer>DYKIM · PERSONAL PORTAL</footer></section><section class="auth-form-wrap"><div class="auth-form"><p class="eyebrow">${setup?'WELCOME TO PORTAL':'YOUR WORKSPACE'}</p><h2>${setup?'첫 관리자 만들기':'로그인'}</h2><p>${setup?'서버의 초기 설정 코드로 관리자 계정을 만들어 주세요.':'등록된 계정으로 포털에 접속하세요.'}</p><form id="auth-form" data-setup="${setup}"><div class="error" role="alert"></div>${setup?'<label>초기 설정 코드<input name="token" required autocomplete="off" spellcheck="false"></label><label>관리자 이름<input name="name" required maxlength="100" autocomplete="name"></label>':''}<label>이메일<input name="email" type="email" required maxlength="254" autocomplete="username"></label><label>비밀번호<input name="password" type="password" required ${setup?'minlength="12"':''} maxlength="128" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'12자 이상 입력':'비밀번호 입력'}"></label><button class="primary">${setup?'관리자 계정 생성':'로그인'}</button></form><p class="auth-note">${setup?'초기 설정 코드는 서버의 data/setup-token.txt 파일에서 확인할 수 있습니다. 최초 등록 후 코드는 폐기됩니다.':'계정이 없거나 비밀번호를 잊으셨다면 포털 관리자에게 문의하세요.'}</p></div></section></div>`;
  const emailField=root.querySelector('[name=email]');
  root.querySelector('.brand > div').innerHTML="<span class=\"brand-title\">DYKIM'S PORTAL</span><small>PERSONAL ASSET WORKSPACE</small>";
  const loginField='<label>로그인 아이디<input name="username" required minlength="2" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,31}" autocomplete="username" spellcheck="false"></label>';
  if(setup)emailField.closest('label').insertAdjacentHTML('beforebegin',loginField);
  else {emailField.closest('label').outerHTML=loginField;root.querySelector('.auth-note').textContent='기존 계정은 이전 이메일의 @ 앞부분을 아이디로 입력하세요. 아이디가 겹치면 관리자에게 확인해 주세요.';}
}
function shell(){
  const menus=[['dashboard','대시보드'],['installations','설치관리'],['projects','프로젝트 관리'],['library','자료 관리'],['items','자산 관리'],['todos','TO-DO List'],['work','업무관리'],['reports','리포트'],['tools','도구'],...(state.user.role==='admin'?[['usage','사용량 관리'],['operations','운영관리']]:[]),['settings','설정']];
  sidebarMenus=menus.filter(([view])=>view!=='operations'&&view!=='usage');
  const defaults=sidebarMenus.map(([view])=>view);
  let saved=[];try{saved=JSON.parse(localStorage.getItem(sidebarMenuKey()));}catch{}
  sidebarMenuOrder=orderedMenuIds(defaults,saved);
  root.innerHTML=`<div class="layout"><aside class="sidebar"><div class="brand"><img src="/favicon.svg" alt=""><div>PORTAL<small>PERSONAL WORKSPACE</small></div></div><nav class="nav" id="sidebar-nav" aria-label="주 메뉴"></nav><div class="sidebar-foot"><a href="https://github.com/dykim-tech/portal" target="_blank" rel="noopener">GitHub 저장소</a>${state.user.role==='admin'?'<button type="button" class="sidebar-link" data-view="operations">운영관리</button><button type="button" class="sidebar-link" data-view="usage">사용량 관리</button>':''}<div class="account"><strong>${esc(state.user.name)}</strong><small>${labels[state.user.role]}</small><div class="account-actions"><button data-action="password">비밀번호 변경</button><button data-action="logout">로그아웃</button></div></div></div></aside><div class="workspace"><header class="topbar"><div class="topbar-location"><button type="button" class="back-button" data-action="view-back" aria-label="이전 화면으로 돌아가기" title="이전 화면으로 돌아가기">← 뒤로가기</button><span>내 작업 공간 / <strong id="breadcrumb"></strong></span></div><div class="topbar-tools"><button class="small" data-view="notifications">알림 <span id="nav-count" class="badge" hidden></span></button><span>${esc(state.user.name)} · ${labels[state.user.role]}</span><button class="small mobile-account" data-action="account">계정</button></div></header><nav class="horizontal-nav" aria-label="가로 메뉴">${menus.map(([view,name])=>`<button data-view="${view}">${name}</button>`).join('')}</nav><main class="content" id="content"></main></div></div>`;
  root.querySelector('.brand > div').innerHTML="<span class=\"brand-title\">DYKIM'S PORTAL</span><small>PERSONAL WORKSPACE</small>";
  renderSidebarMenu();
}
// 사용자 관리·백업/복구는 설정 안의 관리자 메뉴이므로 해당 화면에서는 메뉴의 '설정'을 강조한다.
const settingsChildViews=['users','backups'];
function navView(){return settingsChildViews.includes(state.view)?'settings':state.view;}
function updateNav(){document.querySelectorAll('[data-view]').forEach(b=>{const menu=b.closest('nav')||b.classList.contains('sidebar-link');const current=menu?b.dataset.view===navView():b.dataset.view===state.view;b.classList.toggle('active',current);if(menu)b.setAttribute('aria-current',current?'page':'false');});const count=document.querySelector('#nav-count');if(count){count.textContent=state.unread;count.hidden=!state.unread;}const bread=document.querySelector('#breadcrumb');if(bread)bread.textContent={dashboard:'대시보드',installations:'설치관리',projects:'프로젝트 관리',library:'자료 관리',items:'자산 관리',todos:'TO-DO List',work:'업무관리',reports:'리포트',notifications:'알림',users:'설정 / 사용자 관리',backups:'설정 / 백업/복구',operations:'운영관리',usage:'사용량 관리',tools:'도구',settings:'설정'}[state.view];const back=document.querySelector('[data-action="view-back"]');if(back)back.disabled=historyIndex===0&&state.view==='dashboard';}
async function refreshCount(){const result=await api('/notifications');state.unread=result.unread;updateNav();return result;}
async function signedIn(user){state.user=user;state.view='dashboard';historyIndex=0;historyGuarded=false;shell();await renderView();await refreshCount();clearInterval(pollTimer);pollTimer=setInterval(()=>{if(state.user)refreshCount().catch(()=>{});},60000);}
async function renderView(){if(bulkMode&&bulkMode.view!==state.view)bulkMode=null;updateNav();if(state.view==='items')await renderItems();else if(state.view==='users')await showUsers();else if(state.view==='backups')await renderBackups();else if(state.view==='operations')await management.renderOperations();else if(state.view==='usage')await management.renderUsage();else if(state.view==='tools')renderTools();else if(state.view==='projects')await management.renderProjects();else if(state.view==='notifications')await renderNotifications();else if(state.view==='dashboard')await renderDashboard();else if(state.view==='installations')await renderInstallations();else if(state.view==='library')await renderLibrary();else if(state.view==='todos')await extras.renderTodos();else if(state.view==='work')await extras.renderWork();else if(state.view==='reports')await extras.renderReports();else renderSettings();}
async function renderItems(){
  await extras.loadCategories('items');
  const result=await api('/items?'+new URLSearchParams({...state.filters,...listingQuery('items',state.page)}));
  if(state.view!=='items')return;
  const f=state.filters,s=result.stats;
  document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">ASSET LIBRARY</p><h1>자산 관리</h1><p>비품과 IT 장비의 최신 자료를 한눈에 확인하세요.</p></div>${canEdit()?'<button class="primary" data-action="new-item">＋ 자산 등록</button>':''}</div><div class="stats">${[['전체 자산',s.total],['일반 비품',s.general],['IT 장비',s.it],['점검·수리 중',s.repair]].map(([label,value])=>`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}<span>건</span></div></div>`).join('')}</div><section class="panel"><div class="panel-head"><h2>등록 자료 <small>${result.total}건</small></h2><small>최근 수정순</small></div><form class="filters" id="filter-form"><label>통합 검색<input name="q" placeholder="자산명, 관리번호, 담당자, 시리얼" value="${esc(f.q)}"></label><label>자산 유형<select name="category"><option value="">모든 분류</option>${options(['general','it'],f.category)}</select></label><label>상태<select name="status"><option value="">모든 상태</option>${options(['active','stored','repair','retired'],f.status)}</select></label><button class="primary">조회</button><div class="date-row"><label>수정일 시작<input name="from" type="date" value="${esc(f.from)}"></label><label>수정일 종료<input name="to" type="date" value="${esc(f.to)}"></label><label class="checkbox"><input name="due" type="checkbox" value="set" ${f.due?'checked':''}>기한이 있는 물품만</label><button type="button" class="ghost small" data-action="reset-filter">필터 초기화</button></div></form>${result.items.length?`<div class="table-wrap"><table><thead><tr><th>자산명 / 관리번호</th><th>분류</th><th>상태</th><th>담당자 / 위치</th><th>관리 기한</th><th>최근 수정</th><th>자료</th></tr></thead><tbody>${result.items.map(i=>`<tr><td><div class="item-name"><span class="item-icon" aria-hidden="true">${i.category==='it'?'▣':'▦'}</span><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)}</span></button></div></td><td>${labels[i.category]}<span class="secondary-line">${esc(extras.categoryPath('items',i.category_id))}</span></td><td><span class="badge ${i.status}">${labels[i.status]}</span></td><td>${esc(i.owner)||'—'}<span class="secondary-line">${esc(i.location)||'위치 미지정'}</span></td><td>${esc(i.due_date)||'—'}</td><td>${fmt(i.updated_at)}<span class="secondary-line">${esc(i.updated_by_name)}</span></td><td>${i.file_count}개</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><h3>${s.total?'검색 결과가 없습니다':'아직 등록된 물품이 없습니다'}</h3><p>${s.total?'검색어나 필터 조건을 바꿔 보세요.':'비품이나 IT 장비를 등록하고 자료와 관리 기한을 추가해 보세요.'}</p>${canEdit()&&!s.total?'<button data-action="new-item">첫 자산 등록</button>':''}</div>`}<div class="footer-row"><span>등록 자료 ${result.total}건 · 한국 표준시 기준</span><div class="pager"><button class="small" data-action="prev" ${state.page<=1?'disabled':''}>이전</button><span>${state.page} / ${Math.max(1,result.pages)}</span><button class="small" data-action="next" ${state.page>=result.pages?'disabled':''}>다음</button></div></div></section>`;
  extras.attachCategoryPanel('items');
  decorateListing('items',result.total,result.page);
}
function openDialog(title,body){modal.classList.remove('preview-dialog');modal.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="ghost small" data-action="close" aria-label="창 닫기">닫기</button></div><div class="dialog-body"><div class="error" id="dialog-error" role="alert"></div>${body}</div>`;if(!modal.open)modal.showModal();}
function input(name,label,value='',extra=''){return `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;}
function listingQuery(kind,page){const {size,sort,direction}=tableState[kind];return {page,page_size:size,sort,direction};}
function decorateListing(kind,total,page){
  const config=tableState[kind],panel=document.querySelector('#content .panel'),table=panel?.querySelector('table');
  if(kind==='users'&&table){const body=table.tBodies[0],byId=new Map(state.users.map(user=>[user.id,user]));table.tHead.rows[0].cells[1].insertAdjacentHTML('beforebegin','<th>아이디</th>');[...body.rows].forEach(row=>{const user=byId.get(Number(row.querySelector('[data-action=user]').dataset.id));row.cells[1].insertAdjacentHTML('beforebegin',`<td>${esc(user?.username)}</td>`);});}
  table?.querySelectorAll('thead th').forEach((header,index)=>{const key=tableColumns[kind][index];if(!key)return;const active=config.sort===key,label=header.textContent.trim();header.setAttribute('aria-sort',active?(config.direction==='asc'?'ascending':'descending'):'none');header.innerHTML=`<button type="button" class="sort-heading" data-table-sort="${kind}" data-sort="${key}">${esc(label)}<span aria-hidden="true">${active?(config.direction==='asc'?'▲':'▼'):'↕'}</span></button>`;});
  if(kind==='users'&&table){const body=table.tBodies[0],byId=new Map(state.users.map(user=>[user.id,user])),collator=new Intl.Collator('ko',{numeric:true,sensitivity:'base'});[...body.rows].sort((a,b)=>{const left=byId.get(Number(a.querySelector('[data-action=user]').dataset.id))?.[config.sort],right=byId.get(Number(b.querySelector('[data-action=user]').dataset.id))?.[config.sort];const result=typeof left==='number'||typeof left==='boolean'?Number(left)-Number(right):collator.compare(String(left??''),String(right??''));return config.direction==='asc'?result:-result;}).forEach((row,index)=>{body.append(row);row.hidden=index<(config.page-1)*config.size||index>=config.page*config.size;});total=state.users.length;page=config.page;panel.insertAdjacentHTML('beforeend',`<div class="footer-row"><span>사용자 ${total}명</span><div class="pager"><button class="small" data-action="users-prev">이전</button><span></span><button class="small" data-action="users-next">다음</button></div></div>`);}
  const footer=panel?.querySelector('.footer-row'),pager=footer?.querySelector('.pager');if(!footer||!pager)return;
  if(kind==='installations')footer.firstElementChild.textContent=`설치 정보 ${total}건`;
  footer.querySelector('.page-size-control')?.remove();
  footer.insertAdjacentHTML('afterbegin',`<label class="page-size-control">페이지당 <select data-page-size="${kind}" aria-label="페이지당 표시 건수">${allowedPageSizes.map(size=>`<option value="${size}" ${size===config.size?'selected':''}>${size}건</option>`).join('')}</select></label>`);
  const pages=Math.max(1,Math.ceil(total/config.size));pager.querySelector('span').textContent=`${page} / ${pages}`;const buttons=pager.querySelectorAll('button');buttons[0].disabled=page<=1;buttons[1].disabled=page>=pages;
  decorateBulkSelection();
}
// 표 열 너비 마우스 조정: 머리글 오른쪽 경계를 끌어 너비를 바꾸고, 경계를 두 번 누르면 기본 너비로 되돌린다. 너비는 브라우저에 저장한다.
const COLUMN_MIN_WIDTH=60;
function columnKey(header){return header.querySelector('[data-sort]')?.dataset.sort??header.textContent.trim();}
function readColumnWidths(kind){try{return JSON.parse(localStorage.getItem('portal-column-widths:'+kind)??'{}')||{};}catch{return {};}}
function saveColumnWidths(kind,widths){try{if(Object.keys(widths).length)localStorage.setItem('portal-column-widths:'+kind,JSON.stringify(widths));else localStorage.removeItem('portal-column-widths:'+kind);}catch{}}
function applyColumnWidths(table,widths){
  const headers=[...table.tHead.rows[0].cells],keyed=headers.filter(header=>columnKey(header));
  if(!keyed.some(header=>widths[columnKey(header)])){table.classList.remove('columns-sized');table.style.width='';headers.forEach(header=>header.style.width='');return;}
  const natural=headers.map(header=>header.getBoundingClientRect().width);
  if(table.dataset.lastNatural)natural[natural.length-1]=Number(table.dataset.lastNatural);
  table.classList.add('columns-sized');
  const sizes=headers.map((header,index)=>Math.max(header.classList.contains('select-cell')?natural[index]:COLUMN_MIN_WIDTH,Math.round(widths[columnKey(header)]??natural[index])));
  const total=sizes.reduce((sum,size)=>sum+size,0),room=(table.parentElement?.clientWidth??total)-total;
  if(room>0)sizes[sizes.length-1]+=room;
  headers.forEach((header,index)=>{header.style.width=sizes[index]+'px';});
  table.style.width=Math.max(total,total+room)+'px';
}
function enableColumnResize(table,kind){
  const headRow=table?.tHead?.rows[0];if(!headRow)return;
  const headers=[...headRow.cells];if(headers.length<2)return;
  const missing=headers.slice(0,-1).filter(header=>columnKey(header)&&!header.classList.contains('select-cell')&&!header.querySelector(':scope > .column-resizer'));
  if(!missing.length&&table.dataset.resizeKind===kind)return;
  // 같은 표를 다시 꾸밀 때(정렬 머리글·열 추가 등)는 빠진 경계만 다시 붙이고 저장된 너비를 다시 적용한다.
  if(table.dataset.resizeKind!==kind||!table._columnWidths){table.dataset.resizeKind=kind;table._columnWidths=readColumnWidths(kind);}
  const widths=table._columnWidths;
  if(!table.classList.contains('columns-sized'))table.dataset.lastNatural=String(Math.round(headers.at(-1).getBoundingClientRect().width));
  delete widths[columnKey(headers.at(-1))];
  missing.forEach(header=>{
    header.classList.add('resizable-column');
    const handle=document.createElement('span');handle.className='column-resizer';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',`${header.textContent.replace(/[▲▼↕]/g,'').trim()} 열 너비 조정`);handle.title='끌어서 열 너비 조정 · 두 번 누르면 기본 너비';
    const key=()=>columnKey(header);
    const resize=width=>{table._columnWidths[key()]=Math.max(COLUMN_MIN_WIDTH,Math.round(width));applyColumnWidths(table,table._columnWidths);};
    handle.addEventListener('pointerdown',event=>{
      event.preventDefault();event.stopPropagation();
      const startX=event.clientX,startWidth=header.getBoundingClientRect().width,cells=[...table.tHead.rows[0].cells];
      cells.slice(0,-1).forEach(cell=>{const name=columnKey(cell);if(name&&table._columnWidths[name]==null&&!cell.classList.contains('select-cell'))table._columnWidths[name]=Math.round(cell.getBoundingClientRect().width);});
      handle.setPointerCapture(event.pointerId);table.classList.add('column-resizing');
      const move=moveEvent=>resize(startWidth+moveEvent.clientX-startX);
      const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);table.classList.remove('column-resizing');saveColumnWidths(table.dataset.resizeKind,table._columnWidths);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    });
    handle.addEventListener('click',event=>event.stopPropagation());
    handle.addEventListener('dblclick',event=>{event.stopPropagation();for(const name of Object.keys(table._columnWidths))delete table._columnWidths[name];saveColumnWidths(table.dataset.resizeKind,table._columnWidths);applyColumnWidths(table,table._columnWidths);});
    handle.addEventListener('keydown',event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();resize(header.getBoundingClientRect().width+(event.key==='ArrowRight'?10:-10));saveColumnWidths(table.dataset.resizeKind,table._columnWidths);});
    header.append(handle);
  });
  applyColumnWidths(table,widths);
}
// 모든 화면과 대화창의 표에 열 너비 조정을 자동으로 붙인다. 표 종류별(화면·순서) 너비를 따로 저장한다.
function resizeKindFor(table,index,inDialog){
  if(table.classList.contains('file-table'))return 'library';
  if(inDialog)return `dialog:${document.querySelector('#dialog-title')?.textContent.trim()??''}:${index}`;
  return `${state.view}:${index}`;
}
let columnResizeFrame=0;
function scanResizableTables(){
  columnResizeFrame=0;
  document.querySelectorAll('#content table').forEach((table,index)=>enableColumnResize(table,resizeKindFor(table,index,false)));
  if(modal.open)modal.querySelectorAll('table').forEach((table,index)=>enableColumnResize(table,resizeKindFor(table,index,true)));
  for(const layout of splitLayouts)document.querySelectorAll('#content '+layout.container).forEach(container=>enableSplitResize(container,layout));
}
new MutationObserver(()=>{if(!columnResizeFrame)columnResizeFrame=requestAnimationFrame(scanResizableTables);}).observe(document.body,{childList:true,subtree:true});
// 좌우로 나뉜 화면(자료 관리 폴더 트리, 자산 분류·업무관리 고객 목록 등)의 경계를 끌어 왼쪽 영역 너비를 조정한다.
// 두 번 누르면 기본 너비로 돌아가고, 너비는 화면별로 브라우저에 저장한다. 좁은 화면(세로 배치)에서는 경계를 숨긴다.
const SPLIT_MIN_WIDTH=140,SPLIT_MAIN_MIN=360;
const splitLayouts=[{container:'.explorer',side:'.folder-tree',key:()=>'portal-library-tree-width'},{container:'.classified-panel',side:'.classified-sidebar',key:()=>'portal-split-width:'+state.view}];
function readSplitWidth(key){try{const value=Number(localStorage.getItem(key));return Number.isFinite(value)&&value>0?value:null;}catch{return null;}}
function saveSplitWidth(key,value){try{if(value==null)localStorage.removeItem(key);else localStorage.setItem(key,String(value));}catch{}}
function enableSplitResize(container,layout){
  if(!container||container.querySelector(':scope > .explorer-splitter'))return;
  const side=container.querySelector(':scope > '+layout.side);if(!side)return;
  const key=layout.key();
  const clamp=value=>Math.round(Math.min(Math.max(SPLIT_MIN_WIDTH,value),Math.max(SPLIT_MIN_WIDTH,container.clientWidth-SPLIT_MAIN_MIN)));
  const refitTables=()=>container.querySelectorAll('table.columns-sized').forEach(table=>{if(table._columnWidths)applyColumnWidths(table,table._columnWidths);});
  const apply=value=>{if(value==null)container.style.removeProperty('--side-width');else container.style.setProperty('--side-width',clamp(value)+'px');};
  const handle=document.createElement('div');handle.className='explorer-splitter';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','왼쪽 영역 너비 조정');handle.title='끌어서 왼쪽 영역 너비 조정 · 두 번 누르면 기본 너비';
  const place=()=>{const vertical=getComputedStyle(container).display!=='grid';handle.hidden=vertical;if(!vertical)handle.style.left=(side.offsetLeft+side.offsetWidth-5)+'px';};
  const current=()=>side.getBoundingClientRect().width;
  handle.addEventListener('pointerdown',event=>{
    event.preventDefault();
    const startX=event.clientX,startWidth=current();
    handle.setPointerCapture(event.pointerId);container.classList.add('tree-resizing');
    const move=moveEvent=>{apply(startWidth+moveEvent.clientX-startX);place();};
    const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);container.classList.remove('tree-resizing');saveSplitWidth(key,clamp(current()));refitTables();};
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  });
  handle.addEventListener('dblclick',()=>{saveSplitWidth(key,null);apply(null);place();refitTables();});
  handle.addEventListener('keydown',event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const next=clamp(current()+(event.key==='ArrowRight'?10:-10));apply(next);saveSplitWidth(key,next);place();refitTables();});
  apply(readSplitWidth(key));
  container.append(handle);place();
  if(window.ResizeObserver)new ResizeObserver(place).observe(side);else window.addEventListener('resize',place);
}
function enableTreeResize(explorer){enableSplitResize(explorer,splitLayouts[0]);}
function resetListingPage(kind){if(kind==='items')state.page=1;else if(kind==='installations')features.installationPage=1;else if(kind==='library')features.libraryPage=1;else if(kind==='work')extras.resetWorkPage();else if(kind==='users')tableState.users.page=1;}
function historyText(h){if(h.action!=='수정')return h.action==='등록'?'자산 정보 최초 등록':h.detail;try{return Object.entries(JSON.parse(h.detail)).map(([key,val])=>`${fields[key]??key}: ${labels[val.before]??val.before??'없음'} → ${labels[val.after]??val.after??'없음'}`).join('\n')||'변경 사항 없음';}catch{return h.detail;}}
async function itemDialog(id){
  await extras.loadCategories('items');
  const result=id?await api('/items/'+id):{item:{category:'general',status:'active',quantity:1,reminder_days:7},files:[],history:[]};
  state.item=result.item;const i=result.item,disabled=canEdit()?'':'disabled';
  openDialog(id?'자산 상세 정보':'새 자산 등록',`<form id="item-form"><div class="form-grid">${input('name','자산명 *',i.name,`required maxlength="150" ${disabled}`)}${input('asset_code','관리번호 *',i.asset_code,`required maxlength="80" placeholder="예: IT-001" ${disabled}`)}<label>분류 *<select name="category" ${disabled}>${options(['general','it'],i.category)}</select></label>${extras.leafSelect('items',i.category_id,!id)}<label>상태 *<select name="status" ${disabled}>${options(['active','stored','repair','retired'],i.status)}</select></label>${input('quantity','수량 *',i.quantity,`type="number" required min="0" max="1000000" ${disabled}`)}${input('owner','담당자',i.owner,`maxlength="200" ${disabled}`)}${input('location','보관 위치',i.location,`maxlength="200" ${disabled}`)}${input('serial','시리얼 번호',i.serial,`maxlength="200" ${disabled}`)}${input('due_date','관리 기한',i.due_date,`type="date" ${disabled}`)}${input('reminder_days','사전 알림 (일 전)',i.reminder_days,`type="number" min="0" max="365" required ${disabled}`)}<label class="full">설명·관리 메모<textarea name="description" maxlength="10000" ${disabled}>${esc(i.description)}</textarea></label></div><p class="help-line">관리 기한은 점검·보증·반납 등 필요한 날짜로 설정하세요. 사전 알림일, 기한 당일, 기한 경과 시 포털에 알림이 생성됩니다. 사용 종료 물품은 제외됩니다.</p>${canEdit()?`<div class="form-actions">${id?`<button type="button" class="danger" data-action="delete-item" data-id="${id}">자산 삭제</button>`:''}<button type="button" data-action="close">취소</button><button class="primary">${id?'변경 저장':'자산 등록'}</button></div>`:''}</form>${id?`<section class="subsection"><h3>첨부자료 <small>${result.files.length}개</small></h3>${result.files.length?result.files.map(f=>`<div class="file-row"><div><a href="/api/files/${f.id}">${esc(f.name)}</a><span class="secondary-line">${(f.size/1024).toFixed(1)} KB · ${fmt(f.created_at)}</span></div>${canEdit()?`<button class="small danger" data-action="delete-file" data-id="${f.id}">삭제</button>`:''}</div>`).join(''):'<p class="muted">등록된 첨부자료가 없습니다.</p>'}${canEdit()?'<form class="upload" id="upload-form"><input aria-label="첨부할 자료" type="file" name="file" required><button type="submit">자료 첨부</button></form><p class="help-line">자산 정보 변경은 먼저 저장한 뒤 첨부하세요.</p>':''}</section><section class="subsection"><h3>최근 변경 이력</h3>${result.history.map(h=>`<div class="history-row"><strong>${esc(h.action)}</strong>${esc(h.actor)}<small>${fmt(h.created_at)}</small><div class="history-detail">${esc(historyText(h))}</div></div>`).join('')}</section>`:'<p class="save-note">자산 등록을 완료하면 첨부자료를 추가할 수 있습니다.</p>'}`);
}
async function renderUsers(){const {users}=await api('/users');state.users=users;if(state.view!=='users')return;document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">ACCESS MANAGEMENT</p><h1>사용자 관리</h1><p>계정별 접근 권한과 사용 상태를 관리하세요.</p></div><button class="primary" data-action="new-user">＋ 사용자 추가</button></div><div class="notice">관리자: 사용자·자료 관리 · 편집자: 물품·자료 등록 및 수정 · 조회자: 자료 열람 및 알림 확인</div><section class="panel"><div class="panel-head"><h2>등록 사용자 <small>${users.length}명</small></h2></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>이메일</th><th>권한</th><th>계정 상태</th><th>등록일</th><th>관리</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.name)} ${u.id===state.user.id?'<span class="badge">나</span>':''}</td><td>${esc(u.email)}</td><td>${labels[u.role]}</td><td><span class="badge ${u.active?'active':'retired'}">${u.active?'활성':'비활성'}</span></td><td>${fmt(u.created_at)}</td><td><button class="small" data-action="user" data-id="${u.id}">수정</button></td></tr>`).join('')}</tbody></table></div></section>`;}
async function showUsers(){await renderUsers();if(state.view==='users')decorateListing('users');}
function userDialog(id){const u=state.users.find(u=>u.id===Number(id))??{role:'viewer',active:true};state.editUser=u;openDialog(id?'사용자 수정':'사용자 추가',`<form id="user-form"><div class="form-grid">${input('name','이름 *',u.name,'required maxlength="100" autocomplete="off"')}${input('username','로그인 아이디 *',u.username,'required minlength="2" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,31}" autocomplete="off"')}${input('email','이메일 *',u.email,'type="email" required maxlength="254" autocomplete="off"')}<label>권한<select name="role">${options(['admin','editor','viewer'],u.role)}</select></label>${input('password',id?'새 비밀번호 (변경할 때만)':'초기 비밀번호 *','','type="password" minlength="12" maxlength="128" autocomplete="new-password" '+(id?'':'required'))}${id?`<label class="checkbox-line"><input name="active" type="checkbox" ${u.active?'checked':''}>계정 활성화</label>`:''}</div><p class="help-line">로그인은 아이디로 합니다. 이메일은 계정 정보로 유지됩니다. 비밀번호는 12자 이상입니다. 비밀번호·권한 변경 또는 계정 비활성화 시 기존 로그인이 해제됩니다.</p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);}
async function renderNotifications(){const result=await refreshCount();if(state.view!=='notifications')return;document.querySelector('#content').innerHTML=`<div class="page-head"><div><p class="eyebrow">NOTIFICATION INBOX</p><h1>알림</h1><p>관리 기한과 포털의 업무 활동을 확인하세요.</p></div><button data-action="read-all" ${result.unread?'':'disabled'}>모두 읽음</button></div><div class="notice">읽지 않은 알림 ${result.unread}건 · 서버가 실행되는 동안 1분마다 기한과 업무 활동을 확인합니다. 알림은 포털 내부에서 제공되며, 종료된 동안 지난 기한은 다음 실행 시 확인합니다.</div><section class="panel"><div class="panel-head"><h2>최근 알림 <small>최대 200건 표시</small></h2><button class="small" data-action="refresh-notifications">새로고침</button></div><div class="notifications">${result.notifications.length?result.notifications.map(n=>notificationHtml(n,{esc,fmt,labels})).join(''):'<div class="empty"><h3>도착한 알림이 없습니다</h3><p>관리 기한과 업무 활동이 등록되면 이곳에 표시됩니다.</p></div>'}</div></section>`;}
function passwordDialog(){openDialog('비밀번호 변경',`<form id="password-form"><div class="form-grid"><label class="full">현재 비밀번호<input name="current" type="password" required maxlength="128" autocomplete="current-password"></label><label class="full">새 비밀번호<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></div><p class="help-line">변경 후 모든 기기에서 로그아웃됩니다.</p><div class="form-actions"><button class="primary">비밀번호 변경</button></div></form>`);}
const recordMenu=document.createElement('div');
recordMenu.className='record-context-menu';
recordMenu.setAttribute('role','menu');
recordMenu.setAttribute('aria-label','선택한 항목 작업');
recordMenu.hidden=true;
document.body.append(recordMenu);
function hideRecordMenu(){recordMenu.hidden=true;recordMenu.replaceChildren();}
function recordAt(target){
  if(!(target instanceof Element)||!target.closest('#content'))return null;
  let button,kind;
  if(state.view==='work'){
    button=target.closest('.classified-sidebar [data-action="work-customer"][data-id]');kind='customer';
    if(!button){button=target.closest('tbody tr')?.querySelector('[data-action="work-log"]');kind='work';}
  }else if(state.view==='items'){
    button=target.closest('.classified-sidebar [data-action="category-select"][data-id]');kind='category';
    if(!button){button=target.closest('tbody tr')?.querySelector('[data-action="item"]');kind='item';}
  }else if(state.view==='installations'){
    button=target.closest('tbody tr')?.querySelector('[data-action="installation"]');kind='installation';
  }else if(state.view==='library'){
    button=target.closest('.folder-tree-row')?.querySelector('[data-action="folder"]')??target.closest('.file-table tbody tr')?.querySelector('[data-action="folder"], [data-action="preview"]');
    kind=button?.dataset.action==='folder'?'folder':'manual';
  }else if(state.view==='users'){
    button=target.closest('tbody tr')?.querySelector('[data-action="user"]');kind='user';
  }else if(state.view==='dashboard'||state.view==='notifications'){
    button=target.closest('.dashboard-row, .notification')?.querySelector('[data-action="item"], [data-action="installation"]');
    kind=button?.dataset.action;
  }
  const id=button?.dataset.id;
  return id&&/^\d+$/.test(id)?{kind,id}:null;
}
const recordActions={customer:['customer-edit','customer-delete'],work:['work-log','work-delete'],category:['category-rename','category-delete'],item:['item','delete-item'],installation:['installation','installation-delete'],folder:['new-folder','rename-folder','move-folder','delete-folder'],manual:['edit-manual','move-manual','delete-manual'],user:['user','delete-user']};
const bulkViews={customer:'work',work:'work',category:'items',item:'items',installation:'installations',folder:'library',manual:'library',user:'users'};
const bulkLabels={customer:'고객',work:'업무일지',category:'자산 분류',item:'자산',installation:'설치정보',folder:'자료 폴더',manual:'자료 파일',user:'사용자'};
const bulkSelectors={customer:'.classified-sidebar [data-action="work-customer"][data-id]',work:'tbody [data-action="work-log"][data-id]',category:'.classified-sidebar [data-action="category-select"][data-id]',item:'tbody [data-action="item"][data-id]',installation:'tbody [data-action="installation"][data-id]',folder:'.folder-tree-row [data-action="folder"][data-id], .file-table tbody [data-action="folder"][data-id]',manual:'.file-table tbody [data-action="preview"][data-id]',user:'tbody [data-action="user"][data-id]'};
let bulkMode=null;
function bulkCheck(id){
  const label=document.createElement('label');label.className='bulk-check';
  const box=document.createElement('input');box.type='checkbox';box.dataset.bulkId=id;box.checked=bulkMode.selected.has(id);box.setAttribute('aria-label',`${bulkLabels[bulkMode.kind]} 삭제 대상으로 선택`);
  label.append(box);return label;
}
function updateBulkUI(){
  if(!bulkMode)return;
  document.querySelectorAll('#content input[data-bulk-id]').forEach(box=>{box.checked=bulkMode.selected.has(box.dataset.bulkId);box.disabled=Boolean(bulkMode.deleting);});
  const bar=document.querySelector('#content .bulk-toolbar');if(!bar)return;
  const count=bulkMode.selected.size;bar.querySelector('.bulk-count').textContent=bulkMode.deleting?'삭제 처리 중…':`${count}개 선택됨`;
  const deleteButton=bar.querySelector('[data-action="bulk-delete"]');deleteButton.textContent=bulkMode.deleting?'삭제 중…':`선택한 ${count}개 삭제`;
  bar.querySelectorAll('button').forEach(button=>{button.disabled=Boolean(bulkMode.deleting)||(button===deleteButton&&count===0);});
}
function decorateBulkSelection(){
  if(!bulkMode||bulkMode.view!==state.view)return;
  const content=document.querySelector('#content');
  const bar=document.createElement('div');bar.className='bulk-toolbar';bar.setAttribute('role','region');bar.setAttribute('aria-label','여러 항목 삭제');
  bar.innerHTML=`<strong>삭제할 ${bulkLabels[bulkMode.kind]} 선택</strong><span class="bulk-count" role="status"></span><button type="button" class="small" data-action="bulk-select-visible">현재 목록 모두 선택</button><button type="button" class="small" data-action="bulk-clear">선택 해제</button><button type="button" class="small" data-action="bulk-cancel">취소</button><button type="button" class="small danger" data-action="bulk-delete"></button>${bulkMode.error?`<p class="bulk-error" role="alert">${esc(bulkMode.error)}</p>`:''}`;
  content.querySelector('.page-head')?.insertAdjacentElement('afterend',bar);
  const seenRows=new Set();
  for(const button of content.querySelectorAll(bulkSelectors[bulkMode.kind])){
    const id=button.dataset.id;
    if(bulkMode.kind==='user'&&Number(id)===state.user.id)continue;
    const row=button.closest('tbody tr');
    const name=row?(bulkMode.kind==='installation'?`${row.cells[1].textContent.trim()} / ${row.cells[2].textContent.trim()}`:bulkMode.kind==='work'?`${row.cells[1].textContent.trim()} / ${row.cells[2].textContent.trim()}`:bulkMode.kind==='user'?row.cells[0].textContent.trim():button.textContent.trim()):button.textContent.trim();
    bulkMode.names.set(id,name.replace(/\s+/g,' ').slice(0,100));
    if(row){
      if(seenRows.has(row))continue;seenRows.add(row);
      const cell=row.cells[0];cell.classList.add('bulk-cell');cell.prepend(bulkCheck(id));row.closest('table').classList.add('bulk-selecting');
    }else if(bulkMode.kind==='folder'){
      button.before(bulkCheck(id));
    }else{
      const wrapper=document.createElement('div');wrapper.className='bulk-sidebar-row';button.replaceWith(wrapper);wrapper.append(bulkCheck(id),button);
    }
  }
  updateBulkUI();
}
async function startBulk(kind,id){
  if(!canEdit()||!bulkViews[kind]||!/^\d+$/.test(String(id)))return;
  bulkMode={kind,view:bulkViews[kind],selected:new Set([String(id)]),names:new Map(),error:''};
  state.view=bulkMode.view;await renderView();
  document.querySelector('#content .bulk-toolbar')?.scrollIntoView({block:'nearest'});
}
function bulkPath(kind,id){
  const routes={customer:`/customers/${id}`,work:`/work-logs/${id}`,category:`/categories/${id}?scope=items`,item:`/items/${id}`,installation:`/installations/${id}`,folder:`/folders/${id}`,manual:`/manuals/${id}`,user:`/users/${id}`};
  return routes[kind];
}
function bulkDepth(kind,id){
  if(kind==='category')return extras.categoryDepth('items',Number(id));
  if(kind!=='folder')return 0;
  const byId=new Map((features.libraryTree??[]).map(row=>[row.id,row]));let depth=0,row=byId.get(Number(id));
  while(row&&depth<10){depth++;row=byId.get(row.parent_id);}return depth;
}
async function deleteBulkSelection(){
  if(!bulkMode||!canEdit()||!bulkMode.selected.size||bulkMode.deleting)return;
  const mode=bulkMode,count=mode.selected.size;
  const note=mode.kind==='customer'?' 연결된 설치정보·업무일지는 보존됩니다.':'';
  const preview=[...mode.selected].slice(0,8).map(id=>`• ${mode.names.get(id)??'#'+id}`).join('\n');
  if(!confirm(`선택한 ${bulkLabels[mode.kind]} ${count}개를 삭제할까요?\n${preview}${count>8?`\n외 ${count-8}개`:''}\n${note} 이 작업은 되돌릴 수 없습니다.`))return;
  mode.deleting=true;updateBulkUI();
  const ids=[...mode.selected].sort((a,b)=>bulkDepth(mode.kind,b)-bulkDepth(mode.kind,a));
  const failed=[];let deleted=0;
  for(const id of ids){
    try{await api(bulkPath(mode.kind,id),{method:'DELETE'});deleted++;}
    catch(error){failed.push({id,message:error.message});if(!state.user)break;}
  }
  mode.deleting=false;
  if(!state.user){bulkMode=null;toast('로그인이 만료되었습니다. 다시 로그인한 뒤 삭제 결과를 확인해 주세요.');return;}
  mode.selected=new Set(failed.map(row=>row.id));mode.error=failed.length?`${failed.length}개 항목을 삭제하지 못했습니다. ${failed[0].message}`:'';
  if(deleted){
    if(mode.kind==='customer')extras.clearWorkCustomer();
    if(mode.kind==='category')delete state.filters.category_id;
    if(mode.kind==='folder'){features.folder=null;features.libraryQuery='';}
    resetListingPage(mode.view);
  }
  if(!failed.length)bulkMode=null;
  await renderView();
  if(deleted&&(mode.kind==='item'||mode.kind==='installation'))await refreshCount();
  toast(failed.length?`${deleted}개 삭제, ${failed.length}개 실패. 화면에서 실패 이유를 확인해 주세요.`:`${deleted}개 항목을 삭제했습니다.`);
}
// 자료 관리 우클릭 메뉴: 상단 버튼(폴더 생성·폴더 업로드·자료 등록·폴더 이름 변경·폴더 이동·Drive)을 대상에 맞게 모두 보여 준다.
function libraryContextMenu(target){
  const record=recordAt(target),edit=canEdit(),items=[];
  const item=(action,label,attrs='',cls='')=>`<button type="button" role="menuitem" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
  const sep='<hr class="menu-separator">';
  const driveItem=item('drive-settings',driveState.name?`Drive 폴더 변경 (${esc(driveState.name)})`:'Drive 폴더 지정');
  if(record?.kind==='manual'){
    const id=record.id;
    items.push(item('preview','미리보기',`data-id="${id}"`),item('download-manual','다운로드',`data-id="${id}"`),item('drive-file','Google Drive로 복사',`data-id="${id}"`));
    if(edit)items.push(sep,item('edit-manual','수정',`data-id="${id}"`),item('move-manual','이동',`data-id="${id}"`),sep,item('bulk-start','삭제',`data-kind="manual" data-id="${id}"`,'danger'));
    items.push(sep,driveItem);
  }else if(record?.kind==='folder'){
    const id=record.id;
    items.push(item('folder','열기',`data-id="${id}"`));
    if(edit)items.push(item('new-folder','하위 폴더 생성',`data-parent-id="${id}"`),item('upload-folder','이 폴더에 폴더 업로드',`data-target-id="${id}"`),item('upload-manual','이 폴더에 자료 등록',`data-target-id="${id}"`));
    items.push(item('drive-folder','Google Drive로 복사',`data-id="${id}"`));
    if(edit)items.push(sep,item('rename-folder','폴더 이름 변경',`data-id="${id}"`),item('move-folder','폴더 이동',`data-id="${id}"`),sep,item('bulk-start','삭제',`data-kind="folder" data-id="${id}"`,'danger'));
    items.push(sep,driveItem);
  }else{
    if(!(target instanceof Element)||!target.closest('#content .explorer')||target.closest('input,textarea,select,a,form'))return '';
    const current=target.closest('[data-action="folder"]:not([data-id])')?null:features.folder??null;
    if(edit)items.push(item('new-folder','폴더 생성',`data-parent-id="${current??''}"`),item('upload-folder','폴더 업로드',`data-target-id="${current??''}"`),item('upload-manual','자료 등록',`data-target-id="${current??''}"`));
    if(current!=null){
      items.push(item('drive-folder','현재 폴더를 Google Drive로 복사',`data-id="${current}"`));
      if(edit)items.push(sep,item('rename-folder','폴더 이름 변경',`data-id="${current}"`),item('move-folder','폴더 이동',`data-id="${current}"`));
    }
    items.push(sep,driveItem);
  }
  return items.join('').replace(new RegExp('^('+sep+')+'),'');
}
document.addEventListener('contextmenu',event=>{
  if(!state.user||modal.open)return;
  if(state.view==='library'){
    const html=libraryContextMenu(event.target);if(!html)return;
    recordMenu.innerHTML=html;
  }else{
  if(!canEdit())return;
  const record=recordAt(event.target);
  if(record){
    const actions=recordActions[record.kind];if(!actions)return;
    const showDelete=record.kind!=='user'||Number(record.id)!==state.user.id;
    recordMenu.innerHTML=actions.slice(0,showDelete?actions.length:1).map((action,index)=>{const deleting=index===actions.length-1;return `<button type="button" role="menuitem" class="${deleting?'danger':''}" data-action="${deleting?'bulk-start':action}" data-kind="${record.kind}" data-id="${record.id}" ${record.kind==='category'?'data-scope="items"':''} ${action==='new-folder'?`data-parent-id="${record.id}"`:''}>${deleting?'삭제':action==='new-folder'?'폴더 생성':action==='move-manual'||action==='move-folder'?'이동':'수정'}</button>`;}).join('');
  }else{
    const target=event.target;
    if(state.view!=='library'||!(target instanceof Element)||!target.closest('#content .explorer')||target.closest('input,textarea,select,a,form'))return;
    const root=target.closest('[data-action="folder"]:not([data-id])');
    const parent=root?'':features.folder??'';
    recordMenu.innerHTML=`<button type="button" role="menuitem" data-action="new-folder" data-parent-id="${parent}">폴더 생성</button>`;
  }
  }
  event.preventDefault();
  recordMenu.hidden=false;
  const x=event.clientX||event.target.getBoundingClientRect().left,y=event.clientY||event.target.getBoundingClientRect().bottom;
  recordMenu.style.left=Math.max(8,Math.min(x,window.innerWidth-recordMenu.offsetWidth-8))+'px';
  recordMenu.style.top=Math.max(8,Math.min(y,window.innerHeight-recordMenu.offsetHeight-8))+'px';
  recordMenu.querySelector('button')?.focus({preventScroll:true});
});
document.addEventListener('contextmenu',event=>{extras.todoContextMenu(event).catch(error=>toast(error.message));});
document.addEventListener('input',event=>{extras.todoInput(event.target);});
document.addEventListener('focusout',event=>{extras.todoBlur(event.target).catch(error=>toast(error.message));});
let activeTodoSizeCard=null;
document.addEventListener('pointerdown',event=>{activeTodoSizeCard=event.target.closest?.('.todo-note')??null;});
document.addEventListener('pointerup',()=>{if(activeTodoSizeCard){extras.rememberTodoSize(activeTodoSizeCard);activeTodoSizeCard=null;}});
function fileDropTarget(event){
  if(!event.dataTransfer?.types?.includes('Files')||modal.open)return null;
  if(state.view==='todos')return event.target.closest?.('.todo-note')??null;
  if(state.view==='work'&&canEdit())return event.target.closest?.('.customer-detail')??null;
  if(state.view==='library'&&canEdit())return libraryDropInfo(event.target)?.el??null;
  return null;
}
// 자료 관리 드래그 등록: 왼쪽 트리 폴더·목록의 폴더 행에 놓으면 그 폴더, 그 외 자료 영역은 현재 폴더에 등록한다.
function libraryDropInfo(target){
  if(!(target instanceof Element)||!target.closest('#content .explorer'))return null;
  const treeRow=target.closest('.folder-tree-row');
  if(treeRow){const id=treeRow.querySelector('[data-action="folder"]')?.dataset.id;return {el:treeRow,folder:id?Number(id):null};}
  const folderButton=target.closest('.file-table tbody tr')?.querySelector('[data-action="folder"][data-id]');
  if(folderButton)return {el:folderButton.closest('tr'),folder:Number(folderButton.dataset.id)};
  const area=target.closest('.explorer-main')??target.closest('.folder-tree');
  return area?{el:area,folder:features.folder??null}:null;
}
function libraryFolderName(folder){return folder===null?'전체 자료':(features.libraryTree??[]).find(row=>row.id===folder)?.name??'선택한 폴더';}
// 자료 등록: 파일과 폴더를 함께 처리한다. items는 [{path:'상위/하위', file}] 형태이며 path가 ''이면 대상 폴더에 바로 등록한다.
// 폴더째 올리면 하위 폴더 구조를 그대로 만들고, 같은 이름의 폴더가 이미 있으면 그 폴더에 합쳐 넣는다.
async function uploadLibraryTree(items,rootFolder,{dirs=[],failed=[]}={}){
  const tree=[...(await api('/library')).tree];
  const folderIds=new Map([['',rootFolder]]);
  const allDirs=[...new Set([...dirs,...items.map(item=>item.path).filter(Boolean)].flatMap(path=>path.split('/').map((_,index,parts)=>parts.slice(0,index+1).join('/'))))].sort((a,b)=>a.split('/').length-b.split('/').length);
  let createdFolders=0,done=0,duplicates=0;
  // 같은 폴더에 이름과 크기가 같은 파일이 이미 있으면 다시 올리지 않는다(같은 폴더를 다시 끌어 놓은 경우).
  const existingFiles=new Map();
  const filesIn=async folderId=>{
    if(existingFiles.has(folderId))return existingFiles.get(folderId);
    const keys=new Set();
    for(let page=1;;page++){const listing=await api('/library?'+new URLSearchParams({folder:folderId??'',page,page_size:100}));listing.files.forEach(row=>keys.add(row.name+'\u0000'+row.size));if(page*100>=listing.total)break;}
    existingFiles.set(folderId,keys);return keys;
  };
  for(const path of allDirs){
    const parts=path.split('/'),name=parts.at(-1).trim(),parentPath=parts.slice(0,-1).join('/');
    if(!folderIds.has(parentPath))continue;
    const parent=folderIds.get(parentPath),existing=tree.find(folder=>folder.parent_id===parent&&folder.name===name);
    if(existing){folderIds.set(path,existing.id);continue;}
    toast(`폴더 만드는 중 · ${path}`);
    try{const created=await api('/folders',{method:'POST',body:{name,parent_id:parent}});folderIds.set(path,created.id);tree.push({id:created.id,parent_id:parent,name});createdFolders++;}
    catch(error){failed.push(`${path}: ${error.message}`);}
  }
  for(const [index,{path,file}] of items.entries()){
    if(!folderIds.has(path)){failed.push(`${path}/${file.name}: 폴더를 만들지 못해 건너뜀`);continue;}
    toast(`자료 등록 중 ${index+1}/${items.length} · ${path?path+'/':''}${file.name}`);
    try{const folderId=folderIds.get(path),keys=await filesIn(folderId),key=file.name+'\u0000'+file.size;if(keys.has(key)){duplicates++;continue;}const body=new FormData();body.append('file',file);await api('/manuals?'+new URLSearchParams({folder:folderId??''}),{method:'POST',body});keys.add(key);done++;}
    catch(error){failed.push(`${path?path+'/':''}${file.name}: ${error.message}`);}
  }
  for(const id of folderIds.values())if(id!=null)features.expandedFolders.add(id);
  features.folder=rootFolder;features.libraryPage=1;features.libraryQuery='';
  await renderLibrary();
  const summary=`'${libraryFolderName(rootFolder)}'에 ${createdFolders?`폴더 ${createdFolders}개 · `:''}자료 ${done}개를 등록했습니다.${duplicates?` 이미 있는 파일 ${duplicates}개는 건너뛰었습니다.`:''}`;
  if(!failed.length)toast(summary);
  else toast(`${summary} 실패 ${failed.length}개 — ${failed.slice(0,3).join(', ')}${failed.length>3?' 외':''}`);
}
async function uploadLibraryFiles(files,folder,skipped=[]){await uploadLibraryTree(files.map(file=>({path:'',file})),folder,{failed:skipped});}
// 끌어 놓은 항목(파일·폴더)을 하위 폴더까지 읽는다.
// Google Drive 보내기(복사): Google Drive 데스크톱 앱이 연결한 폴더(예: G:\내 드라이브 안 폴더)를 브라우저에서 한 번 지정하면,
// 포털 자료를 그 폴더에 저장하고 Drive 앱이 클라우드로 동기화한다. 포털 자료는 그대로 남는다(Chrome·Edge 전용 파일 시스템 기능 사용).
const driveState={handle:null,name:''};
function driveDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('portal-drive',1);request.onupgradeneeded=()=>request.result.createObjectStore('handles');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function driveStore(handle){try{const db=await driveDb();await new Promise((resolve,reject)=>{const tx=db.transaction('handles','readwrite');if(handle)tx.objectStore('handles').put(handle,'target');else tx.objectStore('handles').delete('target');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();}catch{}}
async function driveLoad(){try{const db=await driveDb();const handle=await new Promise((resolve,reject)=>{const request=db.transaction('handles').objectStore('handles').get('target');request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);});db.close();return handle;}catch{return null;}}
driveLoad().then(handle=>{if(handle){driveState.handle=handle;driveState.name=handle.name;if(state.view==='library')renderLibrary().catch(()=>{});}});
function driveSupported(){return typeof window.showDirectoryPicker==='function';}
async function pickDriveFolder(){
  if(!driveSupported())throw new Error('Google Drive 보내기는 Chrome 또는 Edge 브라우저에서 사용할 수 있습니다.');
  let handle;
  try{handle=await window.showDirectoryPicker({id:'portal-google-drive',mode:'readwrite'});}catch(error){if(error.name==='AbortError')return null;throw error;}
  driveState.handle=handle;driveState.name=handle.name;await driveStore(handle);
  return handle;
}
async function driveTarget(){
  if(!driveSupported())throw new Error('Google Drive 보내기는 Chrome 또는 Edge 브라우저에서 사용할 수 있습니다.');
  let handle=driveState.handle;
  if(handle){
    let permission=await handle.queryPermission({mode:'readwrite'});
    if(permission==='prompt')permission=await handle.requestPermission({mode:'readwrite'});
    if(permission!=='granted')handle=null;
  }
  if(!handle){toast('복사할 Google Drive 폴더를 선택하세요. (예: G:\\내 드라이브 안의 폴더)');handle=await pickDriveFolder();}
  return handle;
}
// Windows 파일 이름에 쓸 수 없는 문자를 바꾼다.
function driveSafeName(name){const safe=String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').trim();return safe||'이름없음';}
async function driveExisting(directory,name){try{return await (await directory.getFileHandle(name)).getFile();}catch(error){if(error.name==='NotFoundError'||error.name==='TypeMismatchError')return null;throw error;}}
// 같은 이름·같은 크기의 파일이 있으면 건너뛰고, 크기가 다르면 '이름 (2).확장자'로 저장한다.
async function driveCopyFile(directory,file,counts){
  const base=driveSafeName(file.name),dot=base.lastIndexOf('.'),stem=dot>0?base.slice(0,dot):base,ext=dot>0?base.slice(dot):'';
  let name=base;
  for(let index=2;;index++){const existing=await driveExisting(directory,name);if(!existing)break;if(existing.size===file.size){counts.skipped++;return;}name=`${stem} (${index})${ext}`;}
  const response=await fetch('/api/manuals/'+file.id+'/download');
  if(!response.ok)throw new Error(`${file.name}: 포털에서 파일을 읽지 못했습니다.`);
  const handle=await directory.getFileHandle(name,{create:true}),writable=await handle.createWritable();
  try{await response.body.pipeTo(writable);}catch(error){try{await writable.abort();}catch{}try{await directory.removeEntry(name);}catch{}throw error;}
  counts.copied++;
}
async function libraryFilesIn(folderId){
  const files=[];
  for(let page=1;;page++){const listing=await api('/library?'+new URLSearchParams({folder:folderId??'',page,page_size:100}));files.push(...listing.files);if(page*100>=listing.total)break;}
  return files;
}
async function driveSendFile(id){
  const target=await driveTarget();if(!target)return;
  const {file}=await api('/manuals/'+id);const counts={copied:0,skipped:0};
  toast(`Google Drive로 복사 중 · ${file.name}`);
  await driveCopyFile(target,file,counts);
  toast(counts.skipped?`'${target.name}' 폴더에 같은 파일이 있어 건너뛰었습니다.`:`'${target.name}' 폴더에 ${file.name}을(를) 복사했습니다. Google Drive 앱이 동기화합니다.`);
}
async function driveSendFolder(id,targetDirectory=null,targetLabel=''){
  const target=targetDirectory??await driveTarget();if(!target)return;
  const tree=(await api('/library')).tree,root=tree.find(folder=>folder.id===Number(id));if(!root)throw new Error('폴더를 찾을 수 없습니다.');
  const counts={copied:0,skipped:0,folders:0},failed=[];
  const walk=async(folder,parentDirectory,path)=>{
    const directory=await parentDirectory.getDirectoryHandle(driveSafeName(folder.name),{create:true});counts.folders++;
    for(const file of await libraryFilesIn(folder.id)){toast(`Google Drive로 복사 중 · ${path}/${file.name}`);try{await driveCopyFile(directory,file,counts);}catch(error){failed.push(`${path}/${file.name}: ${error.message}`);}}
    for(const child of tree.filter(item=>item.parent_id===folder.id))await walk(child,directory,`${path}/${child.name}`);
  };
  await walk(root,target,root.name);
  const summary=`'${targetLabel||target.name}' 폴더에 '${root.name}'을(를) 복사했습니다 · 폴더 ${counts.folders}개 · 파일 ${counts.copied}개${counts.skipped?` · 같은 파일 ${counts.skipped}개 건너뜀`:''}.`;
  toast(failed.length?`${summary} 실패 ${failed.length}개 — ${failed.slice(0,2).join(', ')}`:summary);
}
function readDirectoryEntries(directory){return new Promise((resolve,reject)=>{const reader=directory.createReader(),all=[];const next=()=>reader.readEntries(batch=>{if(!batch.length)resolve(all);else{all.push(...batch);next();}},reject);next();});}
function entryFile(entry){return new Promise((resolve,reject)=>entry.file(resolve,reject));}
async function collectDroppedEntries(entries){
  const dirs=[],items=[],failed=[];
  const walk=async(entry,parentPath)=>{
    if(entry.isFile){try{items.push({path:parentPath,file:await entryFile(entry)});}catch{failed.push(`${parentPath?parentPath+'/':''}${entry.name}: 파일을 읽을 수 없음`);}return;}
    if(!entry.isDirectory)return;
    const path=parentPath?`${parentPath}/${entry.name}`:entry.name;dirs.push(path);
    let children=[];try{children=await readDirectoryEntries(entry);}catch{failed.push(`${path}: 폴더를 읽을 수 없음`);}
    for(const child of children)await walk(child,path);
  };
  for(const entry of entries)await walk(entry,'');
  return {dirs,items,failed};
}
// 폴더 선택 창으로 고른 폴더: 파일마다 '최상위폴더/하위/파일명' 경로가 붙어 온다(빈 폴더는 브라우저가 전달하지 않음).
function folderPickerItems(files){return [...files].map(file=>{const parts=(file.webkitRelativePath||file.name).split('/');return {path:parts.slice(0,-1).join('/'),file};});}
let activeDropTarget=null;
function setDropTarget(target){if(activeDropTarget===target)return;activeDropTarget?.classList.remove('file-drop-active');activeDropTarget=target;target?.classList.add('file-drop-active');}
document.addEventListener('dragover',event=>{
  if(!event.dataTransfer?.types?.includes('Files'))return;
  const target=fileDropTarget(event);setDropTarget(target);
  if(target){event.preventDefault();event.dataTransfer.dropEffect='copy';return;}
  // 등록 영역 밖에 놓아 브라우저가 파일을 열고 포털 화면을 벗어나는 것을 막는다. 파일 선택 입력칸은 기본 동작을 유지한다.
  if(!event.target.closest?.('input[type="file"]')){event.preventDefault();event.dataTransfer.dropEffect='none';}
});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget||!document.documentElement.contains(event.relatedTarget))setDropTarget(null);});
document.addEventListener('dragend',()=>setDropTarget(null));
document.addEventListener('drop',async event=>{
  if(!event.dataTransfer?.types?.includes('Files'))return;
  const target=fileDropTarget(event);setDropTarget(null);
  if(!target){if(!event.target.closest?.('input[type="file"]'))event.preventDefault();return;}
  event.preventDefault();
  // 끌어 놓은 항목은 await 전에 동기적으로 읽어 두어야 한다. 자료 관리는 폴더째 등록하고, 다른 화면은 폴더를 제외한다.
  const items=[...(event.dataTransfer.items??[])].filter(item=>item.kind==='file');
  const entries=items.map(item=>item.webkitGetAsEntry?.()??null);
  if(state.view==='library'&&entries.some(entry=>entry?.isDirectory)){
    const info=libraryDropInfo(event.target),folder=info?info.folder:features.folder??null;
    const loose=items.filter((_,index)=>!entries[index]).map(item=>item.getAsFile()).filter(Boolean);
    try{toast('폴더 내용을 읽는 중입니다…');const collected=await collectDroppedEntries(entries.filter(Boolean));await uploadLibraryTree([...collected.items,...loose.map(file=>({path:'',file}))],folder,{dirs:collected.dirs,failed:collected.failed});}
    catch(error){toast(error.message);}
    return;
  }
  const skipped=[],files=[];
  if(items.length){items.forEach((item,index)=>{const entry=entries[index],file=item.getAsFile();if(entry?.isDirectory){skipped.push(`${entry.name}: 폴더는 이 화면에서 등록할 수 없음`);return;}if(file)files.push(file);});}
  else files.push(...event.dataTransfer.files);
  if(!files.length){if(skipped.length)toast(skipped.join(', '));return;}
  try{
    if(state.view==='todos')await extras.todoFileDrop(target,files);
    else if(state.view==='work')await extras.customerFileDrop(files);
    else if(state.view==='library'){const info=libraryDropInfo(event.target);await uploadLibraryFiles(files,info?info.folder:features.folder??null,skipped);}
  }catch(error){toast(error.message);}
});
recordMenu.addEventListener('click',event=>{if(event.target.closest('button'))queueMicrotask(hideRecordMenu);});
document.addEventListener('pointerdown',event=>{if(!recordMenu.hidden&&!recordMenu.contains(event.target))hideRecordMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideRecordMenu();});
window.addEventListener('scroll',hideRecordMenu,true);
window.addEventListener('resize',hideRecordMenu);
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  try{
    if(bulkMode?.deleting){toast('선택한 항목을 삭제하는 중입니다. 잠시 기다려 주세요.');return;}
    if(button.dataset.view){await navigateTo(button.dataset.view);return;}
    if(button.dataset.tableSort){const kind=button.dataset.tableSort,key=button.dataset.sort,config=tableState[kind];if(!tableColumns[kind]?.includes(key))return;config.direction=config.sort===key?(config.direction==='asc'?'desc':'asc'):['updated_at','created_at','work_date','installed_on','completed_on','due_date'].includes(key)?'desc':'asc';config.sort=key;resetListingPage(kind);await renderView();return;}
    const action=button.dataset.action,id=button.dataset.id;if(!action)return;
    if(action==='view-back'){await navigateBack();return;}
    if(action==='menu-reset'){if(state.view!=='settings')return;sidebarMenuOrder=sidebarMenus.map(([view])=>view);saveSidebarMenu();renderSidebarMenu();renderSettingsMenu();document.querySelector('[data-action="menu-reset"]')?.focus();return;}
    if(action==='menu-up'||action==='menu-down'){
      if(state.view!=='settings')return;
      sidebarMenuOrder=moveMenuId(sidebarMenuOrder,id,action==='menu-up'?-1:1);
      saveSidebarMenu();renderSidebarMenu();renderSettingsMenu();
      document.querySelector(`[data-action="${action}"][data-id="${id}"]`)?.focus();return;
    }
    if(action==='dashboard-work'){await navigateTo('work');await extras.action('work-log',id,button);return;}
    if(action==='close'){modal.close();return;}
    if(action==='bulk-start'){await startBulk(button.dataset.kind,id);return;}
    if(action==='bulk-select-visible'){document.querySelectorAll('#content input[data-bulk-id]').forEach(box=>{if(box.getClientRects().length)bulkMode.selected.add(box.dataset.bulkId);});updateBulkUI();return;}
    if(action==='bulk-clear'){bulkMode.selected.clear();updateBulkUI();return;}
    if(action==='bulk-cancel'){bulkMode=null;await renderView();return;}
    if(action==='bulk-delete'){await deleteBulkSelection();return;}
    if(action==='backup-create'){await api('/backups',{method:'POST',body:{}});await renderBackups();toast('백업을 저장했습니다. 목록에서 다운로드할 수 있습니다.');return;}
    if(action==='backup-restore'){backupRestoreDialog();return;}
    if(await management.action(action,id,button))return;
    if(await extras.action(action,id,button))return;
    if(await featureAction(action,id,button))return;
    if(action==='new-item'||action==='item')await itemDialog(id);
    if(action==='new-user'||action==='user'){userDialog(id);if(id&&Number(id)!==state.user.id)modal.querySelector('.form-actions').insertAdjacentHTML('afterbegin',`<button type="button" class="danger" data-action="delete-user" data-id="${Number(id)}">사용자 삭제</button>`);}
    if(action==='prev'||action==='next'){state.page+=action==='prev'?-1:1;await renderItems();}
    if(action==='users-prev'||action==='users-next'){tableState.users.page+=action==='users-prev'?-1:1;await showUsers();}
    if(action==='reset-filter'){state.filters={};state.page=1;await renderItems();}
    if(action==='logout'){await api('/auth/logout',{method:'POST',body:{}});state.user=null;clearInterval(pollTimer);modal.close();authPage(false);}
    if(action==='password')passwordDialog();
    if(action==='account')openDialog('내 계정',`<p>${esc(state.user.name)} · ${labels[state.user.role]}</p><div class="form-actions"><button data-action="password">비밀번호 변경</button><button data-action="logout">로그아웃</button></div>`);
    if(action==='delete-file'&&confirm('첨부자료를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/files/'+id,{method:'DELETE'});await itemDialog(state.item.id);await renderView();toast('첨부자료를 삭제했습니다.');}
    if(action==='delete-item'&&confirm('이 자산과 첨부자료·변경 이력을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/items/'+id,{method:'DELETE'});if(modal.open)modal.close();await renderView();await refreshCount();toast('자산을 삭제했습니다.');}
    if(action==='delete-user'&&confirm('사용자 계정을 삭제할까요? 이력이 있는 계정은 삭제할 수 없으며 비활성화할 수 있습니다.')){await api('/users/'+id,{method:'DELETE'});if(modal.open)modal.close();await showUsers();toast('사용자를 삭제했습니다.');}
    if(action==='read'||action==='read-all'){await api('/notifications/read',{method:'POST',body:id?{id}:{}});await renderNotifications();}
    if(action==='refresh-notifications')await renderNotifications();
  }catch(error){if(modal.open)document.querySelector('#dialog-error').textContent=error.message;else toast(error.message);}
});
document.addEventListener('change',async event=>{const todo=event.target.closest('input[data-todo-toggle]');if(todo){try{await extras.toggleTodo(todo);}catch(error){todo.checked=!todo.checked;toast(error.message);}return;}try{if(await management.change(event.target))return;}catch(error){toast(error.message);}const select=event.target.closest('select[data-page-size]');if(!select)return;const kind=select.dataset.pageSize,size=Number(select.value);if(!allowedPageSizes.includes(size)||!tableState[kind])return;try{tableState[kind].size=size;try{localStorage.setItem('portal-page-size-'+kind,String(size));}catch{}resetListingPage(kind);await renderView();}catch(error){toast(error.message);}});
document.addEventListener('change',async event=>{if(event.target.id!=='library-folder-picker'||!event.target.files.length)return;const input=event.target,picked=folderPickerItems(input.files),target=features.uploadTarget!==undefined?features.uploadTarget:features.folder??null;features.uploadTarget=undefined;try{await uploadLibraryTree(picked,target);}catch(error){toast(error.message);}finally{input.value='';}});
document.addEventListener('change',event=>{const box=event.target.closest('input[data-bulk-id]');if(!box||!bulkMode)return;if(box.checked)bulkMode.selected.add(box.dataset.bulkId);else bulkMode.selected.delete(box.dataset.bulkId);updateBulkUI();});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.id)return;event.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])');const originalSubmitText=submit?.textContent;const errorBox=form.querySelector('.error')??document.querySelector('#dialog-error');if(errorBox)errorBox.textContent='';if(submit){submit.disabled=true;if(form.id==='installation-form')submit.textContent='저장 중…';else if(['upload-form','manual-form','installation-upload'].includes(form.id))submit.textContent='업로드 중…';}
  try{
    const values=Object.fromEntries(new FormData(form));
    if(form.id==='backup-restore-form'){
      const previous=await (await fetch('/api/health',{cache:'no-store'})).json();
      const started=await api('/backups/'+encodeURIComponent(values.name)+'/restore',{method:'POST',body:{confirm:values.name}});
      modal.close();
      try{await waitForRestore(started.restore_id,previous.instance_id);}
      catch(error){document.querySelector('#content').innerHTML=pageHead('RESTORE STATUS','복구 결과 확인 필요',error.message)+'<section class="panel"><div class="empty"><h3>포털 상태를 확인해 주세요</h3><p>새로고침 후에도 접속되지 않으면 운영 기록(data/server.log)을 확인해 주세요.</p></div></section>';}
      return;
    }
    if(await management.submit(form,values))return;
    if(await extras.submit(form,values))return;
    if(await featureSubmit(form,values))return;
    if(form.id==='auth-form'){const result=await api('/auth/'+(form.dataset.setup==='true'?'setup':'login'),{method:'POST',body:values});await signedIn(result.user);}
    if(form.id==='filter-form'){if(values.from&&values.to&&values.from>values.to)throw new Error('종료일은 시작일 이후로 설정해 주세요.');const categoryId=state.filters.category_id;state.filters=Object.fromEntries(Object.entries(values).filter(([,v])=>v));if(categoryId)state.filters.category_id=categoryId;state.page=1;await renderItems();}
    if(form.id==='item-form'){values.quantity=Number(values.quantity);values.reminder_days=Number(values.reminder_days);values.version=state.item.version;const saved=await api('/items'+(state.item.id?'/'+state.item.id:''),{method:state.item.id?'PUT':'POST',body:values});await renderView();await itemDialog(saved.item.id);await refreshCount();toast('자산 정보를 저장했습니다.');}
    if(form.id==='upload-form'){const file=form.elements.file.files[0];await api('/items/'+state.item.id+'/files',{method:'POST',body:new FormData(form)});await itemDialog(state.item.id);await renderView();toast('첨부자료를 등록했습니다.');}
    if(form.id==='user-form'){values.active=state.editUser.id?form.elements.active.checked:true;await api('/users'+(state.editUser.id?'/'+state.editUser.id:''),{method:state.editUser.id?'PUT':'POST',body:values});modal.close();await showUsers();toast('사용자 정보를 저장했습니다.');}
    if(form.id==='password-form'){await api('/auth/password',{method:'POST',body:values});modal.close();state.user=null;clearInterval(pollTimer);authPage(false);toast('비밀번호를 변경했습니다. 다시 로그인해 주세요.');}
  }catch(error){if(errorBox&&errorBox.isConnected){errorBox.textContent=error.message;if(form.id==='installation-form')errorBox.scrollIntoView({block:'nearest'});}else toast(error.message);}finally{if(submit?.isConnected){submit.disabled=false;submit.textContent=originalSubmitText;}}
});
Object.assign(labels,{planned:'설치 예정',installed:'설치 완료',maintenance:'유지보수',closed:'종료'});
let pdfDoc=null,pdfPage=1,pdfRender=null;
const features={installationPage:1,installationFilters:{},installation:null,folder:null,libraryPage:1,libraryQuery:'',expandedFolders:new Set()};
const extras=createExtras({api,esc,state,features,canEdit,openDialog,input,toast,fmt,pageHead,renderItems,renderInstallations,renderView,modal,labels,listingQuery,decorateListing});
const management=createManagement({api,esc,state,canEdit,openDialog,input,toast,fmt,pageHead,modal,renderView});
applyTheme();
try{const result=await api('/auth/me');if(result.user)await signedIn(result.user);else authPage(result.setupRequired);}catch(error){root.innerHTML=`<main class="error-page"><h1>포털에 연결할 수 없습니다</h1><p>${esc(error.message)}</p><button onclick="location.reload()">다시 시도</button></main>`;root.querySelector('button').removeAttribute('onclick');root.querySelector('button').addEventListener('click',()=>location.reload());}


function applyTheme(mode){if(!mode){try{mode=localStorage.getItem('portal-theme')??'light';}catch{mode='light';}}document.documentElement.dataset.theme=mode==='dark'?'dark':'light';if(mode){try{localStorage.setItem('portal-theme',mode);}catch{}}}
function pageHead(tag,title,subtitle,action=''){return `<div class="page-head"><div><p class="eyebrow">${esc(tag)}</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;}
async function renderDashboard(){
 const [d,usage]=await Promise.all([api('/dashboard'),state.user.role==='admin'?api('/usage').catch(()=>null):null]);if(state.view!=='dashboard')return;
 document.querySelector('#content').innerHTML=pageHead('WORKSPACE OVERVIEW','대시보드',`${state.user.name}님, 오늘의 설치·자료·자산 현황입니다.`)+`<div class="stats">${[['등록 자산',d.counts.assets,'items'],['설치 정보',d.counts.installations,'installations'],['등록 자료',d.counts.manuals,'library'],['읽지 않은 알림',d.counts.unread,'notifications']].map(([name,n,view])=>`<button class="stat stat-button" data-view="${view}"><div class="stat-label">${name}</div><div class="stat-value">${n}<span>건</span></div></button>`).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2>다가오는 관리 기한</h2><button class="small" data-view="notifications">알림 보기</button></div>${d.deadlines.length?d.deadlines.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)}</span></button><span class="badge ${i.due_date<d.today?'overdue':i.due_date===d.today?'today':'upcoming'}">${esc(i.due_date)}${i.due_date<d.today?' · 경과':i.due_date===d.today?' · 오늘':''}</span></div>`).join(''):'<div class="empty"><h3>7일 이내 예정된 기한이 없습니다</h3><p>자산의 관리 기한을 등록하면 여기에 표시됩니다.</p></div>'}</section><section class="panel"><div class="panel-head"><h2>최근 설치 정보</h2><button class="small" data-view="installations">전체 보기</button></div>${d.installations.length?d.installations.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.customer)} · ${i.installed_on}</span></button><span class="badge ${i.status}">${labels[i.status]}</span></div>`).join(''):'<div class="empty"><h3>아직 설치 정보가 없습니다</h3><p>사업장과 설치 제품 정보를 등록해 보세요.</p></div>'}</section><section class="panel full"><div class="panel-head"><h2>최근 업데이트한 자산</h2><button class="small" data-view="items">자산 관리</button></div>${d.recent.length?d.recent.map(i=>`<div class="dashboard-row"><button class="link-button" data-action="item" data-id="${i.id}">${esc(i.name)}<span class="secondary-line">${esc(i.asset_code)} · ${labels[i.category]}</span></button><small>${fmt(i.updated_at)}</small></div>`).join(''):'<div class="empty"><h3>등록된 자산이 없습니다</h3><p>일반 비품과 IT 장비를 등록하고 관리하세요.</p></div>'}</section></div>`;
 const workPanel=document.querySelector('#content .dashboard-grid .panel');
 if(workPanel)workPanel.innerHTML=`<div class="panel-head"><h2>최근 일주일 업무관리</h2><button class="small" data-view="work">업무관리 보기</button></div>${d.recentWork.length?d.recentWork.map(row=>`<div class="dashboard-row"><button class="link-button" data-action="dashboard-work" data-id="${row.id}">${esc(row.title)}<span class="secondary-line">${esc(row.customer_name)} · ${esc(row.work_date)}</span></button><span class="badge">${esc(row.status)}</span></div>`).join(''):'<div class="empty"><h3>최근 일주일 업무일지가 없습니다</h3><p>업무관리에서 고객별 업무 내용을 기록해 보세요.</p></div>'}`;
 // 오늘의 할 일(로그인 사용자의 미완료 메모)과 최근 프로젝트 3건
 const memo=row=>{const text=[row.title,row.body].filter(Boolean).join(' ').replace(/\s+/g,' ').trim()||'내용 없는 메모';return text.length>80?text.slice(0,80)+'…':text;};
 const projectPhase={before:'설치 전',during:'설치 중',after:'설치 후'},projectStatus={planned:'예정',in_progress:'진행 중',on_hold:'보류',completed:'완료'},projectKind={installation:'설치',other:'기타'};
 const extra=document.createElement('div');extra.className='dashboard-grid dashboard-extra';
 extra.innerHTML=`<section class="panel"><div class="panel-head"><h2>오늘의 할 일 · 미완료 ${d.openTodoCount}건</h2><button class="small" data-view="todos">TO-DO List</button></div>${d.openTodos.length?d.openTodos.map(row=>`<div class="dashboard-row"><button class="link-button dashboard-todo" data-view="todos" title="${esc(memo(row))}">${esc(memo(row))}<span class="secondary-line">${esc(row.target_date)}</span></button><span class="badge ${row.target_date<d.today?'overdue':row.target_date===d.today?'today':'upcoming'}">${row.target_date<d.today?'지난 날짜':row.target_date===d.today?'오늘':'예정'}</span></div>`).join('')+(d.openTodoCount>d.openTodos.length?`<div class="dashboard-row dashboard-more"><button class="link-button" data-view="todos">외 ${d.openTodoCount-d.openTodos.length}건 더 보기</button></div>`:''):'<div class="empty"><h3>완료하지 않은 할 일이 없습니다</h3><p>TO-DO List에서 오늘의 할 일을 메모해 보세요.</p></div>'}</section><section class="panel"><div class="panel-head"><h2>최근 프로젝트</h2><button class="small" data-view="projects">프로젝트 관리</button></div>${d.recentProjects.length?d.recentProjects.map(row=>`<div class="dashboard-row"><button class="link-button" data-action="project-open" data-id="${row.id}">${esc(row.name)}<span class="secondary-line">${esc(row.customer||'고객사 미지정')} · ${projectKind[row.kind]??''} · ${esc(row.planned_start||'—')} ~ ${esc(row.planned_end||'—')}</span></button><span class="badge ${row.status}">${projectPhase[row.phase]??''} · ${projectStatus[row.status]??''}</span></div>`).join(''):'<div class="empty"><h3>등록된 프로젝트가 없습니다</h3><p>프로젝트 관리에서 설치·기타 프로젝트를 등록해 보세요.</p></div>'}</section>`;
 document.querySelector('#content .dashboard-grid')?.before(extra); // 저장소 사용량(관리자): 드라이브 사용률·여유 공간과 포털 데이터 합계. 자세한 내용은 사용량 관리 메뉴.
 if(usage){
  const size=n=>{n=Number(n)||0;return n>=1024**4?(n/1024**4).toFixed(2)+' TB':n>=1024**3?(n/1024**3).toFixed(2)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';};
  const drive=usage.drives[0]??{},rate=drive.total?Math.round(drive.used/drive.total*1000)/10:0;
  const portalTotal=usage.storage.reduce((sum,row)=>sum+row.size,0),attachTotal=usage.attachments.reduce((sum,row)=>sum+row.size,0),backups=usage.storage.find(row=>row.key==='backups');
  const panel=document.createElement('section');panel.className='panel dashboard-usage';
  panel.innerHTML=`<div class="panel-head"><h2>저장소 사용량</h2><button class="small" data-view="usage">사용량 관리</button></div><div class="dashboard-usage-body">${drive.error||!drive.total?'<p class="error-text">드라이브 정보를 읽지 못했습니다.</p>':`<div class="dashboard-usage-drive"><div class="usage-drive-head"><strong>${esc(drive.root)} 드라이브 · 사용률 ${rate}%</strong><span>${size(drive.used)} 사용 / 전체 ${size(drive.total)} · 여유 ${size(drive.free)}</span></div><progress class="usage-bar ${rate>=90?'danger':''}" max="${drive.total}" value="${drive.used}" aria-label="드라이브 사용률 ${rate}%"></progress></div>`}<dl class="dashboard-usage-figures"><div><dt>포털 데이터</dt><dd>${size(portalTotal)}</dd></div><div><dt>첨부파일</dt><dd>${size(attachTotal)}</dd></div><div><dt>백업 폴더</dt><dd>${size(backups?.size)}${backups?.count!=null?` · ${backups.count}개`:''}</dd></div></dl></div>`;
  document.querySelector('#content .stats')?.after(panel);
 }
}
async function renderInstallations(){
  const d=await api('/installations?'+new URLSearchParams({...features.installationFilters,...listingQuery('installations',features.installationPage)}));
  if(state.view!=='installations')return;
  const f=features.installationFilters;
  const shortDate=value=>value?value.slice(2).replaceAll('-','.'): '—';
  const rows=d.installations.map((i,index)=>`<tr>
    <td class="installation-number">${(d.page-1)*d.page_size+index+1}</td>
    <td class="installation-customer"><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.customer)}</button></td>
    <td><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.name)}</button><span class="secondary-line">${esc(labels[i.status])}</span></td>
    <td class="installation-text"><button class="link-button" data-action="installation" data-id="${i.id}">${esc(i.product_version)||'—'}</button></td>
    <td class="installation-number">${i.quantity??1}</td>
    <td>${shortDate(i.installed_on)}</td><td>${shortDate(i.completed_on)}</td>
    <td>${esc(i.contact)||'—'}</td><td>${esc(i.engineer)||'—'}</td>
    <td class="installation-text installation-notes" title="${esc(i.notes)}">${esc(i.notes)||'—'}</td>
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
    <div class="footer-row"><span>설치 정보 ${d.total}건</span><div class="pager"><button class="small" data-action="installation-prev" ${d.page<=1?'disabled':''}>이전</button><span>${d.page} / ${Math.max(1,Math.ceil(d.total/d.page_size))}</span><button class="small" data-action="installation-next" ${d.page>=Math.ceil(d.total/d.page_size)?'disabled':''}>다음</button></div></div></section>`;
  decorateListing('installations',d.total,d.page);
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
  </div>${canEdit()?'<div class="error" role="alert"></div><p class="save-status" role="status" aria-live="polite"></p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div>':''}</form>${id?`<section class="subsection"><h3>첨부자료 <small>${result.files.length}개</small></h3>${result.files.length?result.files.map(f=>`<div class="file-row"><div><strong>${esc(f.name)}</strong><span class="secondary-line">${fileSize(f.size)} · ${fmt(f.created_at)}</span></div><div class="file-actions">${f.preview_type?`<a href="/api/installation-files/${f.id}/preview" target="_blank" rel="noopener">미리보기</a>`:''}<a href="/api/installation-files/${f.id}/download">다운로드</a>${canEdit()?`<button class="small danger" data-action="installation-delete-file" data-id="${f.id}">삭제</button>`:''}</div></div>`).join(''):'<p class="muted">등록된 첨부자료가 없습니다.</p>'}${canEdit()?'<form class="upload" id="installation-upload"><input aria-label="첨부할 자료" type="file" name="file" required><button type="submit">자료 첨부</button></form>':''}</section>`:'<p class="save-note">설치 정보를 먼저 저장하면 자료를 첨부할 수 있습니다.</p>'}`);
  if(id&&canEdit())modal.querySelector('.dialog-body').insertAdjacentHTML('beforeend',`<div class="form-actions"><button type="button" class="danger" data-action="installation-delete" data-id="${Number(id)}">설치 정보 삭제</button></div>`);
}
function fileSize(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';}
function fileType(name){return name.includes('.')?name.split('.').pop().slice(0,8).toUpperCase():'FILE';}
function folderTree(tree,parent=null,depth=0){
 return tree.filter(f=>f.parent_id===parent).map(f=>{
  const hasChildren=tree.some(child=>child.parent_id===f.id),expanded=features.expandedFolders.has(f.id);
  const toggle=hasChildren?`<button class="folder-tree-toggle" data-action="folder-toggle" data-id="${f.id}" data-name="${esc(f.name)}" aria-expanded="${expanded}" aria-controls="folder-children-${f.id}" aria-label="${esc(f.name)} ${expanded?'접기':'펼치기'}"><span class="folder-chevron" aria-hidden="true"></span></button>`:'<span class="folder-tree-toggle-spacer" aria-hidden="true"></span>';
  return `<div class="folder-tree-row ${features.folder===f.id?'selected':''}" data-depth="${depth}">${toggle}<button class="folder-tree-link" data-action="folder" data-id="${f.id}" title="${esc(f.name)}"><span class="explorer-folder-icon" aria-hidden="true"></span><span class="folder-tree-name">${esc(f.name)}</span></button></div>${hasChildren?`<div id="folder-children-${f.id}" class="folder-tree-children" role="group" ${expanded?'':'hidden'}>${folderTree(tree,f.id,depth+1)}</div>`:''}`;
 }).join('');
}
async function renderLibrary(){
 const d=await api('/library?'+new URLSearchParams({folder:features.folder??'',q:features.libraryQuery,...listingQuery('library',features.libraryPage)}));if(state.view!=='library')return;
 features.libraryTree=d.tree;
 const folderById=new Map(d.tree.map(f=>[f.id,f]));
 for(let current=folderById.get(features.folder);current?.parent_id!=null;current=folderById.get(current.parent_id))features.expandedFolders.add(current.parent_id);
 const driveButton=`<button data-action="drive-settings" title="자료를 복사할 Google Drive 폴더(G:\\내 드라이브 안) 지정">Drive 폴더${driveState.name?`: ${esc(driveState.name)}`:' 지정'}</button>`;
 const controls=canEdit()?`<div class="head-actions">${driveButton}<input type="file" id="library-folder-picker" webkitdirectory multiple hidden><button class="primary" data-action="upload-manual">＋ 자료 등록</button></div>`:`<div class="head-actions">${driveButton}</div>`;
 document.querySelector('#content').innerHTML=pageHead('DOCUMENT LIBRARY','자료 관리','폴더를 자유롭게 만들고 자료를 정리하세요.',controls)+`<section class="panel explorer"><aside class="folder-tree" aria-label="자료 폴더 탐색기"><div class="folder-tree-title">폴더</div><div class="folder-tree-row folder-tree-root ${features.folder===null?'selected':''}"><span class="folder-tree-toggle-spacer" aria-hidden="true"></span><button class="folder-tree-link" data-action="folder"><span class="explorer-folder-icon" aria-hidden="true"></span><span class="folder-tree-name">전체 자료</span></button></div>${folderTree(d.tree)}</aside><div class="explorer-main"><div class="explorer-toolbar"><nav class="breadcrumbs" aria-label="폴더 경로"><button data-action="folder">전체 자료</button>${d.breadcrumbs.map(f=>`<span>/</span><button data-action="folder" data-id="${f.id}">${esc(f.name)}</button>`).join('')}</nav><form id="library-search" class="library-search"><input name="q" aria-label="현재 폴더 검색" placeholder="현재 폴더에서 검색" value="${esc(features.libraryQuery)}"><button>검색</button></form></div><div class="table-wrap"><table class="file-table"><thead><tr><th>이름</th><th>유형</th><th>크기</th><th>등록일</th><th>관리</th></tr></thead><tbody>${d.folders.map(f=>`<tr><td><button class="file-name" data-action="folder" data-id="${f.id}"><span class="folder-icon" aria-hidden="true">▰</span>${esc(f.name)}</button></td><td>폴더</td><td>—</td><td>${fmt(f.created_at)}</td><td><div class="file-actions"><button class="small" data-action="drive-folder" data-id="${f.id}" title="이 폴더를 하위 폴더째 Google Drive 폴더에 복사">Drive</button>${canEdit()?`<button class="small" data-action="rename-folder" data-id="${f.id}">이름 변경</button><button class="small" data-action="move-folder" data-id="${f.id}">이동</button><button class="small danger" data-action="delete-folder" data-id="${f.id}">삭제</button>`:''}</div></td></tr>`).join('')}${d.files.map(f=>`<tr><td><button class="file-name" data-action="preview" data-id="${f.id}"><span class="extension-icon">${esc(fileType(f.name))}</span><span>${esc(f.name)}<span class="secondary-line">${esc(f.uploaded_by_name)}</span></span></button></td><td>${esc(fileType(f.name))}</td><td>${fileSize(f.size)}</td><td>${fmt(f.created_at)}</td><td><div class="file-actions"><a href="/api/manuals/${f.id}/download">다운로드</a><button class="small" data-action="drive-file" data-id="${f.id}" title="Google Drive 폴더에 복사">Drive</button>${canEdit()?`<button class="small" data-action="edit-manual" data-id="${f.id}">수정</button><button class="small danger" data-action="delete-manual" data-id="${f.id}">삭제</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>${!d.folders.length&&!d.files.length?'<div class="empty"><h3>표시할 폴더나 파일이 없습니다</h3><p>새 폴더를 만들거나 자료를 등록하세요.<br>검색 중이라면 검색어를 바꿔 보세요.</p></div>':''}${canEdit()?`<div class="library-drop-hint">파일을 이 영역에 끌어 놓으면 <strong>${esc(features.folder===null?'전체 자료':(d.breadcrumbs.at(-1)?.name??'현재 폴더'))}</strong>에 바로 등록됩니다. 왼쪽 트리나 목록의 폴더 위에 놓으면 그 폴더에 등록됩니다.</div>`:''}<div class="footer-row"><span>폴더 ${d.folders.length}개 · 파일 ${d.total}개</span><div class="pager"><button class="small" data-action="library-prev" ${d.page<=1?'disabled':''}>이전</button><span>${d.page} / ${Math.max(1,Math.ceil(d.total/50))}</span><button class="small" data-action="library-next" ${d.page>=Math.ceil(d.total/50)?'disabled':''}>다음</button></div></div></div></section><p class="help-line">현재 위치에 자료를 등록하고 폴더 안에 폴더를 계속 만들 수 있습니다. 폴더 생성·폴더 업로드·폴더 이름 변경·폴더 이동은 빈 공간이나 폴더를 마우스 오른쪽 버튼으로 눌러 사용하세요. 파일 크기 제한 없음 · PDF, PNG, JPG, GIF, WebP, 텍스트 파일 미리보기 지원. Office·HWP 등 그 외 파일은 다운로드로 확인하세요.</p>`;
 decorateListing('library',d.total,d.page);
 enableColumnResize(document.querySelector('#content .file-table'),'library'); enableTreeResize(document.querySelector('#content .explorer'));
}
function libraryFolderPath(folder,byId){
 const names=[],seen=new Set();
 for(let current=folder;current&&!seen.has(current.id);current=byId.get(current.parent_id)){names.unshift(current.name);seen.add(current.id);}
 return names.join(' / ');
}
// 폴더 선택기(윈도우 탐색기 형태): 들여쓰기·펼침/접기 화살표·노란 폴더 아이콘으로 위치를 고른다.
// 선택 값은 숨은 입력칸에 담기며 'root'는 전체 자료, 숫자는 폴더 ID다. disabled 폴더는 고를 수 없고 hidden 폴더는 그 아래를 표시하지 않는다.
function folderPickerHtml({name,folders,value='',disabled=new Map(),hideChildrenOf=new Set(),rootDisabled='',drive=false}){
  const byId=new Map(folders.map(folder=>[folder.id,folder])),expanded=new Set();
  const selectedId=value&&value!=='root'?Number(value):null;
  for(let current=byId.get(selectedId);current?.parent_id!=null;current=byId.get(current.parent_id))expanded.add(current.parent_id);
  for(const id of disabled.keys())for(let current=byId.get(id);current?.parent_id!=null;current=byId.get(current.parent_id))expanded.add(current.parent_id);
  const children=parent=>folders.filter(folder=>folder.parent_id===parent);  // 서버가 보낸 이름순(왼쪽 폴더 트리와 같은 순서)
  const row=(id,label,depth,hasChildren,isOpen,note)=>{
    const off=Boolean(note),selected=String(value)===String(id);
    const toggle=hasChildren?`<button type="button" class="picker-toggle" data-action="picker-toggle" aria-expanded="${isOpen}" aria-label="${esc(label)} ${isOpen?'접기':'펼치기'}"><span class="folder-chevron" aria-hidden="true"></span></button>`:'<span class="picker-toggle-spacer" aria-hidden="true"></span>';
    return `<div class="picker-row ${selected?'selected':''} ${off?'disabled':''}">${toggle}<button type="button" class="picker-link" data-action="picker-select" data-picker-value="${id}" data-picker-label="${esc(label)}" role="treeitem" aria-selected="${selected}" ${off?'aria-disabled="true"':''} title="${esc(note||label)}"><span class="explorer-folder-icon" aria-hidden="true"></span><span class="picker-name">${esc(label)}</span>${note?`<span class="picker-note">${esc(note)}</span>`:''}</button></div>`;
  };
  const branch=(parent,depth)=>children(parent).map(folder=>{
    const kids=hideChildrenOf.has(folder.id)?[]:children(folder.id),isOpen=expanded.has(folder.id);
    return row(folder.id,folder.name,depth,kids.length>0,isOpen,disabled.get(folder.id))+(kids.length?`<div class="picker-children" role="group" ${isOpen?'':'hidden'}>${branch(folder.id,depth+1)}</div>`:'');
  }).join('');
  const selectedLabel=value==='root'?'전체 자료':selectedId!=null?libraryFolderPath(byId.get(selectedId),byId):'';
  return `<div class="folder-picker" data-picker-name="${name}"><input type="hidden" name="${name}" value="${esc(value)}"><div class="picker-tree" role="tree" aria-label="폴더 선택">${row('root','전체 자료',0,false,true,rootDisabled)}<div class="picker-children picker-root-children">${branch(null,1)}</div></div>${drive?driveSectionHtml():''}<p class="picker-selected">선택한 위치: <strong>${selectedLabel?esc(selectedLabel):'없음'}</strong></p></div>`;
}
// 폴더 선택기의 Google Drive 영역: 지정한 Drive 폴더와 그 하위 폴더를 같은 탐색기 형태로 보여 준다.
// 하위 폴더는 펼칠 때 브라우저가 읽어 오며(폴더 접근 허용 필요), Drive를 고르면 포털 자료는 그대로 두고 복사한다.
function driveRowHtml(path,label,note=''){
  const off=Boolean(note);
  return `<div class="picker-row picker-drive-row ${off?'disabled':''}"><button type="button" class="picker-toggle" data-action="picker-drive-toggle" data-drive-path="${esc(path)}" aria-expanded="false" aria-label="${esc(label)} 펼치기" ${off?'hidden':''}><span class="folder-chevron" aria-hidden="true"></span></button>${off?'<span class="picker-toggle-spacer" aria-hidden="true"></span>':''}<button type="button" class="picker-link" data-action="picker-select" data-picker-value="drive:${esc(path)}" data-picker-label="${esc(label)}" role="treeitem" aria-selected="false" ${off?'aria-disabled="true"':''} title="${esc(note||label)}"><span class="drive-folder-icon" aria-hidden="true"></span><span class="picker-name">${esc(label)}</span>${note?`<span class="picker-note">${esc(note)}</span>`:''}</button></div><div class="picker-children" role="group" hidden></div>`;
}
function driveSectionHtml(){
  if(!driveSupported())return `<div class="picker-tree picker-drive" role="tree" aria-label="Google Drive">${driveRowHtml('','Google Drive','Chrome·Edge에서만 사용')}</div>`;
  if(!driveState.handle)return `<div class="picker-tree picker-drive" role="tree" aria-label="Google Drive"><div class="picker-row picker-drive-row"><span class="picker-toggle-spacer" aria-hidden="true"></span><button type="button" class="picker-link" data-action="picker-drive-setup"><span class="drive-folder-icon" aria-hidden="true"></span><span class="picker-name">Google Drive</span><span class="picker-note">폴더 지정 필요 · 눌러서 지정</span></button></div></div>`;
  return `<div class="picker-tree picker-drive" role="tree" aria-label="Google Drive">${driveRowHtml('',`Google Drive · ${driveState.name}`)}</div><p class="picker-hint">Google Drive를 고르면 포털 자료는 그대로 두고 그 폴더에 복사합니다.</p>`;
}
async function driveResolve(path){
  let directory=await driveTarget();if(!directory)return null;
  for(const part of path.split('/').filter(Boolean))directory=await directory.getDirectoryHandle(part);
  return directory;
}
async function drivePickerToggle(button){
  const group=button.closest('.picker-row')?.nextElementSibling;if(!group)return;
  const open=group.hidden;
  if(open&&!group.dataset.loaded){
    const directory=await driveResolve(button.dataset.drivePath);if(!directory)return;
    const names=[];for await(const [name,handle] of directory.entries())if(handle.kind==='directory'&&!name.startsWith('.'))names.push(name);
    names.sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}));
    const base=button.dataset.drivePath;
    group.innerHTML=names.length?names.map(name=>driveRowHtml(base?`${base}/${name}`:name,name)).join(''):'<p class="picker-empty">하위 폴더가 없습니다.</p>';
    group.dataset.loaded='1';
  }
  group.hidden=!open;button.setAttribute('aria-expanded',String(open));
}
function pickerLabel(value){
  if(value.startsWith('drive:')){const path=value.slice(6);return ['Google Drive',driveState.name,...path.split('/').filter(Boolean)].join(' / ');}
  if(value==='root')return '전체 자료';
  const folders=features.pickerFolders??[],byId=new Map(folders.map(folder=>[folder.id,folder]));
  return libraryFolderPath(byId.get(Number(value)),byId);
}
function folderPickerAction(action,button){
  if(action==='picker-toggle'){const group=button.closest('.picker-row')?.nextElementSibling;if(!group?.classList.contains('picker-children'))return true;const open=group.hidden;group.hidden=!open;button.setAttribute('aria-expanded',String(open));return true;}
  const picker=button.closest('.folder-picker');if(!picker||button.getAttribute('aria-disabled')==='true')return true;
  picker.querySelector('input[type="hidden"]').value=button.dataset.pickerValue;
  picker.querySelectorAll('.picker-row.selected').forEach(row=>{row.classList.remove('selected');row.querySelector('.picker-link')?.setAttribute('aria-selected','false');});
  button.closest('.picker-row').classList.add('selected');button.setAttribute('aria-selected','true');
  picker.querySelector('.picker-selected strong').textContent=pickerLabel(button.dataset.pickerValue)||button.dataset.pickerLabel;
  // Google Drive를 고르면 확인 버튼을 '복사'로 바꿔 포털 자료가 유지됨을 알린다.
  const submit=picker.closest('form')?.querySelector('button.primary');
  if(submit){submit.dataset.label??=submit.textContent;submit.textContent=button.dataset.pickerValue.startsWith('drive:')?'Drive로 복사':submit.dataset.label;}
  return true;
}
async function folderMoveDialog(id){
 const library=await api('/library');
 const folders=library.tree,byId=new Map(folders.map(folder=>[folder.id,folder]));
 const selected=byId.get(Number(id));
 if(!selected)throw new Error('폴더를 찾을 수 없습니다.');
 const blocked=new Set([selected.id]);
 for(let changed=true;changed;){changed=false;for(const folder of folders)if(blocked.has(folder.parent_id)&&!blocked.has(folder.id)){blocked.add(folder.id);changed=true;}}
 features.pickerFolders=folders;
 openDialog('폴더 이동',`<form id="folder-move-form" data-id="${selected.id}"><p><strong>${esc(selected.name)}</strong> 및 그 안의 자료와 하위 폴더를 함께 이동합니다.</p><p class="help-line">현재 위치: ${esc(selected.parent_id?libraryFolderPath(byId.get(selected.parent_id),byId):'전체 자료')}</p><div class="picker-label">이동할 위치 *</div>${folderPickerHtml({name:'parent_id',folders,disabled:new Map([[selected.id,'이동할 폴더'],...(selected.parent_id!=null?[[selected.parent_id,'현재 위치']]:[])]),hideChildrenOf:new Set([selected.id]),rootDisabled:selected.parent_id==null?'현재 위치':'',drive:true})}<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">이동</button></div></form>`);
}
async function manualEditDialog(id){
 const {file}=await api('/manuals/'+id);
 const tree=features.libraryTree??[],byId=new Map(tree.map(folder=>[folder.id,folder]));
 features.pickerFolders=tree;
 openDialog('자료 수정',`<form id="manual-edit-form" data-id="${file.id}">${input('name','자료명 *',file.name,'required maxlength="240"')}<p class="help-line">파일 확장자는 유지해 주세요.</p><div class="picker-label">소속 폴더</div>${folderPickerHtml({name:'folder_id',folders:tree,value:file.folder_id==null?'root':String(file.folder_id)})}<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);
}
async function manualMoveDialog(id){
 const [{file},library]=await Promise.all([api('/manuals/'+id),api('/library')]);
 const byId=new Map(library.tree.map(folder=>[folder.id,folder]));
 const destinations=library.tree.filter(folder=>folder.id!==file.folder_id);
 const current=byId.get(file.folder_id);
 const currentPath=current?libraryFolderPath(current,byId):'전체 자료';
 const rootOption=file.folder_id==null?'':'root';
 features.pickerFolders=library.tree;
 openDialog('자료 이동',`<form id="manual-move-form" data-id="${file.id}"><p><strong>${esc(file.name)}</strong></p><p class="help-line">현재 위치: ${esc(currentPath)}</p><div class="picker-label">이동할 위치 *</div>${folderPickerHtml({name:'folder_id',folders:library.tree,disabled:file.folder_id!=null?new Map([[file.folder_id,'현재 위치']]):new Map(),rootDisabled:file.folder_id==null?'현재 위치':'',drive:true})}${destinations.length||rootOption?'':'<p class="help-line">이동할 폴더가 없습니다. 새 폴더를 먼저 만들어 주세요.</p>'}<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary" ${destinations.length||rootOption?'':'disabled'}>이동</button></div></form>`);
}
function backupSize(bytes){return bytes>=1073741824?(bytes/1073741824).toFixed(2)+' GB':bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':(bytes/1024).toFixed(1)+' KB';}
async function renderBackups(){
 const result=await api('/backups');if(state.view!=='backups')return;
 state.backups=result.backups;
 const actions='<div class="head-actions"><button class="primary" data-action="backup-create">＋ 지금 백업</button><button data-action="backup-restore" '+(state.backups.length?'':'disabled')+'>복구</button></div>';
 document.querySelector('#content').innerHTML=pageHead('BACKUP & RESTORE','백업/복구','포털 자료 전체의 백업을 만들고 이전 시점으로 복구하세요.',actions)+`<section class="panel"><div class="panel-head"><h2>저장된 백업 <small>${state.backups.length}개</small></h2></div>${state.backups.length?`<div class="table-wrap"><table><thead><tr><th>백업 시점</th><th>파일 이름</th><th>크기</th><th>받기</th></tr></thead><tbody>${state.backups.map(row=>`<tr><td>${fmt(row.created_at)}</td><td>${esc(row.name)}</td><td>${backupSize(row.size)}</td><td><a href="/api/backups/${encodeURIComponent(row.name)}/download" download="${esc(row.name)}">다운로드</a></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><h3>저장된 백업이 없습니다</h3><p>지금 백업을 눌러 첫 백업을 만드세요.</p></div>'}</section><p class="help-line">백업에는 계정·설치·자료·자산·업무일지와 첨부파일이 포함됩니다. 목록은 이 PC의 backups 폴더에 저장된 파일입니다. 복구하면 선택한 시점 이후의 변경 사항이 되돌아가고, 복구 직전 상태는 별도 백업으로 남습니다.</p>`;
 document.querySelector('#content').insertAdjacentHTML('beforeend','<p class="help-line">백업은 생성 시점부터 7일간 보관한 뒤 자동 삭제됩니다. 복구 직전 백업도 같은 기준을 적용합니다.</p>');
}
function backupRestoreDialog(){
 openDialog('백업 시점 복구',`<form id="backup-restore-form"><label>복구할 백업 *<select name="name" required><option value="">백업을 선택하세요</option>${state.backups.map(row=>`<option value="${esc(row.name)}">${fmt(row.created_at)} · ${esc(row.name)} · ${backupSize(row.size)}</option>`).join('')}</select></label><p class="help-line">선택한 시점 이후 변경 사항은 되돌아갑니다. 복구 직전 상태를 새 백업으로 저장한 뒤 서비스를 다시 연결합니다. 복구 후 다시 로그인해야 할 수 있습니다.</p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="danger">선택한 시점으로 복구</button></div></form>`);
}
async function waitForRestore(restoreId,previousInstance){
 document.querySelector('#content').innerHTML=pageHead('RESTORE IN PROGRESS','복구 진행 중','백업을 적용하고 포털을 다시 연결하고 있습니다.')+'<section class="panel"><div class="empty" role="status"><h3>복구 중입니다</h3><p>이 화면을 닫지 말고 잠시 기다려 주세요. 백업 파일이 클수록 시간이 걸립니다.</p></div></section>';
 const deadline=Date.now()+15*60*1000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,1500));
  try{
   const response=await fetch('/api/health',{cache:'no-store'});
   if(!response.ok)continue;
   const health=await response.json();
   if(health.instance_id===previousInstance)continue;
   if(health.restore_result?.id!==restoreId)throw new Error('포털이 다시 시작됐지만 복구 결과를 확인할 수 없습니다. 운영 기록을 확인해 주세요.');
   if(!health.restore_result.ok)throw new Error('복구에 실패해 이전 상태로 되돌렸습니다. 운영 기록을 확인해 주세요.');
   location.reload();return;
  }catch(error){if(error instanceof TypeError)continue;throw error;}
 }
 throw new Error('복구 완료를 확인하지 못했습니다. 포털을 새로고침하고 운영 기록을 확인해 주세요.');
}
async function previewDialog(id){
 const {file:f}=await api('/manuals/'+id);const url='/api/manuals/'+f.id+'/preview';
 openDialog(f.name,`<div class="preview-toolbar"><span>${fileSize(f.size)} · ${fmt(f.created_at)}</span><a href="/api/manuals/${f.id}/download">다운로드</a></div>${f.preview_type?.startsWith('image/')?`<div class="image-preview"><img src="${url}" alt="${esc(f.name)}"></div>`:f.preview_type==='application/pdf'?'<div class="pdf-controls"><button class="small" data-action="pdf-prev">이전 페이지</button><span id="pdf-page-label">불러오는 중</span><button class="small" data-action="pdf-next">다음 페이지</button></div><div id="pdf-surface" class="pdf-surface"></div>':f.preview_type?`<iframe class="document-preview" src="${url}" title="${esc(f.name)} 미리보기" sandbox></iframe><p class="help-line">브라우저에서 미리보기가 표시되지 않으면 다운로드로 확인해 주세요.</p>`:'<div class="empty"><h3>이 형식은 미리보기를 지원하지 않습니다</h3><p>다운로드하여 해당 프로그램에서 열어 주세요.</p></div>'}`);modal.classList.add('preview-dialog');
 if(f.preview_type==='application/pdf')await loadPdf(url);
}
function renderSettings(){
 const dark=document.documentElement.dataset.theme==='dark';
 document.querySelector('#content').innerHTML=pageHead('PREFERENCES','설정','작업 환경과 계정 설정을 관리하세요.')+`${state.user.role==='admin'?`<section class="panel settings-panel"><div class="panel-head"><h2>관리자 메뉴</h2><small>관리자 계정에만 표시됩니다.</small></div><div class="settings-admin-links"><button class="settings-admin-link" data-view="users"><strong>사용자 관리</strong><small>계정 추가·수정·비활성화, 권한과 비밀번호 재설정</small></button><button class="settings-admin-link" data-view="backups"><strong>백업/복구</strong><small>온라인 백업 생성·다운로드, 선택한 시점으로 복구</small></button></div></section>`:''}<section class="panel settings-panel"><div class="panel-head"><h2>화면 모드</h2><small>이 브라우저에 저장됩니다.</small></div><div class="theme-options"><button class="theme-option ${!dark?'selected':''}" data-action="theme" data-mode="light" aria-pressed="${!dark}"><span class="theme-swatch light-swatch">Aa</span><strong>일반 모드</strong><small>밝은 배경의 기본 화면</small></button><button class="theme-option ${dark?'selected':''}" data-action="theme" data-mode="dark" aria-pressed="${dark}"><span class="theme-swatch dark-swatch">Aa</span><strong>다크 모드</strong><small>눈부심이 적은 어두운 화면</small></button></div></section><section class="panel settings-panel"><div class="panel-head"><h2>내 계정</h2></div><div class="settings-account"><div><strong>${esc(state.user.name)}</strong><p class="muted">${esc(state.user.email)} · ${labels[state.user.role]}</p></div><button data-action="password">비밀번호 변경</button></div></section>`;
 document.querySelector('#content .theme-options').closest('.settings-panel').insertAdjacentHTML('afterend','<section class="panel settings-panel"><div class="panel-head"><h2>메뉴 순서 편집</h2><small>왼쪽 메뉴 순서 · 이 브라우저에 저장됩니다.</small></div><div id="settings-menu-order" class="settings-menu-order"></div></section>');
 renderSettingsMenu();
}
async function featureAction(action,id,button){
 switch(action){
 case 'new-installation':case 'installation':await installationDialog(id);return true;
 case 'reset-installations':features.installationFilters={};features.installationPage=1;await renderInstallations();return true;
 case 'installation-prev':case 'installation-next':features.installationPage+=action.endsWith('prev')?-1:1;await renderInstallations();return true;
 case 'folder-toggle':{
  const folderId=Number(id),children=document.getElementById('folder-children-'+folderId);
  if(!children)return true;
  const expanded=!features.expandedFolders.has(folderId);
  if(expanded)features.expandedFolders.add(folderId);else features.expandedFolders.delete(folderId);
  children.hidden=!expanded;
  button.setAttribute('aria-expanded',String(expanded));
  button.setAttribute('aria-label',button.dataset.name+' '+(expanded?'접기':'펼치기'));
  return true;
 }
 case 'folder':features.folder=id?Number(id):null;features.libraryPage=1;features.libraryQuery='';await renderLibrary();return true;
 case 'library-prev':case 'library-next':features.libraryPage+=action.endsWith('prev')?-1:1;await renderLibrary();return true;
 case 'new-folder':{const parentValue=button.dataset.parentId===undefined?features.folder:button.dataset.parentId;const parent=parentValue?Number(parentValue):null;const parentFolder=features.libraryTree?.find(folder=>folder.id===parent);openDialog('폴더 생성',`<form id="folder-form" data-parent-id="${parent??''}">${input('name','폴더명 *','','required maxlength="100"')}<p class="help-line">생성 위치: ${esc(parentFolder?.name??'전체 자료')}</p><div class="form-actions"><button class="primary">폴더 생성</button></div></form>`);return true;}
 case 'picker-toggle':case 'picker-select':return folderPickerAction(action,button);
 case 'picker-drive-toggle':await drivePickerToggle(button);return true;
 case 'picker-drive-setup':{const handle=await pickDriveFolder();if(handle){const section=button.closest('.picker-drive');section.outerHTML=driveSectionHtml();}return true;}
 case 'drive-settings':{const handle=await pickDriveFolder();if(handle){toast(`Google Drive 복사 폴더를 '${handle.name}'(으)로 지정했습니다.`);await renderLibrary();}return true;}
 case 'drive-file':await driveSendFile(id);return true;
 case 'drive-folder':await driveSendFolder(id);return true;
 case 'upload-folder':features.uploadTarget=button.dataset.targetId===undefined?undefined:(button.dataset.targetId?Number(button.dataset.targetId):null);document.querySelector('#library-folder-picker')?.click();return true;
 case 'download-manual':{const link=document.createElement('a');link.href='/api/manuals/'+id+'/download';document.body.append(link);link.click();link.remove();return true;}
 case 'upload-manual':if(button.dataset.targetId!==undefined){const target=button.dataset.targetId?Number(button.dataset.targetId):null;if(target!==features.folder){features.folder=target;features.libraryPage=1;features.libraryQuery='';await renderLibrary();}}openDialog('자료 등록','<form id="manual-form"><label>등록할 파일<input name="file" type="file" required></label><p class="help-line">현재 위치에 등록됩니다. 파일 크기 제한은 없습니다.</p><div class="form-actions"><button class="primary">자료 등록</button></div></form>');return true;
 case 'rename-folder':{
  const folder=features.libraryTree.find(folder=>folder.id===Number(id));
  if(!folder)throw new Error('분류를 다시 선택해 주세요.');
  openDialog('폴더 이름 변경',`<form id="folder-edit-form" data-id="${folder.id}">${input('name','폴더명 *',folder.name,'required maxlength="100"')}<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);return true;
 }
 case 'move-folder':await folderMoveDialog(id);return true;
 case 'edit-manual':await manualEditDialog(id);return true;
 case 'move-manual':await manualMoveDialog(id);return true;
 case 'preview':await previewDialog(id);return true;
 case 'pdf-prev':case 'pdf-next':pdfPage+=action==='pdf-prev'?-1:1;await renderPdfPage();return true;
 case 'delete-folder':if(confirm('비어 있는 폴더를 삭제할까요?')){await api('/folders/'+id,{method:'DELETE'});await renderLibrary();toast('폴더를 삭제했습니다.');}return true;
 case 'delete-manual':if(confirm('자료를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/manuals/'+id,{method:'DELETE'});await renderLibrary();toast('자료를 삭제했습니다.');}return true;
 case 'installation-delete-file':if(confirm('첨부자료를 삭제할까요?')){await api('/installation-files/'+id,{method:'DELETE'});await installationDialog(features.installation.id);await renderView();toast('첨부자료를 삭제했습니다.');}return true;
 case 'installation-delete':if(confirm('이 설치 정보와 첨부자료를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/installations/'+id,{method:'DELETE'});if(modal.open)modal.close();await renderView();await refreshCount();toast('설치 정보를 삭제했습니다.');}return true;
 case 'theme':applyTheme(button.dataset.mode);renderSettings();return true;
 default:return false;
 }
}
async function featureSubmit(form,values){
 switch(form.id){
 case 'installation-filter':if(values.from&&values.to&&values.from>values.to)throw new Error('종료일은 시작일 이후로 설정해 주세요.');features.installationFilters=Object.fromEntries(Object.entries(values).filter(([,v])=>v));features.installationPage=1;await renderInstallations();return true;
 case 'installation-form':{const wasNew=!features.installation.id;values.version=features.installation.version;values.category_id=features.installation.category_id??null;const saved=await api('/installations'+(wasNew?'':'/'+features.installation.id),{method:wasNew?'POST':'PUT',body:values});await renderView();if(wasNew){await installationDialog(saved.installation.id);const status=modal.querySelector('.save-status');if(status)status.textContent='설치 정보가 저장되었습니다. 이제 첨부자료를 등록할 수 있습니다.';}else{modal.close();toast('설치 정보를 저장했습니다.');}}return true;
 case 'folder-edit-form':await api('/folders/'+form.dataset.id,{method:'PUT',body:{name:values.name}});modal.close();features.libraryQuery='';features.libraryPage=1;await renderLibrary();toast('폴더 이름을 변경했습니다.');return true;
 case 'folder-move-form':if(!values.parent_id)throw new Error('이동할 위치를 선택해 주세요.');if(values.parent_id.startsWith('drive:')){const directory=await driveResolve(values.parent_id.slice(6));if(!directory)return true;modal.close();await driveSendFolder(form.dataset.id,directory,pickerLabel(values.parent_id));return true;}await api('/folders/'+form.dataset.id+'/move',{method:'PUT',body:{parent_id:values.parent_id==='root'?null:Number(values.parent_id)}});features.folder=Number(form.dataset.id);features.libraryPage=1;features.libraryQuery='';modal.close();await renderLibrary();toast('폴더를 이동했습니다.');return true;
 case 'manual-edit-form':{const folderId=values.folder_id&&values.folder_id!=='root'?values.folder_id:null;await api('/manuals/'+form.dataset.id,{method:'PUT',body:{name:values.name,folder_id:folderId}});features.folder=folderId?Number(folderId):null;features.libraryPage=1;features.libraryQuery='';modal.close();await renderLibrary();toast('자료 정보를 수정했습니다.');return true;}
 case 'manual-move-form':if(!values.folder_id)throw new Error('이동할 위치를 선택해 주세요.');if(values.folder_id.startsWith('drive:')){const directory=await driveResolve(values.folder_id.slice(6));if(!directory)return true;const {file}=await api('/manuals/'+form.dataset.id),counts={copied:0,skipped:0};modal.close();toast(`Google Drive로 복사 중 · ${file.name}`);await driveCopyFile(directory,file,counts);toast(counts.skipped?`'${pickerLabel(values.folder_id)}'에 같은 파일이 있어 건너뛰었습니다.`:`'${pickerLabel(values.folder_id)}'에 ${file.name}을(를) 복사했습니다. 포털 자료는 그대로 있습니다.`);return true;}await api('/manuals/'+form.dataset.id,{method:'PUT',body:{folder_id:values.folder_id==='root'?null:values.folder_id}});features.folder=values.folder_id==='root'?null:Number(values.folder_id);features.libraryPage=1;features.libraryQuery='';modal.close();await renderLibrary();toast('자료를 이동했습니다.');return true;
 case 'folder-form':{const parent=form.dataset.parentId?Number(form.dataset.parentId):null,created=await api('/folders',{method:'POST',body:{...values,parent_id:parent}});if(parent!=null)features.expandedFolders.add(parent);features.folder=created.id;features.libraryPage=1;features.libraryQuery='';modal.close();await renderLibrary();toast('폴더를 만들었습니다.');}return true;
 case 'manual-form':await api('/manuals?'+new URLSearchParams({folder:features.folder??''}),{method:'POST',body:new FormData(form)});modal.close();await renderLibrary();toast('자료를 등록했습니다.');return true;
 case 'installation-upload':{const file=form.elements.file.files[0];await api('/installations/'+features.installation.id+'/files',{method:'POST',body:new FormData(form)});await installationDialog(features.installation.id);await renderView();toast('첨부자료를 등록했습니다.');}return true;
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
