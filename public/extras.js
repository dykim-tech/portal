export function createExtras(ctx) {
  const { api, esc, state, features, canEdit, openDialog, input, toast, fmt, pageHead, renderItems, renderInstallations, renderView, modal, listingQuery, decorateListing } = ctx;
  const cache = { items: [], installations: [] };
  const work = { customer: null, customers: [], page: 1, filters: {}, selected: null, selectedCustomer: null };
  const todo = { items: [], today: '', todayOpen: 0 };
  const todoSaves = new WeakMap();
  const todoSizeKey=id=>`portal-todo-size-${state.user.id}-${id}`;
  // 메모 크기는 이 브라우저에 기억한다. 보안 정책(CSP)상 style 속성 대신 스크립트로 적용한다.
  function todoSize(id){try{const value=JSON.parse(localStorage.getItem(todoSizeKey(id)));if(value&&value.width>=250&&value.width<=900&&value.height>=205&&value.height<=900)return value;}catch{}return null;}
  function rememberTodoSize(card){if(!card.isConnected)return;const {width,height}=card.getBoundingClientRect();try{localStorage.setItem(todoSizeKey(card.dataset.todoId),JSON.stringify({width:Math.round(width),height:Math.round(height)}));}catch{}fitTodoBoard();}
  const lockIcon='<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false"><rect x="4" y="9" width="12" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.8 9V6.6a3.2 3.2 0 0 1 6.4 0V9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  // ---- 메모 자유 배치: 메모 보드 안에서 끌어 원하는 위치에 놓는다(위치는 서버에 저장). 좁은 화면에서는 세로로 쌓는다.
  const TODO_GAP=15;let todoTop=10,todoDrag=null;
  const freeBoard=()=>!matchMedia('(max-width:720px)').matches;
  function fitTodoBoard(){const grid=document.querySelector('#todo-grid');if(!grid?.classList.contains('free'))return;let bottom=0;for(const card of grid.querySelectorAll('.todo-note'))bottom=Math.max(bottom,card.offsetTop+card.offsetHeight);grid.style.height=Math.max(320,bottom+40)+'px';}
  function layoutTodoBoard(){
    const grid=document.querySelector('#todo-grid');if(!grid)return;
    const cards=[...grid.querySelectorAll('.todo-note')];
    if(!freeBoard()){grid.classList.remove('free');grid.style.height='';for(const card of cards){card.style.left='';card.style.top='';card.style.width='';card.style.height='';}return;}
    for(const card of cards){const size=todoSize(card.dataset.todoId);if(size){card.style.width=size.width+'px';card.style.height=size.height+'px';}}
    grid.classList.add('free');
    const width=Math.max(grid.clientWidth,300),placed=[],free=[];
    const overlaps=(x,y,w,h)=>placed.some(r=>x<r.x+r.w+TODO_GAP&&x+w+TODO_GAP>r.x&&y<r.y+r.h+TODO_GAP&&y+h+TODO_GAP>r.y);
    for(const card of cards){const row=todo.items.find(item=>item.id===Number(card.dataset.todoId));if(row&&row.pos_x!==null&&row.pos_x!==undefined&&row.pos_y!==null&&row.pos_y!==undefined){card.style.left=row.pos_x+'px';card.style.top=row.pos_y+'px';placed.push({x:row.pos_x,y:row.pos_y,w:card.offsetWidth,h:card.offsetHeight});}else free.push(card);}
    // 위치를 정한 적 없는 메모는 왼쪽 위부터 빈 자리에 차례로 놓는다.
    for(const card of free){const w=card.offsetWidth,h=card.offsetHeight;let spot=null;for(let y=0;!spot&&y<20000;y+=20)for(let x=0;x+w<=width||x===0;x+=20){if(!overlaps(x,y,w,h)){spot={x,y};break;}if(x+w>width)break;}spot??={x:0,y:0};card.style.left=spot.x+'px';card.style.top=spot.y+'px';placed.push({...spot,w,h});}
    fitTodoBoard();
  }
  function todoDragStart(event){
    if(event.button!==0||!freeBoard())return false;
    const card=event.target.closest?.('#todo-grid.free .todo-note');if(!card)return false;
    if(card.style.zIndex!==String(todoTop))card.style.zIndex=String(++todoTop); // 누른 메모를 맨 앞으로
    if(event.target.closest('input,textarea,button,a,label,select,.note-files'))return false;
    const box=card.getBoundingClientRect();
    if(event.target===card&&event.clientX>box.right-20&&event.clientY>box.bottom-20)return false; // 오른쪽 아래 크기 조절 손잡이
    if(!event.target.closest('.todo-note-top,.todo-note-bottom,.todo-locked')&&event.target!==card)return false;
    event.preventDefault();
    todoDrag={card,id:Number(card.dataset.todoId),startX:event.clientX,startY:event.clientY,left:card.offsetLeft,top:card.offsetTop,moved:false,pointer:event.pointerId};
    card.classList.add('dragging');card.setPointerCapture?.(event.pointerId);
    return true;
  }
  function todoDragMove(event){
    if(!todoDrag||event.pointerId!==todoDrag.pointer)return false;
    const {card}=todoDrag,grid=card.parentElement,dx=event.clientX-todoDrag.startX,dy=event.clientY-todoDrag.startY;
    if(!todoDrag.moved&&Math.abs(dx)+Math.abs(dy)<4)return true;
    todoDrag.moved=true;
    const x=Math.min(Math.max(0,todoDrag.left+dx),Math.max(0,grid.clientWidth-card.offsetWidth)),y=Math.max(0,todoDrag.top+dy);
    card.style.left=Math.round(x)+'px';card.style.top=Math.round(y)+'px';
    if(card.offsetTop+card.offsetHeight+40>grid.offsetHeight)grid.style.height=(card.offsetTop+card.offsetHeight+40)+'px';
    return true;
  }
  async function todoDragEnd(event){
    if(!todoDrag||event.pointerId!==todoDrag.pointer)return false;
    const {card,id,moved}=todoDrag;todoDrag=null;card.classList.remove('dragging');
    if(!moved)return true;
    const x=card.offsetLeft,y=card.offsetTop,row=todo.items.find(item=>item.id===id);
    await api(`/todos/${id}/position`,{method:'PUT',body:{x,y}});
    if(row){row.pos_x=x;row.pos_y=y;}
    fitTodoBoard();return true;
  }
  const report = { from: '', to: '' };
  const levelNames = ['대분류', '중분류', '소분류'];
  const workStatus = { planned: '예정', progress: '진행 중', done: '완료', hold: '보류' };
  const workTypes = { regular: '정기점검', incident: '장애지원', installation: '설치', per_call: 'Per Call', other: '기타' };
  const workModes = { remote: '원격', visit: '방문', other: '기타' };

  async function loadCategories(scope) {
    const result = await api('/categories?scope=' + encodeURIComponent(scope));
    cache[scope] = result.categories;
    return result.categories;
  }
  function categoryPath(scope, id) {
    if (!id) return '미분류';
    const byId = new Map(cache[scope].map(row => [row.id, row]));
    let row = byId.get(Number(id));
    if (!row) return '미분류';
    const parts = [];
    while (row) { parts.unshift(row.name); row = row.parent_id ? byId.get(row.parent_id) : null; }
    return parts.join(' / ');
  }
  function leafSelect(scope, selected, required = false) {
    const rows = cache[scope].filter(row => row.level === 3);
    return `<label class="full">소분류 ${required ? '*' : ''}<select name="category_id" ${required ? 'required' : ''}><option value="">${required ? '소분류를 선택하세요' : '미분류 (기존 자료)'}</option>${rows.map(row => `<option value="${row.id}" ${Number(selected) === row.id ? 'selected' : ''}>${esc(categoryPath(scope, row.id))}</option>`).join('')}</select></label>`;
  }
  function selectedCategory(scope) {
    const value = scope === 'items' ? state.filters.category_id : features.installationFilters.category_id;
    return cache[scope].find(row => row.id === Number(value)) ?? null;
  }
  function categoryPanel(scope) {
    const selected = selectedCategory(scope);
    const title = scope === 'items' ? '자산 분류' : '설치 분류';
    const tree = cache[scope];
    function branch(parent, depth) {
      return tree.filter(row => row.parent_id === parent).map(row =>
        `<button class="category-link ${selected?.id === row.id ? 'selected' : ''}" style="padding-left:${14 + depth * 16}px" data-action="category-select" data-scope="${scope}" data-id="${row.id}"><span class="category-level">${levelNames[depth]}</span>${esc(row.name)}</button>${branch(row.id, depth + 1)}`
      ).join('');
    }
    return `<aside class="classified-sidebar"><div class="category-title">${title}</div><button class="category-link ${!selected ? 'selected' : ''}" data-action="category-select" data-scope="${scope}">전체 보기</button>${branch(null, 0) || '<p class="category-empty">아직 분류가 없습니다.</p>'}${canEdit() ? `<div class="category-actions"><button class="small" data-action="category-new" data-scope="${scope}">＋ 대분류</button>${selected && selected.level < 3 ? `<button class="small" data-action="category-child" data-scope="${scope}" data-id="${selected.id}">＋ ${levelNames[selected.level]}</button>` : ''}${selected ? `<button class="small" data-action="category-rename" data-scope="${scope}" data-id="${selected.id}">이름 변경</button><button class="small danger" data-action="category-delete" data-scope="${scope}" data-id="${selected.id}">분류 삭제</button>` : ''}</div>` : ''}</aside>`;
  }
  function attachCategoryPanel(scope) {
    const section = document.querySelector('#content section.panel');
    if (!section) return;
    const main = document.createElement('div');
    main.className = 'classified-main';
    while (section.firstChild) main.appendChild(section.firstChild);
    section.classList.add('classified-panel');
    section.insertAdjacentHTML('afterbegin', categoryPanel(scope));
    section.appendChild(main);
  }
  async function categoryDialog(scope, parentId = null, existing = null) {
    const parent = parentId ? cache[scope].find(row => row.id === Number(parentId)) : null;
    const label = existing ? '분류 이름 변경' : levelNames[parent ? parent.level : 0] + ' 만들기';
    openDialog(label, `<form id="category-form" data-scope="${scope}" data-id="${existing?.id ?? ''}"><input type="hidden" name="parent_id" value="${parent?.id ?? ''}">${input('name', '분류명 *', existing?.name ?? '', 'required maxlength="100"')}<p class="help-line">${parent ? esc(categoryPath(scope, parent.id)) + ' 아래에 등록합니다.' : '이 메뉴의 최상위 분류로 등록합니다.'}</p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);
  }
  function todoCard(row){
    const memo=[row.title,row.body].filter(Boolean).join('\n');
    if(row.locked)return `<article class="todo-note locked ${row.done?'completed':''}" data-todo-id="${row.id}"><div class="todo-note-top"><label class="todo-check"><input type="checkbox" data-todo-toggle="${row.id}" ${row.done?'checked':''}><span>${row.done?'완료':'할 일'}</span></label><span class="todo-note-date">${esc(row.target_date)}</span></div><div class="todo-locked" title="비밀번호를 입력하면 잠금이 풀리고 내용이 보입니다."><span class="todo-lock-badge">${lockIcon}</span><strong>잠긴 메모</strong></div><div class="todo-note-bottom"><small class="todo-save-status">잠김</small><span class="todo-note-actions"><button type="button" class="todo-lock-button" data-action="todo-unlock" data-id="${row.id}">${lockIcon}잠금 해제</button><button type="button" class="danger" data-action="todo-delete" data-id="${row.id}">삭제</button></span></div></article>`;
    return `<article class="todo-note ${row.done?'completed':''}" data-todo-id="${row.id}"><div class="todo-note-top"><label class="todo-check"><input type="checkbox" data-todo-toggle="${row.id}" ${row.done?'checked':''}><span>${row.done?'완료':'할 일'}</span></label><input type="date" class="todo-note-date" data-todo-field="target_date" aria-label="메모 날짜" value="${esc(row.target_date)}"></div><textarea class="todo-note-body" data-todo-field="body" aria-label="메모 내용" placeholder="여기에 바로 메모하세요" maxlength="6000">${esc(memo)}</textarea><div class="note-files">${(row.files??[]).map(file=>`<div><a href="/api/todo-files/${file.id}/download">${esc(file.name)}</a><button type="button" class="small danger" data-action="todo-file-delete" data-id="${file.id}" aria-label="${esc(file.name)} 삭제">×</button></div>`).join('')}</div><div class="todo-note-bottom"><small class="todo-save-status" aria-live="polite" title="자동 저장 · 파일을 끌어 놓아 첨부">자동 저장 · 파일을 끌어 놓아 첨부</small><span class="todo-note-actions"><button type="button" class="todo-lock-button" data-action="todo-lock" data-id="${row.id}" title="메모 잠금" aria-label="메모 잠금">${lockIcon}잠금</button><button type="button" class="danger" data-action="todo-delete" data-id="${row.id}">삭제</button></span></div></article>`;
  }
  const todoMemo=row=>[row.title,row.body].filter(Boolean).join('\n');
  function doneNote(row,index){
    const memo=row.locked?'🔒 잠긴 메모':todoMemo(row),preview=memo.trim().slice(0,74);
    return `<button type="button" class="done-note done-note-${index%4}" data-action="todo-open-done" data-id="${row.id}" aria-label="완료한 메모 열기: ${esc(preview||'내용 없음')}"><span class="done-note-pin" aria-hidden="true"></span><span class="done-note-date">${esc(row.target_date)}</span><span class="done-note-text">${esc(preview||'내용 없는 메모')}</span>${(row.files??[]).length?`<span class="done-note-files">첨부 ${(row.files??[]).length}개</span>`:''}</button>`;
  }
  function openDoneNote(id){
    const row=todo.items.find(item=>item.id===Number(id)&&item.done);
    if(!row)throw new Error('완료한 메모를 찾을 수 없습니다.');
    if(row.locked){openDialog('완료한 메모',`<div class="todo-expanded"><div class="todo-expanded-date">${esc(row.target_date)} · 완료 · 잠김</div><div class="todo-expanded-text todo-expanded-locked">${lockIcon} 잠긴 메모입니다. 잠금을 해제하면 내용이 보입니다.</div><div class="form-actions"><button type="button" data-action="todo-unlock" data-id="${row.id}">잠금 해제</button><button type="button" data-action="todo-restore" data-id="${row.id}">다시 할 일로</button><button type="button" class="danger" data-action="todo-delete" data-id="${row.id}">삭제</button></div></div>`);return;}
    const files=(row.files??[]).map(file=>`<a href="/api/todo-files/${file.id}/download">${esc(file.name)}</a>`).join('');
    openDialog('완료한 메모',`<div class="todo-expanded"><div class="todo-expanded-date">${esc(row.target_date)} · 완료</div><div class="todo-expanded-text">${esc(todoMemo(row))||'내용 없는 메모'}</div>${files?`<div class="todo-expanded-files"><strong>첨부파일</strong>${files}</div>`:''}<div class="form-actions"><button type="button" data-action="todo-restore" data-id="${row.id}">다시 할 일로</button><button type="button" class="danger" data-action="todo-delete" data-id="${row.id}">삭제</button></div></div>`);
  }
  function todoSaveState(card){
    let entry=todoSaves.get(card);
    if(!entry){entry={revision:0,savedRevision:0,timer:null,saving:null};todoSaves.set(card,entry);}
    return entry;
  }
  function todoValues(card){return {title:'',body:card.querySelector('[data-todo-field="body"]').value,target_date:card.querySelector('[data-todo-field="target_date"]').value};}
  function scheduleTodoSave(card,delay=700){
    const entry=todoSaveState(card);
    clearTimeout(entry.timer);
    entry.timer=setTimeout(()=>flushTodoCard(card).catch(error=>toast(error.message)),delay);
  }
  function todoInput(target){
    const card=target.closest?.('.todo-note');
    if(!card||!target.matches('[data-todo-field]'))return false;
    todoSaveState(card).revision++;
    card.querySelector('.todo-save-status').textContent='저장 대기…';
    scheduleTodoSave(card);
    return true;
  }
  async function flushTodoCard(card){
    const entry=todoSaveState(card);
    clearTimeout(entry.timer);entry.timer=null;
    if(entry.saving){await entry.saving;if(entry.revision>entry.savedRevision)return flushTodoCard(card);return;}
    if(entry.revision<=entry.savedRevision)return;
    const revision=entry.revision,id=Number(card.dataset.todoId),values=todoValues(card),status=card.querySelector('.todo-save-status');
    status.textContent='저장 중…';
    entry.saving=(async()=>{
      try{
        const result=await api('/todos/'+id,{method:'PUT',body:values});
        const previous=todo.items.find(item=>item.id===id);
        if(previous){
          if(!previous.done&&previous.target_date===todo.today)todo.todayOpen--;
          Object.assign(previous,result.todo);
          if(!previous.done&&previous.target_date===todo.today)todo.todayOpen++;
          const count=document.querySelector('#todo-today-count');if(count)count.textContent=`오늘 ${todo.todayOpen}건`;
        }
        entry.savedRevision=revision;status.textContent='저장됨';
      }catch(error){status.textContent='저장 실패 · 다시 입력해 주세요';throw error;}
      finally{entry.saving=null;if(entry.revision>revision)scheduleTodoSave(card,250);}
    })();
    return entry.saving;
  }
  async function flushTodoCards(){
    const cards=[...document.querySelectorAll('#todo-grid .todo-note')];
    await Promise.all(cards.map(card=>flushTodoCard(card)));
  }
  async function todoBlur(target){
    const card=target.closest?.('.todo-note');
    if(!card||!target.matches('[data-todo-field]'))return false;
    await flushTodoCard(card);return true;
  }
  async function createTodoNote(point){
    await flushTodoCards();
    const result=await api('/todos',{method:'POST',body:{title:'',body:'',target_date:todo.today,...(point?{pos_x:point.x,pos_y:point.y}:{})}});
    await renderTodos();
    const memo=document.querySelector(`#todo-grid [data-todo-id="${result.todo.id}"] .todo-note-body`);
    memo?.focus();
  }
  async function todoContextMenu(event){
    if(state.view!=='todos'||modal.open||!event.target.closest?.('.workspace'))return false;
    if(event.target.closest('.topbar,.horizontal-nav,.page-head,.todo-head,.todo-note,.done-board,button,input,textarea,a'))return false;
    event.preventDefault();
    // 메모 보드 안을 오른쪽 클릭하면 그 자리에 새 메모를 만든다.
    const grid=document.querySelector('#todo-grid.free'),box=grid?.getBoundingClientRect();
    const point=box&&event.clientX>=box.left&&event.clientX<=box.right&&event.clientY>=box.top&&event.clientY<=box.bottom?{x:Math.round(Math.min(Math.max(0,event.clientX-box.left),Math.max(0,grid.clientWidth-285))),y:Math.round(Math.max(0,event.clientY-box.top))}:null;
    await createTodoNote(point);return true;
  }
  async function toggleTodo(target){
    const card=target.closest('.todo-note'),id=Number(card.dataset.todoId);
    await flushTodoCard(card);
    await api('/todos/'+id,{method:'PATCH',body:{done:target.checked}});
    await renderTodos();
  }
  async function renderTodos() {
    if(state.view==='todos'&&document.querySelector('#todo-grid'))await flushTodoCards();
    const result=await api('/todos');
    if(state.view!=='todos')return;
    todo.items=result.todos;todo.today=result.today;todo.todayOpen=result.today_open;
    const pending=todo.items.filter(row=>!row.done),completed=todo.items.filter(row=>row.done);
    const todoPanel=`<section class="todo-panel" aria-labelledby="todo-heading"><div class="todo-layout"><div class="todo-active"><div class="todo-head"><div><p class="eyebrow">STICKY NOTES</p><h2 id="todo-heading">오늘의 할 일 <small id="todo-today-count">오늘 ${todo.todayOpen}건</small></h2><p>노란 메모지에 바로 입력하세요. 빈 공간을 마우스 오른쪽 버튼으로 누르면 그 자리에 새 메모지가 만들어지고, 메모 위·아래 테두리를 끌면 원하는 위치로 옮길 수 있습니다.</p></div></div><div class="todo-grid" id="todo-grid" tabindex="0" aria-label="진행 중인 메모. 빈 공간에서 오른쪽 클릭으로 새 메모 추가">${pending.map(todoCard).join('')}</div></div><aside class="done-board" aria-label="완료 보드"><div class="done-board-head"><div><p class="eyebrow">FINISHED NOTES</p><h2>완료 보드 <small>${completed.length}건</small></h2></div><span aria-hidden="true">✓</span></div><p class="done-board-hint">완료한 메모를 누르면 크게 펼쳐집니다.</p><div class="done-board-notes">${completed.length?completed.map(doneNote).join(''):`<p class="done-board-empty">완료 체크한 메모가 여기에 붙습니다.</p>`}</div></aside></div></section>`;
    document.querySelector('#content').innerHTML=pageHead('PERSONAL NOTES','TO-DO List','할 일을 메모로 정리하고 완료 상태를 관리하세요.')+todoPanel;
    layoutTodoBoard();
  }
  async function todoFileDrop(card,files){
    if(card.classList.contains('locked'))throw new Error('잠긴 메모에는 파일을 첨부할 수 없습니다. 잠금을 해제해 주세요.');
    await flushTodoCard(card);
    for(const file of files){const body=new FormData();body.append('file',file);await api(`/todos/${card.dataset.todoId}/files`,{method:'POST',body});}
    await renderTodos();toast('메모에 파일을 첨부했습니다.');
  }
  async function customerFileDrop(files){
    if(!work.customer||!canEdit())throw new Error('파일을 첨부할 고객을 먼저 선택해 주세요.');
    for(const file of files){const body=new FormData();body.append('file',file);await api(`/customers/${work.customer}/files`,{method:'POST',body});}
    await renderWork();toast('고객 정보에 파일을 첨부했습니다.');
  }
  async function renderWork() {
    const [customers, result] = await Promise.all([
      api('/customers'),
      api('/work-logs?' + new URLSearchParams({ ...work.filters, customer_id: work.customer ?? '', ...listingQuery('work', work.page) }))
    ]);
    if (state.view !== 'work') return;
    work.customers = customers.customers;
    const f = work.filters;
    const selectedCustomer=work.customers.find(c=>c.id===Number(work.customer));
    const customerOptions = `<option value="">전체 고객</option>${work.customers.map(c => `<option value="${c.id}" ${Number(work.customer) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
    document.querySelector('#content').innerHTML =
      pageHead('CUSTOMER WORK LOG', '업무관리', '고객별 업무일지를 기록하고 진행 상황을 확인하세요.',
        canEdit() ? '<div class="head-actions"><button data-action="customer-new">＋ 고객 등록</button><button class="primary" data-action="work-new">＋ 업무일지 작성</button></div>' : '') +
      `<section class="panel classified-panel"><aside class="classified-sidebar"><div class="category-title">고객</div><button class="category-link ${work.customer === null ? 'selected' : ''}" data-action="work-customer">전체 고객</button>${work.customers.map(c => `<button class="category-link ${Number(work.customer) === c.id ? 'selected' : ''}" data-action="work-customer" data-id="${c.id}">${esc(c.name)} <small>${c.log_count}건</small></button>`).join('')}${canEdit() && work.customer ? '<div class="category-actions"><button class="small" data-action="customer-edit" data-id="' + work.customer + '">고객 정보 수정</button><button class="small danger" data-action="customer-delete" data-id="' + work.customer + '">고객 삭제</button></div>' : ''}</aside><div class="classified-main"><div class="panel-head"><h2>업무일지 <small>${result.total}건</small></h2></div><form id="work-filter" class="filters"><label>검색<input name="q" placeholder="고객, 제목, 담당자, 업무 내용" value="${esc(f.q)}"></label><label>상태<select name="status"><option value="">모든 상태</option>${Object.entries(workStatus).map(([key, value]) => `<option value="${key}" ${f.status === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>시작일<input name="from" type="date" value="${esc(f.from)}"></label><label>종료일<input name="to" type="date" value="${esc(f.to)}"></label><button class="primary">조회</button><button type="button" data-action="work-reset">초기화</button></form>${result.logs.length ? `<div class="table-wrap"><table><thead><tr><th>업무일</th><th>고객</th><th>제목</th><th>담당자</th><th>상태</th><th>최근 수정</th><th>관리</th></tr></thead><tbody>${result.logs.map(row => `<tr><td>${esc(row.work_date)}</td><td>${esc(row.customer_name)}</td><td><button class="link-button" data-action="work-log" data-id="${row.id}">${esc(row.title)}</button></td><td>${esc(row.owner) || '—'}</td><td><span class="badge">${workStatus[row.status]}</span></td><td>${fmt(row.updated_at)}</td><td>${canEdit() ? `<button class="small danger" data-action="work-delete" data-id="${row.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>표시할 업무일지가 없습니다</h3><p>고객을 선택해 업무 내용을 등록하거나 검색 조건을 바꿔 보세요.</p></div>'}<div class="footer-row"><span>${result.total}건</span><div class="pager"><button class="small" data-action="work-prev" ${work.page <= 1 ? 'disabled' : ''}>이전</button><span>${work.page} / ${Math.max(1, Math.ceil(result.total / 25))}</span><button class="small" data-action="work-next" ${work.page >= Math.ceil(result.total / 25) ? 'disabled' : ''}>다음</button></div></div></div></section>`;
    document.querySelector('#work-filter [name="status"]').closest('label').insertAdjacentHTML('afterend', `<label>업무 유형<select name="work_type"><option value="">모든 유형</option>${Object.entries(workTypes).map(([key, label]) => `<option value="${key}" ${f.work_type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`);
    document.querySelector('#work-filter [name="work_type"]').closest('label').insertAdjacentHTML('afterend', `<label>업무 타입<select name="work_mode"><option value="">모든 타입</option>${Object.entries(workModes).map(([key, label]) => `<option value="${key}" ${f.work_mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`);
    const table = document.querySelector('#content .classified-main table');
    if (table) {
      table.tHead.rows[0].cells[3].insertAdjacentHTML('beforebegin', '<th>업무 유형</th><th>업무 타입</th>');
      result.logs.forEach((row, index) => table.tBodies[0].rows[index].cells[3].insertAdjacentHTML('beforebegin', `<td>${workTypes[row.work_type] ?? '미분류'}</td><td>${workModes[row.work_mode] ?? '미분류'}</td>`));
    }
    decorateListing('work', result.total, result.page);
    if(selectedCustomer){
      const details=`<section class="customer-detail" aria-label="고객 정보"><div><strong>${esc(selectedCustomer.name)} · 고객 정보</strong><p>${selectedCustomer.notes?esc(selectedCustomer.notes):'등록된 메모가 없습니다.'}</p>${selectedCustomer.contact?`<small>연락처: ${esc(selectedCustomer.contact)}</small>`:''}</div><div class="customer-files" data-customer-drop="${selectedCustomer.id}"><strong>첨부파일 · 여기에 파일을 끌어 놓으세요</strong>${(selectedCustomer.files??[]).map(file=>`<div><a href="/api/customer-files/${file.id}/download">${esc(file.name)}</a>${canEdit()?`<button type="button" class="small danger" data-action="customer-file-delete" data-id="${file.id}">삭제</button>`:''}</div>`).join('')}</div></section>`;
      document.querySelector('#content .classified-main .panel-head').insertAdjacentHTML('afterend',details);
    }
  }
  function customerDialog(id) {
    const c = work.customers.find(row => row.id === Number(id)) ?? { active: true };
    work.selectedCustomer = c;
    openDialog(id ? '고객 정보 수정' : '고객 등록', `<form id="customer-form"><div class="form-grid">${input('name', '고객명 *', c.name, 'required maxlength="150"')}${input('contact', '연락처', c.contact, 'maxlength="200"')}<label class="full">메모<textarea name="notes" maxlength="2000">${esc(c.notes)}</textarea></label>${id ? `<label class="checkbox-line full"><input name="active" type="checkbox" ${c.active ? 'checked' : ''}>사용 중</label>` : ''}</div><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div></form>`);
  }
  async function workDialog(id) {
    const row = id ? (await api('/work-logs/' + id)).log : { customer_id: work.customer, work_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()), owner: state.user.name, status: 'planned' };
    work.selected = row;
    const disabled = canEdit() ? '' : 'disabled';
    const choices = work.customers.map(c => `<option value="${c.id}" ${c.id === Number(row.customer_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + (id && !work.customers.some(c => c.id === row.customer_id) ? `<option value="${row.customer_id}" selected>${esc(row.customer_name)} (삭제된 고객)</option>` : '');
    openDialog(id ? '업무일지 상세' : '업무일지 작성', `<form id="work-form"><div class="form-grid"><label>고객 *<select name="customer_id" required ${disabled}><option value="">고객을 선택하세요</option>${choices}</select></label>${input('work_date', '업무일 *', row.work_date, 'type="date" required ' + disabled)}${input('title', '제목 *', row.title, 'required maxlength="150" ' + disabled)}${input('owner', '담당자', row.owner, 'maxlength="100" ' + disabled)}<label>진행 상태<select name="status" ${disabled}>${Object.entries(workStatus).map(([key, value]) => `<option value="${key}" ${row.status === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="full">업무 내용<textarea class="work-content" name="content" maxlength="10000" rows="12" ${disabled}>${esc(row.content)}</textarea></label></div>${canEdit() ? '<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div>' : ''}</form>`);
    modal.querySelector('[name="status"]').closest('label').insertAdjacentHTML('afterend', `<label>업무 유형 *<select name="work_type" required ${disabled}><option value="">${id ? '유형 미지정' : '유형을 선택하세요'}</option>${Object.entries(workTypes).map(([key, label]) => `<option value="${key}" ${row.work_type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>업무 타입 *<select name="work_mode" required ${disabled}><option value="">${id ? '타입 미지정' : '타입을 선택하세요'}</option>${Object.entries(workModes).map(([key, label]) => `<option value="${key}" ${row.work_mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`);
  }
  function pathFromTree(tree, id) {
    if (!id) return '미분류';
    const byId = new Map(tree.map(row => [row.id, row]));
    let row = byId.get(Number(id));
    if (!row) return '미분류';
    const names = [];
    while (row) { names.unshift(row.name); row = row.parent_id ? byId.get(row.parent_id) : null; }
    return names.join(' / ');
  }
  async function renderReports() {
    const result = await api('/reports?' + new URLSearchParams(report));
    if (state.view !== 'reports') return;
    const counts = result.counts;
    const names = { installations: '설치', items: '자산', manuals: '자료', work_logs: '업무일지' };
    const query = new URLSearchParams(report).toString();
    const statusTable = (scope, label) => `<div class="report-group"><h3>${label} 상태</h3>${result.statuses[scope].length ? result.statuses[scope].map(row => `<div class="report-row"><span>${esc(workStatus[row.value] ?? ctx.labels[row.value] ?? row.value)}</span><strong>${row.count}건</strong></div>`).join('') : '<p class="muted">자료가 없습니다.</p>'}</div>`;
    const categoryTable = (scope, label) => {
      const tree = scope === 'manuals' ? result.folderTree : result.categoryTree.filter(row => row.scope === scope);
      return `<div class="report-group"><h3>${label} 분류</h3>${result.categories[scope].length ? result.categories[scope].map(row => `<div class="report-row"><span>${esc(pathFromTree(tree, row.value))}</span><strong>${row.count}건</strong></div>`).join('') : '<p class="muted">자료가 없습니다.</p>'}</div>`;
    };
    document.querySelector('#content').innerHTML =
      pageHead('REPORTS', '리포트', '기간별 현황을 확인하고 엑셀에서 열 수 있는 CSV 파일로 내려받으세요.') +
      `<section class="panel"><form id="report-filter" class="filters report-filters"><label>시작일<input name="from" type="date" value="${esc(report.from)}"></label><label>종료일<input name="to" type="date" value="${esc(report.to)}"></label><button class="primary">조회</button><button type="button" data-action="report-reset">초기화</button></form><div class="report-stats">${Object.entries(names).map(([key, label]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${counts[key]}<span>건</span></div><a href="/api/reports/${key === 'work_logs' ? 'work-logs' : key}.csv?${query}">CSV 내려받기</a></div>`).join('')}</div><div class="report-grid">${statusTable('installations', '설치')}${statusTable('items', '자산')}${statusTable('work_logs', '업무일지')}${categoryTable('installations', '설치')}${categoryTable('items', '자산')}${categoryTable('manuals', '자료')}<div class="report-group"><h3>고객별 업무일지</h3>${result.customers.length ? result.customers.map(row => `<div class="report-row"><span>${esc(row.value)}</span><strong>${row.count}건</strong></div>`).join('') : '<p class="muted">자료가 없습니다.</p>'}</div></div><div class="footer-row"><span>등록된 활성 고객 ${counts.customers}곳 · CSV는 UTF-8 형식입니다.</span></div></section>`;
  }
  async function action(action, id, button) {
    const scope = button.dataset.scope;
    if(action==='todo-open-done'){openDoneNote(id);return true;}
    if(action==='todo-lock'){const card=button.closest('.todo-note');if(card)await flushTodoCard(card);openDialog('메모 잠금',`<form id="todo-lock-form" data-id="${Number(id)}"><p class="help-line">잠그면 메모 내용과 첨부파일이 보이지 않습니다. 이 비밀번호를 입력해야 잠금이 풀립니다. 비밀번호는 다시 확인할 수 없으니 잊지 않도록 주의하세요.</p>${input('password','잠금 비밀번호 (4~64자)','','type="password" required minlength="4" maxlength="64" autocomplete="new-password"')}${input('confirm','비밀번호 확인','','type="password" required minlength="4" maxlength="64" autocomplete="new-password"')}<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary" type="submit">잠금</button></div></form>`);modal.querySelector('input[name="password"]')?.focus();return true;}
    if(action==='todo-unlock'){openDialog('메모 잠금 해제',`<form id="todo-unlock-form" data-id="${Number(id)}">${input('password','잠금 비밀번호','','type="password" required maxlength="64" autocomplete="current-password"')}<p class="help-line">비밀번호가 맞으면 잠금이 해제되고 내용이 다시 보입니다.</p><div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary" type="submit">잠금 해제</button></div></form>`);modal.querySelector('input[name="password"]')?.focus();return true;}
    if(action==='todo-restore'){await api('/todos/'+id,{method:'PATCH',body:{done:false}});modal.close();await renderTodos();toast('메모를 할 일로 옮겼습니다.');return true;}
    if(action==='todo-delete'){if(confirm('이 할 일 메모를 삭제할까요?')){const card=document.querySelector(`#todo-grid [data-todo-id="${Number(id)}"]`),entry=card&&todoSaves.get(card);if(entry){clearTimeout(entry.timer);if(entry.saving)await entry.saving.catch(()=>{});entry.savedRevision=entry.revision;}await api('/todos/'+id,{method:'DELETE'});if(modal.open&&modal.querySelector('.todo-expanded'))modal.close();await renderTodos();toast('할 일을 삭제했습니다.');}return true;}
    if(action==='todo-file-delete'){if(confirm('첨부파일을 삭제할까요?')){await api('/todo-files/'+id,{method:'DELETE'});await renderTodos();}return true;}
    if(action==='customer-file-delete'){if(confirm('첨부파일을 삭제할까요?')){await api('/customer-files/'+id,{method:'DELETE'});await renderWork();}return true;}
    if (action === 'category-select') {
      const filters = scope === 'items' ? state.filters : features.installationFilters;
      if (id) filters.category_id = id; else delete filters.category_id;
      if (scope === 'items') { state.page = 1; await renderItems(); }
      else { features.installationPage = 1; await renderInstallations(); }
      return true;
    }
    if (action === 'category-new' || action === 'category-child' || action === 'category-rename') {
      const existing = action === 'category-rename' ? cache[scope].find(row => row.id === Number(id)) : null;
      await categoryDialog(scope, action === 'category-child' ? id : null, existing);
      return true;
    }
    if (action === 'category-delete') {
      if (confirm('이 분류를 삭제할까요? 비어 있는 분류만 삭제할 수 있습니다.')) {
        await api('/categories/' + id + '?scope=' + encodeURIComponent(scope), { method: 'DELETE' });
        const filters = scope === 'items' ? state.filters : features.installationFilters;
        delete filters.category_id;
        await loadCategories(scope); await renderView(); toast('분류를 삭제했습니다.');
      }
      return true;
    }
    if (action === 'work-customer') { work.customer = id ? Number(id) : null; work.page = 1; await renderWork(); return true; }
    if (action === 'customer-delete') { const c=work.customers.find(row=>row.id===Number(id)); if(confirm(`${c?.name??'이 고객'}을 고객 목록에서 삭제할까요? 연결된 설치정보·업무일지는 보존됩니다.`)){const result=await api('/customers/'+id,{method:'DELETE'});work.customer=null;work.page=1;await renderWork();toast(result.archived?'고객을 목록에서 숨겼습니다. 기존 기록은 보존됩니다.':'고객을 삭제했습니다.');} return true; }
    if (action === 'work-delete') { if(confirm('업무일지를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')){await api('/work-logs/'+id,{method:'DELETE'});await renderWork();toast('업무일지를 삭제했습니다.');} return true; }
    if (action === 'customer-new' || action === 'customer-edit') { customerDialog(id); return true; }
    if (action === 'work-new' || action === 'work-log') { if (!id && !work.customers.some(c => c.active)) throw new Error('고객을 먼저 등록해 주세요.'); await workDialog(id); return true; }
    if (action === 'work-prev' || action === 'work-next') { work.page += action === 'work-prev' ? -1 : 1; await renderWork(); return true; }
    if (action === 'work-reset') { work.filters = {}; work.customer = null; work.page = 1; await renderWork(); return true; }
    if (action === 'report-reset') { report.from = ''; report.to = ''; await renderReports(); return true; }
    return false;
  }
  async function submit(form, values) {
    if(form.id==='todo-lock-form'){if(values.password!==values.confirm)throw new Error('비밀번호 확인이 일치하지 않습니다.');await api(`/todos/${Number(form.dataset.id)}/lock`,{method:'POST',body:{password:values.password}});modal.close();await renderTodos();toast('메모를 잠갔습니다.');return true;}
    if(form.id==='todo-unlock-form'){await api(`/todos/${Number(form.dataset.id)}/unlock`,{method:'POST',body:{password:values.password}});modal.close();await renderTodos();toast('잠금을 해제했습니다.');return true;}
    if (form.id === 'category-form') {
      const scope = form.dataset.scope, categoryId = form.dataset.id;
      if (categoryId) await api('/categories/' + categoryId, { method: 'PUT', body: { scope, name: values.name } });
      else { const created = await api('/categories', { method: 'POST', body: { scope, name: values.name, parent_id: values.parent_id || null } }); const filters = scope === 'items' ? state.filters : features.installationFilters; filters.category_id = String(created.id); }
      modal.close(); await loadCategories(scope); await renderView(); toast('분류를 저장했습니다.'); return true;
    }
    if (form.id === 'customer-form') {
      const c = work.selectedCustomer;
      const saved = await api('/customers' + (c.id ? '/' + c.id : ''), { method: c.id ? 'PUT' : 'POST', body: { ...values, active: c.id ? form.elements.active.checked : true } });
      work.customer = saved.customer.id;
      modal.close(); await renderWork(); toast('고객 정보를 저장했습니다.'); return true;
    }
    if (form.id === 'work-form') {
      const row = work.selected;
      await api('/work-logs' + (row.id ? '/' + row.id : ''), { method: row.id ? 'PUT' : 'POST', body: { ...values, version: row.version } });
      modal.close(); await renderWork(); toast('업무일지를 저장했습니다.'); return true;
    }
    if (form.id === 'work-filter') {
      if (values.from && values.to && values.from > values.to) throw new Error('종료일은 시작일 이후로 설정해 주세요.');
      work.filters = Object.fromEntries(Object.entries(values).filter(([, value]) => value));
      work.page = 1; await renderWork(); return true;
    }
    if (form.id === 'report-filter') {
      if (values.from && values.to && values.from > values.to) throw new Error('종료일은 시작일 이후로 설정해 주세요.');
      report.from = values.from; report.to = values.to; await renderReports(); return true;
    }
    return false;
  }
  return { loadCategories, categoryPath, leafSelect, attachCategoryPanel, renderWork, renderTodos, renderReports, todoInput, todoBlur, todoContextMenu, toggleTodo, todoFileDrop, customerFileDrop, rememberTodoSize, todoDragStart, todoDragMove, todoDragEnd, layoutTodoBoard, action, submit, categoryDepth: (scope, id) => cache[scope].find(row => row.id === id)?.level ?? 0, resetWorkPage: () => { work.page = 1; }, clearWorkCustomer: () => { work.customer = null; work.page = 1; } };
}
