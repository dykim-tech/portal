export function createManagement({api,esc,state,canEdit,openDialog,input,toast,fmt,pageHead,modal,renderView}){
 const kindLabels={installation:'설치 프로젝트',other:'기타 프로젝트'};
 const phaseLabels={before:'설치 전',during:'설치 중',after:'설치 후'};
 const statusLabels={planned:'예정',in_progress:'진행 중',on_hold:'보류',completed:'완료'};
 const projectState={filters:{},page:1,selected:null,documents:null,document:0};
 const choices=(values,selected,labels)=>values.map(value=>`<option value="${value}" ${value===selected?'selected':''}>${labels[value]}</option>`).join('');
 const dateValue=value=>value??'';
 // 문서 안의 **굵게**, `코드`, [링크](주소)를 표시한다. 먼저 이스케이프하므로 문서 내용이 HTML로 실행되지 않는다.
 const inline=text=>esc(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\[([^\]]+)\]\([^)\s]+\)/g,'$1');
 function documentHtml(markdown){
  const lines=markdown.split(/\r?\n/),html=[];
  let inCode=false,inList=false;
  const closeList=()=>{if(inList){html.push('</ul>');inList=false;}};
  for(let index=0;index<lines.length;index++){
   const line=lines[index];
   if(/^\s*(?:```|~~~)/.test(line)){closeList();html.push(inCode?'</code></pre>':'<pre><code>');inCode=!inCode;continue;}
   if(inCode){html.push(esc(line)+'\n');continue;}
   if(line.startsWith('|')&&lines[index+1]?.startsWith('|')&&/^\|[\s:|\-]+\|$/.test(lines[index+1])){
    closeList();const cells=row=>row.split('|').slice(1,-1).map(cell=>inline(cell.trim()));
    html.push('<div class="table-wrap"><table><thead><tr>'+cells(line).map(cell=>`<th>${cell}</th>`).join('')+'</tr></thead><tbody>');index+=2;
    while(index<lines.length&&lines[index].startsWith('|')){html.push('<tr>'+cells(lines[index]).map(cell=>`<td>${cell}</td>`).join('')+'</tr>');index++;}
    html.push('</tbody></table></div>');index--;continue;
   }
   const heading=/^(#{1,4})\s+(.+)$/.exec(line);
   if(heading){closeList();const level=Math.min(4,heading[1].length+1);html.push(`<h${level}>${inline(heading[2])}</h${level}>`);continue;}
   const bullet=/^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
   if(bullet){if(!inList){html.push('<ul>');inList=true;}html.push(`<li>${inline(bullet[1])}</li>`);continue;}
   const picture=/^!\[([^\]]+)\]\(\.\.\/public\/([a-z0-9-]+\.png)\)$/.exec(line.trim());
   if(picture){closeList();html.push(`<figure class="operations-diagram"><img src="/${picture[2]}" alt="${esc(picture[1])}" loading="lazy"></figure>`);continue;}
   closeList();const quote=/^>\s?(.*)$/.exec(line);if(quote){html.push(`<blockquote>${inline(quote[1])}</blockquote>`);continue;}if(line.trim())html.push(`<p>${inline(line)}</p>`);
  }
  closeList();if(inCode)html.push('</code></pre>');
  return html.join('');
 }
 async function renderProjects(){
  const data=await api('/projects?'+new URLSearchParams({...projectState.filters,page:projectState.page}));
  if(state.view!=='projects')return;
  const counts=data.counts;
  const filters=projectState.filters;
  document.querySelector('#content').innerHTML=pageHead('PROJECT PIPELINE','프로젝트 관리','설치 예정과 기타 프로젝트의 준비·진행·완료를 함께 관리하세요.',canEdit()?'<button class="primary" data-action="project-new">＋ 프로젝트 등록</button>':'')+
   `<div class="project-stats">${[['전체',counts.total],['설치 전',counts.before_count],['설치 중',counts.during_count],['설치 후',counts.after_count]].map(([label,count])=>`<div class="project-stat"><small>${label}</small><strong>${count??0}건</strong></div>`).join('')}</div>
   <section class="panel"><form id="project-filter" class="filters project-filters"><label>검색<input name="q" placeholder="프로젝트, 고객사, 담당자" value="${esc(filters.q)}"></label><label>유형<select name="kind"><option value="">전체 유형</option>${choices(Object.keys(kindLabels),filters.kind,kindLabels)}</select></label><label>단계<select name="phase"><option value="">전체 단계</option>${choices(Object.keys(phaseLabels),filters.phase,phaseLabels)}</select></label><label>상태<select name="status"><option value="">전체 상태</option>${choices(Object.keys(statusLabels),filters.status,statusLabels)}</select></label><button class="primary">조회</button><button type="button" data-action="project-reset">초기화</button></form>
   ${data.projects.length?`<div class="table-wrap"><table class="projects-table"><thead><tr><th>프로젝트</th><th>고객사</th><th>유형</th><th>단계</th><th>상태</th><th>예정 기간</th><th>담당자</th><th>할 일</th>${canEdit()?'<th>관리</th>':''}</tr></thead><tbody>${data.projects.map(row=>`<tr><td><button class="link-button" data-action="project-open" data-id="${row.id}">${esc(row.name)}</button>${row.installation_name?`<span class="secondary-line">설치정보: ${esc(row.installation_name)}</span>`:''}</td><td>${esc(row.customer)||'—'}</td><td>${kindLabels[row.kind]}</td><td><span class="badge">${phaseLabels[row.phase]}</span></td><td><span class="badge ${row.status}">${statusLabels[row.status]}</span></td><td>${esc(row.planned_start)||'—'} ~ ${esc(row.planned_end)||'—'}</td><td>${esc(row.owner)||'—'}</td><td>${row.done_count}/${row.task_count}</td>${canEdit()?`<td><button class="small danger" type="button" data-action="project-delete" data-id="${row.id}" aria-label="프로젝트 삭제: ${esc(row.name)}">삭제</button></td>`:''}</tr>`).join('')}</tbody></table></div>`:'<div class="empty"><h3>표시할 프로젝트가 없습니다</h3><p>프로젝트를 등록하거나 검색 조건을 바꿔 보세요.</p></div>'}<div class="footer-row"><span>${data.total}건</span><div class="pager"><button class="small" data-action="project-prev" ${data.page<=1?'disabled':''}>이전</button><span>${data.page} / ${Math.max(1,Math.ceil(data.total/data.page_size))}</span><button class="small" data-action="project-next" ${data.page>=Math.ceil(data.total/data.page_size)?'disabled':''}>다음</button></div></div></section>`;
 }
 async function projectDialog(id){
  const data=id?await api('/projects/'+id):{project:{kind:'installation',phase:'before',status:'planned',owner:state.user.name},tasks:[]};
  const row=data.project;projectState.selected=row;
  const installations=await api('/installations?'+new URLSearchParams({page_size:100,sort:'installed_on',direction:'desc'}));
  const selectedMissing=row.installation_id&&!installations.installations.some(item=>item.id===row.installation_id);
  const installationChoices=installations.installations.map(item=>`<option value="${item.id}" ${item.id===row.installation_id?'selected':''}>${esc(item.customer)} · ${esc(item.name)} · ${esc(item.installed_on)}</option>`).join('');
  const disabled=canEdit()?'':'disabled';
  openDialog(id?'프로젝트 상세':'프로젝트 등록',`<form id="project-form"><div class="form-grid">${input('name','프로젝트명 *',row.name,`required maxlength="150" ${disabled}`)}<label>유형<select name="kind" ${disabled}>${choices(Object.keys(kindLabels),row.kind,kindLabels)}</select></label><label>단계<select name="phase" ${disabled}>${choices(Object.keys(phaseLabels),row.phase,phaseLabels)}</select></label><label>상태<select name="status" ${disabled}>${choices(Object.keys(statusLabels),row.status,statusLabels)}</select></label>${input('customer','고객사',row.customer,`maxlength="150" ${disabled}`)}${input('owner','담당자',row.owner,`maxlength="150" ${disabled}`)}${input('location','위치',row.location,`maxlength="200" ${disabled}`)}<label>연결할 설치 정보<select name="installation_id" ${disabled}><option value="">연결 안 함</option>${selectedMissing?`<option value="${row.installation_id}" selected>기존 연결 #${row.installation_id}</option>`:''}${installationChoices}</select></label>${input('planned_start','예정 시작일',dateValue(row.planned_start),`type="date" ${disabled}`)}${input('planned_end','예정 종료일',dateValue(row.planned_end),`type="date" ${disabled}`)}${input('actual_start','실제 시작일',dateValue(row.actual_start),`type="date" ${disabled}`)}${input('actual_end','실제 종료일',dateValue(row.actual_end),`type="date" ${disabled}`)}<label class="full">메모<textarea name="notes" maxlength="10000" ${disabled}>${esc(row.notes)}</textarea></label></div>${canEdit()?`<div class="form-actions"><button type="button" data-action="close">취소</button>${id?`<button type="button" class="danger" data-action="project-delete" data-id="${row.id}">삭제</button>`:''}<button class="primary">저장</button></div>`:''}</form>${id?`<section class="subsection"><h3>단계별 할 일</h3>${Object.keys(phaseLabels).map(phase=>`<div class="project-phase"><strong>${phaseLabels[phase]}</strong>${data.tasks.filter(task=>task.phase===phase).map(task=>`<div class="project-task"><span class="project-task-title">${canEdit()?`<input type="checkbox" data-action="project-task-toggle" data-id="${task.id}" ${task.done_at?'checked':''} aria-label="${esc(task.title)} 완료">`:task.done_at?'✓ ':'○ '}${esc(task.title)}${task.due_date?` <small>(${task.due_date})</small>`:''}</span>${canEdit()?`<button class="small danger" data-action="project-task-delete" data-id="${task.id}">삭제</button>`:''}</div>`).join('')||'<p class="muted">등록된 할 일이 없습니다.</p>'}</div>`).join('')}${canEdit()?`<form id="project-task-form" class="project-task-form"><label>단계<select name="phase">${choices(Object.keys(phaseLabels),row.phase,phaseLabels)}</select></label>${input('title','할 일 *','','required maxlength="200"')}${input('due_date','예정일','','type="date"')}<button class="primary">추가</button></form>`:''}</section>`:'<p class="save-note">프로젝트를 먼저 저장하면 단계별 할 일을 관리할 수 있습니다.</p>'}`);
 }
 async function renderOperations(){
  const data=await api('/operations');if(state.view!=='operations')return;
  projectState.documents=data.documents;
  const selected=data.documents[projectState.document]??data.documents[0];
  document.querySelector('#content').innerHTML=pageHead('PORTAL OPERATIONS','운영관리','서버 상태와 포털 설계·화면 디자인을 확인하세요.')+
   `<div class="project-stats">${[['서버','정상'],['설치 정보',data.counts.installations+'건'],['프로젝트',data.counts.projects+'건'],['업무일지',data.counts.work_logs+'건']].map(([label,value])=>`<div class="project-stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
   <section class="panel operations-panel"><div class="panel-head"><h2>운영 상태</h2><button data-view="backups">백업/복구</button></div><div class="operations-status"><p>서버 시작: ${fmt(data.started_at)}</p><p>가동 시간: ${Math.floor(data.uptime_seconds/3600)}시간 ${Math.floor(data.uptime_seconds%3600/60)}분</p><p>활성 사용자: ${data.counts.users}명 · 등록 자료: ${data.counts.manuals}건</p></div></section>
   <section class="panel operations-panel"><div class="panel-head"><h2>설계도 · 디자인 · 운영자 매뉴얼</h2>${selected.pdf?`<a class="button-link primary" href="${esc(selected.pdf)}" download="DYKIM-PORTAL-Operator-Manual.pdf">PDF 다운로드</a>`:''}</div><div class="document-tabs">${data.documents.map((doc,index)=>`<button data-action="operations-document" data-id="${index}" class="${index===projectState.document?'active':''}" aria-pressed="${index===projectState.document}">${esc(doc.title)}</button>`).join('')}</div><article class="operations-document" id="operations-document">${documentHtml(selected.content)}</article></section>`;
 }
 // 사용량 관리(관리자 전용): 로컬 드라이브 공간과 포털 데이터·첨부 사용량
 const bytes=value=>{const n=Number(value)||0;if(n>=1024**4)return (n/1024**4).toFixed(2)+' TB';if(n>=1024**3)return (n/1024**3).toFixed(2)+' GB';if(n>=1024**2)return (n/1024**2).toFixed(1)+' MB';if(n>=1024)return (n/1024).toFixed(1)+' KB';return n+' B';};
 const percent=(part,total)=>total>0?Math.round(part/total*1000)/10:0;
 async function renderUsage(){
  const data=await api('/usage');if(state.view!=='usage')return;
  const portalTotal=data.storage.reduce((sum,row)=>sum+row.size,0),attachTotal=data.attachments.reduce((sum,row)=>sum+row.size,0);
  const main=data.drives[0]??{};
  document.querySelector('#content').innerHTML=pageHead('STORAGE USAGE','사용량 관리','포털이 사용하는 로컬 저장소 공간을 확인하세요.','<button data-action="usage-refresh">새로 고침</button>')+
   `<div class="project-stats">${[['드라이브 여유 공간',main.error?'확인 불가':bytes(main.free)],['드라이브 사용률',main.error?'—':percent(main.used,main.total)+'%'],['포털 데이터 합계',bytes(portalTotal)],['첨부파일 합계',bytes(attachTotal)]].map(([label,value])=>`<div class="project-stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
   <section class="panel operations-panel"><div class="panel-head"><h2>로컬 드라이브</h2><small>${esc(fmt(data.generated_at))} 기준</small></div><div class="usage-drives">${data.drives.map(drive=>drive.error?`<div class="usage-drive"><strong>${esc(drive.label)} · ${esc(drive.root)}</strong><p class="error-text">${esc(drive.error)}</p></div>`:`<div class="usage-drive"><div class="usage-drive-head"><strong>${esc(drive.label)} · ${esc(drive.root)}</strong><span>${bytes(drive.used)} 사용 / 전체 ${bytes(drive.total)} · 여유 ${bytes(drive.free)}</span></div><progress class="usage-bar ${percent(drive.used,drive.total)>=90?'danger':''}" max="${drive.total}" value="${drive.used}" aria-label="${esc(drive.label)} 사용률 ${percent(drive.used,drive.total)}%"></progress><small>${esc(drive.path)}</small></div>`).join('')}</div></section>
   <section class="panel operations-panel"><div class="panel-head"><h2>포털 데이터 파일</h2></div><div class="table-wrap"><table><thead><tr><th>항목</th><th>위치</th><th>크기</th><th>드라이브 대비</th></tr></thead><tbody>${data.storage.map(row=>`<tr><td>${esc(row.label)}${row.count!=null?`<span class="secondary-line">파일 ${row.count}개</span>`:''}</td><td class="usage-path">${esc(row.path)}</td><td>${bytes(row.size)}</td><td>${main.total?percent(row.size,main.total)+'%':'—'}</td></tr>`).join('')}</tbody></table></div><p class="help-line usage-note">데이터베이스 할당 ${bytes(data.database.allocated)} 중 재사용 가능한 빈 공간 ${bytes(data.database.reclaimable)}. 첨부파일은 데이터베이스 안에 저장되며, 백업 폴더는 3일치·하루 3건까지만 보관하고 나머지는 자동 삭제됩니다.</p></section>
   <section class="panel operations-panel"><div class="panel-head"><h2>메뉴별 첨부파일</h2></div><div class="table-wrap"><table><thead><tr><th>메뉴</th><th>파일 수</th><th>용량</th><th>첨부 합계 대비</th></tr></thead><tbody>${data.attachments.map(row=>`<tr><td>${esc(row.label)}</td><td>${row.count}개</td><td>${bytes(row.size)}</td><td>${percent(row.size,attachTotal)}%</td></tr>`).join('')}</tbody></table></div></section>`;
 }
 async function action(name,id){
  switch(name){
   case 'project-new':case 'project-open':await projectDialog(id);return true;
   case 'project-reset':projectState.filters={};projectState.page=1;await renderProjects();return true;
   case 'project-prev':case 'project-next':projectState.page+=name==='project-prev'?-1:1;await renderProjects();return true;
   case 'project-delete':if(confirm('이 프로젝트와 단계별 할 일을 삭제할까요?')){await api('/projects/'+id,{method:'DELETE'});if(modal.open)modal.close();await renderProjects();toast('프로젝트를 삭제했습니다.');}return true;
   case 'project-task-delete':if(confirm('이 할 일을 삭제할까요?')){await api('/project-tasks/'+id,{method:'DELETE'});await projectDialog(projectState.selected.id);await renderProjects();toast('할 일을 삭제했습니다.');}return true;
   case 'usage-refresh':await renderUsage();toast('사용량을 새로 확인했습니다.');return true;
   case 'operations-document':projectState.document=Number(id);await renderOperations();return true;
   default:return false;
  }
 }
 async function change(target){
  if(target.dataset.action!=='project-task-toggle')return false;
  await api('/project-tasks/'+target.dataset.id,{method:'PUT',body:{done:target.checked}});
  await projectDialog(projectState.selected.id);await renderProjects();return true;
 }
 async function submit(form,values){
  switch(form.id){
   case 'project-filter':projectState.filters=Object.fromEntries(Object.entries(values).filter(([,value])=>value));projectState.page=1;await renderProjects();return true;
   case 'project-form':{
    const row=projectState.selected;
    await api('/projects'+(row.id?'/'+row.id:''),{method:row.id?'PUT':'POST',body:{...values,version:row.version}});
    modal.close();await renderProjects();toast('프로젝트를 저장했습니다.');return true;
   }
   case 'project-task-form':await api('/projects/'+projectState.selected.id+'/tasks',{method:'POST',body:values});await projectDialog(projectState.selected.id);await renderProjects();toast('할 일을 추가했습니다.');return true;
   default:return false;
  }
 }
 return {renderProjects,renderOperations,renderUsage,action,change,submit};
}
