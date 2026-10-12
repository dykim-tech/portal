// 회의록: 날짜순 목록(검색·기간) + 상세 창(기본 항목·결정 사항·후속 조치·첨부파일).
// 모든 사용자가 열람하고 편집자·관리자만 작성·수정·삭제한다.
export function createMeetings({ api, esc, state, canEdit, openDialog, input, toast, fmt, modal }) {
  const meetingState = { filters: {}, page: 1, selected: null };
  const fileSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const timeRange = row => row.start_time ? `${row.start_time}${row.end_time ? ' ~ ' + row.end_time : ''}` : '';
  const short = (value, max = 60) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max) + '…' : t; };

  async function renderMeetings() {
    const f = meetingState.filters;
    const data = await api('/meetings?' + new URLSearchParams({ ...f, page: meetingState.page }));
    if (state.view !== 'meetings') return;
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    const rows = data.meetings.map(row => `<tr><td class="meeting-date">${esc(row.meeting_date)}${timeRange(row) ? `<span class="secondary-line">${esc(timeRange(row))}</span>` : ''}</td><td><button class="link-button" data-action="meeting-open" data-id="${row.id}">${esc(row.title)}</button>${row.location ? `<span class="secondary-line">${esc(row.location)}</span>` : ''}</td><td class="meeting-attendees" title="${esc(row.attendees)}">${esc(short(row.attendees, 40)) || '—'}</td><td>${row.action_count ? `<span class="badge ${row.open_action_count ? 'upcoming' : 'active'}">${row.open_action_count ? `미완료 ${row.open_action_count}` : '모두 완료'}</span><span class="secondary-line">전체 ${row.action_count}건</span>` : '—'}</td><td>${row.file_count ? row.file_count + '개' : '—'}</td><td>${esc(fmt(row.updated_at))}<span class="secondary-line">${esc(row.updated_by_name ?? '')}</span></td></tr>`).join('');
    document.querySelector('#content').innerHTML = `<h1 class="sr-only">회의록</h1>${canEdit() ? '<div class="page-head page-head-actions"><button class="primary" data-action="meeting-new">＋ 회의록 작성</button></div>' : ''}
      <section class="panel"><div class="panel-head"><h2>회의록 <small>${data.total}건</small></h2><small>회의 날짜 최신순</small></div>
      <form id="meeting-filter" class="filters meeting-filters"><label>검색<input name="q" placeholder="제목, 참석자, 장소, 내용, 결정 사항" value="${esc(f.q)}"></label><label>회의일 시작<input name="from" type="date" value="${esc(f.from)}"></label><label>회의일 종료<input name="to" type="date" value="${esc(f.to)}"></label><button class="primary">조회</button><button type="button" data-action="meeting-reset">초기화</button></form>
      ${rows ? `<div class="table-wrap"><table class="meetings-table"><thead><tr><th>회의 날짜</th><th>제목 / 장소</th><th>참석자</th><th>후속 조치</th><th>첨부</th><th>최근 수정</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><h3>${Object.keys(f).length ? '검색 결과가 없습니다' : '아직 작성한 회의록이 없습니다'}</h3><p>${Object.keys(f).length ? '검색어나 기간을 바꿔 보세요.' : '회의 내용과 결정 사항, 후속 조치를 기록해 보세요.'}</p>${canEdit() && !Object.keys(f).length ? '<button data-action="meeting-new">첫 회의록 작성</button>' : ''}</div>`}
      <div class="footer-row"><span>${data.total}건</span><div class="pager"><button class="small" data-action="meeting-prev" ${data.page <= 1 ? 'disabled' : ''}>이전</button><span>${data.page} / ${pages}</span><button class="small" data-action="meeting-next" ${data.page >= pages ? 'disabled' : ''}>다음</button></div></div></section>`;
  }

  // 같은 회의록 창을 다시 그릴 때(후속 조치·첨부 추가 후) 저장하지 않은 입력과 스크롤 위치를 유지한다.
  async function meetingDialog(id) {
    const same = id && meetingState.selected?.id === Number(id), form0 = same && modal.open ? modal.querySelector('#meeting-form') : null;
    const keep = form0 ? Object.fromEntries(new FormData(form0)) : null, previous = same ? meetingState.selected : null, scroll = same ? modal.scrollTop : 0;
    const data = id ? await api('/meetings/' + id) : { meeting: { title: '', meeting_date: today(), start_time: '', end_time: '', location: '', attendees: '', content: '', decisions: '' }, actions: [], files: [] };
    const row = data.meeting; meetingState.selected = row;
    const editable = canEdit(), off = editable ? '' : 'disabled';
    const actions = data.actions.map(a => `<div class="meeting-action ${a.done_at ? 'done' : ''}"><label class="meeting-action-title">${editable ? `<input type="checkbox" data-action="meeting-action-toggle" data-id="${a.id}" ${a.done_at ? 'checked' : ''} aria-label="${esc(a.task)} 완료">` : `<span aria-hidden="true">${a.done_at ? '✓' : '○'}</span>`}<span>${esc(a.task)}</span></label><span class="meeting-action-meta">${esc(a.owner) || '담당자 미정'}${a.due_date ? ` · 기한 ${esc(a.due_date)}` : ''}${a.due_date && !a.done_at && a.due_date < today() ? ' · <strong class="meeting-overdue">기한 지남</strong>' : ''}</span>${editable ? `<button type="button" class="small danger" data-action="meeting-action-delete" data-id="${a.id}" aria-label="후속 조치 삭제: ${esc(a.task)}">삭제</button>` : ''}</div>`).join('');
    const files = data.files.map(file => `<div class="file-row"><div><strong>${esc(file.name)}</strong><span class="secondary-line">${fileSize(file.size)} · ${esc(fmt(file.created_at))}</span></div><div class="file-actions"><a href="/api/meeting-files/${file.id}/download">다운로드</a>${editable ? `<button type="button" class="small danger" data-action="meeting-file-delete" data-id="${file.id}">삭제</button>` : ''}</div></div>`).join('');
    openDialog(id ? '회의록' : '회의록 작성', `<form id="meeting-form" class="meeting-form"><div class="form-grid">
      <div class="full">${input('title', '회의 제목 *', row.title, `required maxlength="200" ${off}`)}</div>
      ${input('meeting_date', '회의 날짜 *', row.meeting_date, `type="date" required ${off}`)}
      <div class="meeting-times">${input('start_time', '시작 시간', row.start_time, `type="time" ${off}`)}${input('end_time', '종료 시간', row.end_time, `type="time" ${off}`)}</div>
      ${input('location', '장소', row.location, `maxlength="200" ${off}`)}
      ${input('attendees', '참석자', row.attendees, `maxlength="2000" placeholder="예: 홍길동, 김철수(고객사)" ${off}`)}
      <label class="full">회의 내용<textarea name="content" class="meeting-content" maxlength="50000" ${off}>${esc(row.content)}</textarea></label>
      <label class="full">결정 사항<textarea name="decisions" class="meeting-decisions" maxlength="20000" ${off}>${esc(row.decisions)}</textarea></label>
      </div>${id ? `<p class="help-line">작성 ${esc(row.created_by_name ?? '')} · ${esc(fmt(row.created_at))} / 최근 수정 ${esc(row.updated_by_name ?? '')} · ${esc(fmt(row.updated_at))}</p>` : ''}
      ${editable ? `<div class="form-actions"><button type="button" data-action="close">${id ? '닫기' : '취소'}</button>${id ? `<button type="button" class="danger" data-action="meeting-delete" data-id="${row.id}">삭제</button>` : ''}<button class="primary">저장</button></div>` : ''}</form>
      ${id ? `<section class="subsection"><h3>후속 조치 <small>${data.actions.filter(a => !a.done_at).length}건 미완료 / 전체 ${data.actions.length}건</small></h3>${actions || '<p class="muted">등록된 후속 조치가 없습니다.</p>'}${editable ? `<form id="meeting-action-form" class="meeting-action-form">${input('task', '할 일 *', '', 'required maxlength="500"')}${input('owner', '담당자', '', 'maxlength="100"')}${input('due_date', '기한', '', 'type="date"')}<button class="primary">추가</button></form>` : ''}</section>
      <section class="subsection meeting-files" data-meeting-drop="${row.id}"><h3>첨부파일 <small>${data.files.length}개</small></h3>${files || '<p class="muted">첨부파일이 없습니다.</p>'}${editable ? `<form class="upload" id="meeting-upload"><input aria-label="첨부할 파일" type="file" name="file" multiple required><button type="submit">파일 첨부</button></form><p class="help-line">파일을 이 영역에 끌어 놓아도 첨부됩니다.</p>` : ''}</section>`
      : '<p class="save-note">저장한 뒤 목록에서 회의록을 다시 열면 후속 조치와 첨부파일을 등록할 수 있습니다.</p>'}`);
    if (keep) { const form = modal.querySelector('#meeting-form'); for (const [key, value] of Object.entries(keep)) if (form.elements[key] && String(previous[key] ?? '') !== value) form.elements[key].value = value; }
    if (scroll) modal.scrollTop = scroll;
  }

  async function uploadFiles(files) {
    const meetingId = meetingState.selected?.id;
    if (!meetingId) throw new Error('회의록을 먼저 저장해 주세요.');
    let count = 0;
    for (const file of files) { const body = new FormData(); body.append('file', file); await api(`/meetings/${meetingId}/files`, { method: 'POST', body }); count++; }
    await meetingDialog(meetingId); await renderMeetings();
    toast(`첨부파일 ${count}개를 등록했습니다.`);
  }
  // 끌어 놓기: 회의록 상세 창의 첨부파일 영역
  const dropTarget = target => canEdit() && modal.open ? target.closest?.('[data-meeting-drop]') ?? null : null;

  async function action(name, id) {
    switch (name) {
      case 'meeting-new': await meetingDialog(null); return true;
      case 'meeting-open': await meetingDialog(id); return true;
      case 'meeting-reset': meetingState.filters = {}; meetingState.page = 1; await renderMeetings(); return true;
      case 'meeting-prev': case 'meeting-next': meetingState.page = Math.max(1, meetingState.page + (name === 'meeting-prev' ? -1 : 1)); await renderMeetings(); return true;
      case 'meeting-delete': if (confirm('이 회의록과 후속 조치·첨부파일을 모두 삭제할까요? 되돌릴 수 없습니다.')) { await api('/meetings/' + id, { method: 'DELETE' }); modal.close(); await renderMeetings(); toast('회의록을 삭제했습니다.'); } return true;
      case 'meeting-action-delete': if (confirm('이 후속 조치를 삭제할까요?')) { await api('/meeting-actions/' + id, { method: 'DELETE' }); await meetingDialog(meetingState.selected.id); await renderMeetings(); } return true;
      case 'meeting-file-delete': if (confirm('첨부파일을 삭제할까요?')) { await api('/meeting-files/' + id, { method: 'DELETE' }); await meetingDialog(meetingState.selected.id); await renderMeetings(); toast('첨부파일을 삭제했습니다.'); } return true;
      default: return false;
    }
  }
  async function change(target) {
    if (target.dataset.action !== 'meeting-action-toggle') return false;
    await api('/meeting-actions/' + target.dataset.id, { method: 'PUT', body: { done: target.checked } });
    await meetingDialog(meetingState.selected.id); await renderMeetings(); return true;
  }
  async function submit(form, values) {
    switch (form.id) {
      case 'meeting-filter':
        if (values.from && values.to && values.from > values.to) throw new Error('종료일은 시작일 이후로 설정해 주세요.');
        meetingState.filters = Object.fromEntries(Object.entries(values).filter(([, value]) => value)); meetingState.page = 1; await renderMeetings(); return true;
      case 'meeting-form': {
        const row = meetingState.selected;
        const saved = await api('/meetings' + (row.id ? '/' + row.id : ''), { method: row.id ? 'PUT' : 'POST', body: { ...values, version: row.version } });
        // 저장하면 창을 닫고 목록을 새로 고친다. 후속 조치·첨부는 목록에서 회의록을 다시 열어 추가한다.
        modal.close(); await renderMeetings();
        toast(row.id ? '회의록을 저장했습니다.' : `회의록을 저장했습니다. 목록에서 '${saved.meeting.title}'을(를) 열면 후속 조치와 첨부파일을 추가할 수 있습니다.`); return true;
      }
      case 'meeting-action-form': await api(`/meetings/${meetingState.selected.id}/actions`, { method: 'POST', body: values }); await meetingDialog(meetingState.selected.id); await renderMeetings(); modal.querySelector('#meeting-action-form input[name="task"]')?.focus(); return true;
      case 'meeting-upload': await uploadFiles([...form.elements.file.files]); return true;
      default: return false;
    }
  }
  return { renderMeetings, action, change, submit, uploadFiles, dropTarget };
}
