export function createExtras(ctx) {
  const { api, esc, state, features, canEdit, openDialog, input, toast, fmt, pageHead, renderItems, renderInstallations, renderView } = ctx;
  const cache = { items: [], installations: [] };
  const work = { customer: null, customers: [], page: 1, filters: {}, selected: null, selectedCustomer: null };
  const report = { from: '', to: '' };
  const levelNames = ['대분류', '중분류', '소분류'];
  const workStatus = { planned: '예정', progress: '진행 중', done: '완료', hold: '보류' };

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
  async function renderWork() {
    const [customers, result] = await Promise.all([
      api('/customers'),
      api('/work-logs?' + new URLSearchParams({ ...work.filters, customer_id: work.customer ?? '', page: work.page }))
    ]);
    if (state.view !== 'work') return;
    work.customers = customers.customers;
    const f = work.filters;
    const customerOptions = `<option value="">전체 고객</option>${work.customers.map(c => `<option value="${c.id}" ${Number(work.customer) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
    document.querySelector('#content').innerHTML =
      pageHead('CUSTOMER WORK LOG', '업무관리', '고객별 업무일지를 기록하고 진행 상황을 확인하세요.',
        canEdit() ? '<div class="head-actions"><button data-action="customer-new">＋ 고객 등록</button><button class="primary" data-action="work-new">＋ 업무일지 작성</button></div>' : '') +
      `<section class="panel classified-panel"><aside class="classified-sidebar"><div class="category-title">고객</div><button class="category-link ${work.customer === null ? 'selected' : ''}" data-action="work-customer">전체 고객</button>${work.customers.map(c => `<button class="category-link ${Number(work.customer) === c.id ? 'selected' : ''}" data-action="work-customer" data-id="${c.id}">${esc(c.name)} <small>${c.log_count}건</small></button>`).join('')}${canEdit() && work.customer ? '<div class="category-actions"><button class="small" data-action="customer-edit" data-id="' + work.customer + '">고객 정보 수정</button></div>' : ''}</aside><div class="classified-main"><div class="panel-head"><h2>업무일지 <small>${result.total}건</small></h2></div><form id="work-filter" class="filters"><label>검색<input name="q" placeholder="고객, 제목, 담당자, 업무 내용" value="${esc(f.q)}"></label><label>상태<select name="status"><option value="">모든 상태</option>${Object.entries(workStatus).map(([key, value]) => `<option value="${key}" ${f.status === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>시작일<input name="from" type="date" value="${esc(f.from)}"></label><label>종료일<input name="to" type="date" value="${esc(f.to)}"></label><button class="primary">조회</button><button type="button" data-action="work-reset">초기화</button></form>${result.logs.length ? `<div class="table-wrap"><table><thead><tr><th>업무일</th><th>고객</th><th>제목</th><th>담당자</th><th>상태</th><th>최근 수정</th></tr></thead><tbody>${result.logs.map(row => `<tr><td>${esc(row.work_date)}</td><td>${esc(row.customer_name)}</td><td><button class="link-button" data-action="work-log" data-id="${row.id}">${esc(row.title)}</button></td><td>${esc(row.owner) || '—'}</td><td><span class="badge">${workStatus[row.status]}</span></td><td>${fmt(row.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>표시할 업무일지가 없습니다</h3><p>고객을 선택해 업무 내용을 등록하거나 검색 조건을 바꿔 보세요.</p></div>'}<div class="footer-row"><span>${result.total}건</span><div class="pager"><button class="small" data-action="work-prev" ${work.page <= 1 ? 'disabled' : ''}>이전</button><span>${work.page} / ${Math.max(1, Math.ceil(result.total / 25))}</span><button class="small" data-action="work-next" ${work.page >= Math.ceil(result.total / 25) ? 'disabled' : ''}>다음</button></div></div></div></section>`;
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
    const choices = work.customers.filter(c => c.active || c.id === row.customer_id).map(c => `<option value="${c.id}" ${c.id === Number(row.customer_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    openDialog(id ? '업무일지 상세' : '업무일지 작성', `<form id="work-form"><div class="form-grid"><label>고객 *<select name="customer_id" required ${disabled}><option value="">고객을 선택하세요</option>${choices}</select></label>${input('work_date', '업무일 *', row.work_date, 'type="date" required ' + disabled)}${input('title', '제목 *', row.title, 'required maxlength="150" ' + disabled)}${input('owner', '담당자', row.owner, 'maxlength="100" ' + disabled)}<label>진행 상태<select name="status" ${disabled}>${Object.entries(workStatus).map(([key, value]) => `<option value="${key}" ${row.status === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="full">업무 내용<textarea name="content" maxlength="10000" ${disabled}>${esc(row.content)}</textarea></label></div>${canEdit() ? '<div class="form-actions"><button type="button" data-action="close">취소</button><button class="primary">저장</button></div>' : ''}</form>`);
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
    if (action === 'customer-new' || action === 'customer-edit') { customerDialog(id); return true; }
    if (action === 'work-new' || action === 'work-log') { await workDialog(id); return true; }
    if (action === 'work-prev' || action === 'work-next') { work.page += action === 'work-prev' ? -1 : 1; await renderWork(); return true; }
    if (action === 'work-reset') { work.filters = {}; work.customer = null; work.page = 1; await renderWork(); return true; }
    if (action === 'report-reset') { report.from = ''; report.to = ''; await renderReports(); return true; }
    return false;
  }
  async function submit(form, values) {
    if (form.id === 'category-form') {
      const scope = form.dataset.scope, categoryId = form.dataset.id;
      if (categoryId) await api('/categories/' + categoryId, { method: 'PUT', body: { scope, name: values.name } });
      else await api('/categories', { method: 'POST', body: { scope, name: values.name, parent_id: values.parent_id || null } });
      modal.close(); await loadCategories(scope); await renderView(); toast('분류를 저장했습니다.'); return true;
    }
    if (form.id === 'customer-form') {
      const c = work.selectedCustomer;
      await api('/customers' + (c.id ? '/' + c.id : ''), { method: c.id ? 'PUT' : 'POST', body: { ...values, active: c.id ? form.elements.active.checked : true } });
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
  return { loadCategories, categoryPath, leafSelect, attachCategoryPanel, renderWork, renderReports, action, submit };
}
