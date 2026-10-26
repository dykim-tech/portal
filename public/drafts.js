// 업무기안: 목록(검색·상태) + 기안 창(제목·기안일·기안자·상태·내용) + 참고 링크·첨부파일 + 문서로 저장(PDF·Word·한글).
// 모든 사용자가 열람하고 편집자·관리자만 작성·수정·삭제한다. 상태가 '작성 중'이 아니면 문서로 저장할 수 있다.
export function createDrafts({ api, esc, state, canEdit, openDialog, input, toast, fmt, modal }) {
  const draftState = { filters: {}, page: 1, selected: null };
  const statuses = { writing: '작성 중', done: '완료' };
  const formats = [['pdf', 'PDF (.pdf)'], ['docx', 'Word (.docx)'], ['hwpx', '한글 (.hwpx)']];
  const formatKey = () => `portal-draft-format-${state.user?.id ?? ''}`;
  const savedFormat = () => { try { const value = localStorage.getItem(formatKey()); return formats.some(([key]) => key === value) ? value : 'pdf'; } catch { return 'pdf'; } };
  const fileSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(0.1, n / 1024).toFixed(1) + ' KB';
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const badge = value => `<span class="badge draft-status draft-status-${value}">${statuses[value] ?? value}</span>`;
  const options = (selected, blank) => (blank ? `<option value="">${blank}</option>` : '') + Object.entries(statuses).map(([key, label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`).join('');
  const host = url => { try { return new URL(url).hostname; } catch { return url; } };
  // 메일 발송 결과(읽음·접수 여부는 확인하지 않는다)
  const mailState = { queued: '발송 대기', sent: '발송 완료', failed: '발송 실패', canceled: '발송 취소' };
  const person = (contacts, email) => { const c = contacts.find(item => item.email === email); return c ? `${c.name} (${c.email})` : email; };

  async function renderDrafts() {
    const f = draftState.filters;
    const data = await api('/drafts?' + new URLSearchParams({ ...f, page: draftState.page }));
    if (state.view !== 'drafts') return;
    const pages = Math.max(1, Math.ceil(data.total / data.page_size)), filtered = Object.keys(f).length > 0;
    const rows = data.drafts.map(row => `<tr><td class="draft-doc-no">${esc(row.doc_no ?? '')}</td><td class="draft-date">${esc(row.draft_date)}</td><td><button class="link-button" data-action="draft-open" data-id="${row.id}">${esc(row.title)}</button></td><td>${esc(row.drafter) || '—'}</td><td>${badge(row.status)}</td><td>${row.file_count ? row.file_count + '개' : '—'}</td><td>${row.link_count ? row.link_count + '개' : '—'}</td><td>${esc(fmt(row.updated_at))}<span class="secondary-line">${esc(row.updated_by_name ?? '')}</span></td>${canEdit() ? `<td><button type="button" class="small danger" data-action="draft-delete" data-id="${row.id}" data-title="${esc(row.title)}" aria-label="기안 삭제: ${esc(row.title)}">삭제</button></td>` : ''}</tr>`).join('');
    const total = Object.values(data.counts).reduce((sum, n) => sum + n, 0);
    document.querySelector('#content').innerHTML = `<h1 class="sr-only">업무기안</h1>${canEdit() ? '<div class="page-head page-head-actions"><button class="primary" data-action="draft-new">＋ 기안 작성</button></div>' : ''}
      <div class="project-stats draft-stats">${[['전체', total], ...Object.entries(statuses).map(([key, label]) => [label, data.counts[key] ?? 0])].map(([label, n]) => `<div class="project-stat"><small>${label}</small><strong>${n}건</strong></div>`).join('')}</div>
      <section class="panel"><div class="panel-head"><h2>업무기안 <small>${data.total}건</small></h2><small>기안일 최신순</small></div>
      <form id="draft-filter" class="filters draft-filters"><label>검색<input name="q" placeholder="문서번호, 제목, 기안자, 내용" value="${esc(f.q)}"></label><label>상태<select name="status">${options(f.status, '전체 상태')}</select></label><button class="primary">조회</button><button type="button" data-action="draft-reset">초기화</button></form>
      ${rows ? `<div class="table-wrap"><table class="drafts-table"><thead><tr><th>문서번호</th><th>기안일</th><th>제목</th><th>기안자</th><th>상태</th><th>첨부</th><th>링크</th><th>최근 수정</th>${canEdit() ? '<th>관리</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><h3>${filtered ? '검색 결과가 없습니다' : '아직 작성한 기안이 없습니다'}</h3><p>${filtered ? '검색어나 상태를 바꿔 보세요.' : '기안 내용을 입력하고 자료를 첨부해 보세요. 완료 후 PDF·Word·한글 문서로 저장할 수 있습니다.'}</p>${canEdit() && !filtered ? '<button data-action="draft-new">첫 기안 작성</button>' : ''}</div>`}
      <div class="footer-row"><span>${data.total}건</span><div class="pager"><button class="small" data-action="draft-prev" ${data.page <= 1 ? 'disabled' : ''}>이전</button><span>${data.page} / ${pages}</span><button class="small" data-action="draft-next" ${data.page >= pages ? 'disabled' : ''}>다음</button></div></div></section>`;
  }

  // 같은 기안 창을 다시 그릴 때(링크·첨부 추가 후) 저장하지 않은 입력과 스크롤 위치를 유지한다.
  const checkedCc = form => [...form.querySelectorAll('input[name="cc"]:checked')].map(box => box.value);
  const unsaved = () => { const form = modal.open && modal.querySelector('#draft-form'); if (!form) return null; const values = Object.fromEntries(new FormData(form)); delete values.cc; values.cc_emails = checkedCc(form); return values; };
  const sameList = (a, b) => [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');
  const changed = (values, row) => values && (['title', 'draft_date', 'drafter', 'status', 'content', 'approver_email'].some(key => key in values && String(values[key] ?? '') !== String(row[key] ?? '')) || ('cc_emails' in values && !sameList(values.cc_emails, row.cc_emails)));
  async function draftDialog(id) {
    const same = id && draftState.selected?.id === Number(id), keep = same ? unsaved() : null, previous = same ? draftState.selected : null, scroll = same ? modal.scrollTop : 0;
    const [data, contactData] = await Promise.all([id ? api('/drafts/' + id) : { draft: { title: '', draft_date: today(), drafter: state.user?.name ?? '', status: 'writing', content: '', approver_email: '', cc_emails: [] }, links: [], files: [], mails: [] }, api('/draft-contacts')]);
    const row = data.draft; draftState.selected = row;
    // 목록에서 빠진 계정이 이미 저장돼 있으면 그대로 보여 준다.
    const contacts = [...contactData.contacts];
    for (const email of [row.approver_email, ...(row.cc_emails ?? [])]) if (email && !contacts.some(c => c.email === email)) contacts.push({ email, name: email + ' (목록에 없음)' });
    const editable = canEdit(), off = editable ? '' : 'disabled';
    const links = data.links.map(link => `<div class="file-row"><div><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.name)} ↗</a><span class="secondary-line">${esc(link.url)}</span></div><div class="file-actions">${editable ? `<button type="button" class="small danger" data-action="draft-link-delete" data-id="${link.id}" aria-label="링크 삭제: ${esc(link.name)}">삭제</button>` : `<span class="muted">${esc(host(link.url))}</span>`}</div></div>`).join('');
    const files = data.files.map(file => `<div class="file-row"><div><strong>${esc(file.name)}</strong><span class="secondary-line">${fileSize(file.size)} · ${esc(fmt(file.created_at))}</span></div><div class="file-actions"><a href="/api/draft-files/${file.id}/download">다운로드</a>${editable ? `<button type="button" class="small danger" data-action="draft-file-delete" data-id="${file.id}">삭제</button>` : ''}</div></div>`).join('');
    const exportable = row.status !== 'writing';
    openDialog(id ? '업무기안' : '기안 작성', `<form id="draft-form" class="draft-form"><div class="form-grid">
      <div class="full draft-doc-line"><span>문서번호</span><strong>${row.doc_no ? esc(row.doc_no) : '저장하면 자동으로 매겨집니다 (GRACECNS-RQ-기안일-순번)'}</strong></div>
      <div class="full">${input('title', '제목 *', row.title, `required maxlength="200" ${off}`)}</div>
      ${input('draft_date', '기안일 *', row.draft_date, `type="date" required ${off}`)}
      ${input('drafter', '기안자', row.drafter, `maxlength="100" ${off}`)}
      <label>상태<select name="status" ${off}>${options(row.status)}</select></label>
      <label>승인 요청자<select name="approver_email" ${off}><option value="">선택 안 함</option>${contacts.map(c => `<option value="${esc(c.email)}" ${c.email === row.approver_email ? 'selected' : ''}>${esc(c.name)} · ${esc(c.email)}</option>`).join('')}</select></label>
      <fieldset class="full draft-cc"><legend>CC (참조)</legend><div class="draft-cc-list">${contacts.map(c => `<label class="draft-cc-item"><input type="checkbox" name="cc" value="${esc(c.email)}" ${(row.cc_emails ?? []).includes(c.email) ? 'checked' : ''} ${c.email === row.approver_email || !editable ? 'disabled' : ''}><span>${esc(c.name)}<small>${esc(c.email)}</small></span></label>`).join('')}</div></fieldset>
      <label class="full">내용<textarea name="content" class="draft-content" maxlength="50000" ${off}>${esc(row.content)}</textarea></label>
      </div>${id ? `<p class="help-line">작성 ${esc(row.created_by_name ?? '')} · ${esc(fmt(row.created_at))} / 최근 수정 ${esc(row.updated_by_name ?? '')} · ${esc(fmt(row.updated_at))}</p>` : ''}
      ${editable ? `<div class="form-actions"><button type="button" data-action="close">${id ? '닫기' : '취소'}</button>${id ? `<button type="button" class="danger" data-action="draft-delete" data-id="${row.id}">삭제</button>` : ''}<button class="primary">저장</button></div>` : ''}</form>
      ${id ? mailSection(data, contacts) : ''}
      ${id ? `<section class="subsection draft-export"><h3>문서로 저장</h3>${exportable ? `<div class="draft-export-row"><label>저장 형식<select id="draft-export-format">${formats.map(([key, label]) => `<option value="${key}" ${key === savedFormat() ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button type="button" class="primary" data-action="draft-export" data-id="${row.id}">문서로 저장</button></div><p class="help-line">제목·기안일·기안자·내용과 첨부파일 목록, 참고 링크가 문서에 들어갑니다. 첨부파일 자체는 위 목록에서 따로 내려받으세요.</p>` : `<p class="muted">상태가 '작성 중'이면 문서로 저장할 수 없습니다. 작성을 마치면 상태를 '완료'로 바꿔 저장한 뒤 다시 열어 주세요.</p>`}</section>
      <section class="subsection"><h3>참고 링크 <small>${data.links.length}개</small></h3>${links || '<p class="muted">등록된 링크가 없습니다.</p>'}${editable ? `<form id="draft-link-form" class="draft-link-form">${input('name', '링크 이름', '', 'maxlength="200" placeholder="비우면 주소로 표시"')}${input('url', '주소 (URL) *', '', 'required maxlength="2000" placeholder="https://"')}<button class="primary">추가</button></form>` : ''}</section>
      <section class="subsection draft-files" data-draft-drop="${row.id}"><h3>첨부파일 <small>${data.files.length}개</small></h3>${files || '<p class="muted">첨부파일이 없습니다.</p>'}${editable ? `<form class="upload" id="draft-upload"><input aria-label="첨부할 파일" type="file" name="file" multiple required><button type="submit">파일 첨부</button></form><p class="help-line">파일을 이 영역에 끌어 놓아도 첨부됩니다.</p>` : ''}</section>`
      : '<p class="save-note">저장한 뒤 목록에서 기안을 다시 열면 참고 링크와 첨부파일을 등록하고, 완료 후 문서로 저장할 수 있습니다.</p>'}`);
    if (keep && changed(keep, previous)) {
      const form = modal.querySelector('#draft-form');
      for (const [key, value] of Object.entries(keep)) if (key !== 'cc_emails' && form.elements[key] && String(previous[key] ?? '') !== value) form.elements[key].value = value;
      if (!sameList(keep.cc_emails, previous.cc_emails)) for (const box of form.querySelectorAll('input[name="cc"]')) box.checked = keep.cc_emails.includes(box.value);
      change(form.elements.approver_email);
    }
    if (scroll) modal.scrollTop = scroll;
  }

  // 메일 발송 기록(간단히): 시각 · 받는 사람 · CC · 결과
  function mailSection(data, contacts) {
    const mails = data.mails ?? [];
    if (!mails.length) return '';
    const helperOff = !data.mail_helper?.running && mails.some(m => m.status === 'queued');
    const rows = mails.map(m => { const to = m.recipients.filter(r => r.kind === 'to').map(r => person(contacts, r.email)), cc = m.recipients.filter(r => r.kind === 'cc').map(r => person(contacts, r.email));
      return `<li><span class="badge mail-state-${m.status}">${mailState[m.status] ?? m.status}</span> ${esc(fmt(m.sent_at ?? m.created_at))} · 받는 사람 ${esc(to.join(', '))}${cc.length ? ` · CC ${esc(cc.join(', '))}` : ''}${m.error ? `<span class="error-text">${esc(m.error)}</span>` : ''}</li>`; }).join('');
    return `<section class="subsection draft-mail"><h3>메일 발송 기록 <small>${mails.length}건</small></h3>${helperOff ? '<p class="error-text">Outlook 발송 도우미가 꺼져 있어 대기 중인 메일은 이 PC에 로그인하면 발송됩니다.</p>' : ''}<ul class="mail-history">${rows}</ul></section>`;
  }

  // 승인 요청자를 고르면 같은 사람은 CC에서 뺀다.
  function change(target) {
    if (target?.name !== 'approver_email' || !target.closest?.('#draft-form')) return false;
    for (const box of target.form.querySelectorAll('input[name="cc"]')) { const self = box.value === target.value; if (self) box.checked = false; box.disabled = self || !canEdit(); }
    return true;
  }

  async function uploadFiles(files) {
    const draftId = draftState.selected?.id;
    if (!draftId) throw new Error('기안을 먼저 저장해 주세요.');
    let count = 0;
    for (const file of files) { const body = new FormData(); body.append('file', file); await api(`/drafts/${draftId}/files`, { method: 'POST', body }); count++; }
    await draftDialog(draftId); await renderDrafts();
    toast(`첨부파일 ${count}개를 등록했습니다.`);
  }
  const dropTarget = target => canEdit() && modal.open ? target.closest?.('[data-draft-drop]') ?? null : null;

  // 문서 저장: 오류(작성 중, 글꼴 없음 등)를 창 안에 보여 주기 위해 fetch로 받아 내려받기를 시작한다.
  async function exportDraft(id, button) {
    if (changed(unsaved(), draftState.selected)) throw new Error('저장하지 않은 변경 내용이 있습니다. 먼저 저장한 뒤 문서로 저장해 주세요.');
    const format = modal.querySelector('#draft-export-format')?.value ?? 'pdf';
    try { localStorage.setItem(formatKey(), format); } catch {}
    button.disabled = true; const label = button.textContent; button.textContent = '만드는 중…';
    try {
      const response = await fetch(`/api/drafts/${Number(id)}/export?format=${encodeURIComponent(format)}`, { headers: { 'X-Portal-Request': '1' }, cache: 'no-store' });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || '문서를 만들지 못했습니다.'); }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const name = encoded ? decodeURIComponent(encoded) : `업무기안.${format}`;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = name; link.hidden = true; document.body.append(link); link.click();
      setTimeout(() => link.remove(), 1000);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast(`${name} 파일을 저장했습니다.`);
    } finally { if (button.isConnected) { button.disabled = false; button.textContent = label; } }
  }

  async function action(name, id, button) {
    switch (name) {
      case 'draft-new': await draftDialog(null); return true;
      case 'draft-open': await draftDialog(id); return true;
      case 'draft-reset': draftState.filters = {}; draftState.page = 1; await renderDrafts(); return true;
      case 'draft-prev': case 'draft-next': draftState.page = Math.max(1, draftState.page + (name === 'draft-prev' ? -1 : 1)); await renderDrafts(); return true;
      case 'draft-delete': if (confirm(`${button?.dataset.title ? `'${button.dataset.title}' ` : '이 '}기안과 참고 링크·첨부파일, 메일 발송 기록을 모두 삭제할까요? 되돌릴 수 없습니다.`)) { await api('/drafts/' + id, { method: 'DELETE' }); modal.close(); await renderDrafts(); toast('기안을 삭제했습니다.'); } return true;
      case 'draft-link-delete': if (confirm('이 링크를 삭제할까요?')) { await api('/draft-links/' + id, { method: 'DELETE' }); await draftDialog(draftState.selected.id); await renderDrafts(); } return true;
      case 'draft-file-delete': if (confirm('첨부파일을 삭제할까요?')) { await api('/draft-files/' + id, { method: 'DELETE' }); await draftDialog(draftState.selected.id); await renderDrafts(); toast('첨부파일을 삭제했습니다.'); } return true;
      case 'draft-export': await exportDraft(id, button); return true;
      default: return false;
    }
  }
  async function submit(form, values) {
    switch (form.id) {
      case 'draft-filter': draftState.filters = Object.fromEntries(Object.entries(values).filter(([, value]) => value)); draftState.page = 1; await renderDrafts(); return true;
      case 'draft-form': {
        const row = draftState.selected;
        const body = { ...values, cc_emails: checkedCc(form), version: row.version }; delete body.cc;
        // 승인 요청자가 있으면 저장 전에 메일 발송 여부를 묻는다. '확인' → 저장 후 발송(발송되면 상태가 '완료'), '취소' → 저장만.
        const send = Boolean(body.approver_email) && confirm('해당 내용으로 기안 메일을 발송하시겠습니까?');
        const saved = await api('/drafts' + (row.id ? '/' + row.id : ''), { method: row.id ? 'PUT' : 'POST', body });
        let mail = null;
        if (send) mail = await api(`/drafts/${saved.draft.id}/mail`, { method: 'POST', body: { version: saved.draft.version } });
        // 저장하면 창을 닫고 목록을 새로 고친다(회의록과 같은 동작).
        modal.close(); await renderDrafts();
        toast(mail ? (mail.mail_helper?.running ? '저장했습니다. Outlook으로 기안 메일을 보내는 중입니다(보내면 상태가 완료로 바뀝니다).' : '저장했습니다. Outlook 발송 도우미가 꺼져 있어 이 PC에 로그인하면 메일이 발송됩니다.')
          : body.approver_email ? '저장했습니다. 메일은 보내지 않았습니다.' : '저장했습니다. 메일을 보내려면 승인 요청자를 골라 저장하세요.'); return true;
      }
      case 'draft-link-form': await api(`/drafts/${draftState.selected.id}/links`, { method: 'POST', body: values }); await draftDialog(draftState.selected.id); await renderDrafts(); toast('링크를 추가했습니다.'); return true;
      case 'draft-upload': await uploadFiles([...form.elements.file.files]); return true;
      default: return false;
    }
  }
  return { renderDrafts, action, submit, uploadFiles, dropTarget, change };
}
