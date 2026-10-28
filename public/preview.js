// 새 첫 화면(포털형) 미리보기 — 1단계(2026-10-28).
// 실제 포털 화면은 바꾸지 않고, 로그인한 사용자의 실제 데이터(API)로 새 배치만 보여 준다.
// 메뉴·바로가기는 기존 포털 화면(/#view=...)으로 이동한다. 통합 검색은 기존 목록 API를 함께 불러 묶어 보여 준다(3단계에서 서버 통합 검색으로 바꿀 예정).
const root = document.querySelector('#preview');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function api(path) {
  const response = await fetch('/api' + path, { headers: { 'X-Portal-Request': '1' }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? '요청을 처리하지 못했습니다.'), { status: response.status });
  return data;
}
const view = id => `/#view=${id}`;
const size = n => { if (n == null) return '—'; n = Number(n) || 0; return n >= 1024 ** 4 ? (n / 1024 ** 4).toFixed(2) + ' TB' : n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'; };
const tib = n => { if (n == null) return '—'; n = Number(n) || 0; return n >= 1024 ** 4 ? (n / 1024 ** 4).toFixed(2) + ' TiB' : (n / 1024 ** 3).toFixed(2) + ' GiB'; };
const icon = name => {
  const paths = {
    meetings: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h5"/>',
    drafts: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h6M10 16h6"/>',
    work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12h18"/>',
    library: '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h6l2 2"/>',
    installations: '<path d="M14 6l4 4-8 8H6v-4z"/><path d="M12 8l4 4"/>',
    todos: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    pen: '<path d="M5 19l1-4 10-10 3 3-10 10z"/><path d="M14 7l3 3"/>',
  };
  return `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
};
const external = (label, url, newTab = true) => `<a href="${esc(url)}" ${newTab ? 'target="_blank" rel="noopener noreferrer"' : ''}>${esc(label)}${newTab ? ' <small>↗</small>' : ''}</a>`;

function navGroups(user) {
  const hidden = new Set(user.hidden_menus ?? []), shown = id => !hidden.has(id);
  const groups = [
    ['업무', [['meetings', '회의록'], ['drafts', '업무기안'], ['work', '업무관리'], ['todos', 'TO-DO List']]],
    ['설치·자산', [['installations', '설치관리'], ['projects', '프로젝트 관리'], ['items', '자산 관리']]],
    ['자료·리포트', [['library', '자료 관리'], ['reports', '리포트']]],
  ].map(([title, items]) => [title, items.filter(([id]) => shown(id)).map(([id, label]) => `<a href="${view(id)}">${esc(label)}</a>`)]);
  const shortcuts = [];
  if (shown('tools')) shortcuts.push(`<a href="${view('tools')}">도구</a>`);
  if (shown('outlook')) shortcuts.push(external('Mail (Outlook)', 'portal-outlook:open', false));
  if (shown('gracecns')) shortcuts.push(external('GRACECNS', 'http://gracecns.com/'));
  if (shown('nas')) shortcuts.push(external('NAS', 'https://dykim-nas.duckdns.org/'), external('OMV NAS 관리자', 'https://omv.dykim-nas.duckdns.org/'), external('LOGIN NAS 관리자', 'https://login.dykim-nas.duckdns.org/'));
  groups.push(['바로가기', shortcuts]);
  const manage = [`<a href="${view('settings')}">설정</a>`];
  if (user.role === 'admin') manage.push(...[['users', '사용자 관리'], ['backups', '백업/복구'], ['operations', '운영관리'], ['usage', '사용량 관리']].map(([id, label]) => `<a href="${view(id)}">${label}</a>`));
  groups.push([user.role === 'admin' ? '관리' : '설정', manage]);
  return groups.filter(([, items]) => items.length).map(([title, items]) => `<div class="pv-menu"><button type="button" aria-haspopup="true">${esc(title)}</button><div class="pv-sub">${items.join('')}</div></div>`).join('');
}

const tiles = [
  ['meetings', '회의록', '회의 기록·결정 사항'], ['drafts', '업무기안', '기안 작성·메일 발송'], ['work', '업무관리', '고객별 업무일지'],
  ['library', '자료 관리', '매뉴얼·링크·파일'], ['installations', '설치관리', '설치 이력·엔지니어'], ['todos', 'TO-DO List', '오늘의 할 일 메모'],
];

function panel(title, link, body) { return `<section class="pv-panel"><div class="pv-panel-head"><h3>${esc(title)}</h3>${link ? `<a href="${link[0]}">${esc(link[1])} →</a>` : ''}</div>${body}</section>`; }
const empty = text => `<p class="pv-empty">${esc(text)}</p>`;

function render(user, d, usage, leave, nas) {
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const memo = row => row.locked ? '🔒 잠긴 메모' : ([row.title, row.body].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || '내용 없는 메모');
  const todos = d.openTodos.length ? `<ul class="pv-list">${d.openTodos.slice(0, 6).map(row => `<li><a href="${view('todos')}">${esc(memo(row).slice(0, 60))}</a><span class="pv-tag ${row.target_date < d.today ? 'late' : row.target_date === d.today ? 'today' : ''}">${row.target_date < d.today ? '지난 날짜' : row.target_date === d.today ? '오늘' : esc(row.target_date)}</span></li>`).join('')}</ul>` : empty('완료하지 않은 할 일이 없습니다.');
  const work = d.recentWork.length ? `<ul class="pv-list">${d.recentWork.slice(0, 6).map(row => `<li><a href="${view('work')}">${esc(row.title)}<small>${esc(row.customer_name)} · ${esc(row.work_date)}</small></a><span class="pv-tag">${esc(row.status)}</span></li>`).join('')}</ul>` : empty('최근 일주일 업무일지가 없습니다.');
  const projects = d.recentProjects.length ? `<ul class="pv-list">${d.recentProjects.map(row => `<li><a href="${view('projects')}">${esc(row.name)}<small>${esc(row.customer || '고객사 미지정')} · ${esc(row.planned_start || '—')} ~ ${esc(row.planned_end || '—')}</small></a></li>`).join('')}</ul>` : empty('등록된 프로젝트가 없습니다.');
  const panels = [panel(`오늘의 할 일 · 미완료 ${d.openTodoCount}건`, [view('todos'), 'TO-DO List'], todos), panel('최근 일주일 업무관리', [view('work'), '업무관리'], work), panel('최근 프로젝트', [view('projects'), '프로젝트 관리'], projects)];
  if (usage) {
    const drive = usage.drives?.[0] ?? {}, rate = drive.total ? Math.round(drive.used / drive.total * 1000) / 10 : 0;
    panels.push(panel('저장소 사용량', [view('usage'), '사용량 관리'], drive.total ? `<div class="pv-meter"><div class="pv-meter-head"><strong>${esc(drive.root)} 드라이브 ${rate}%</strong><span>여유 ${size(drive.free)}</span></div><progress class="${rate >= 90 ? 'danger' : ''}" max="100" value="${rate}"></progress><small>${size(drive.used)} 사용 / 전체 ${size(drive.total)}</small></div>` : empty('드라이브 정보를 읽지 못했습니다.')));
  }
  if (nas?.configured && !nas.error) {
    const disks = (nas.filesystems?.items ?? []).filter(f => f.size).sort((a, b) => b.size - a.size).slice(0, 2);
    panels.push(panel('NAS 현황', ['/#view=dashboard', '자세히'], disks.map(f => { const pct = f.percentage ?? Math.round((f.size - f.available) / f.size * 100); return `<div class="pv-meter"><div class="pv-meter-head"><strong>${esc(f.alias || f.name)} ${pct}%</strong><span>여유 ${tib(f.available)}</span></div><progress max="100" value="${pct}"></progress></div>`; }).join('') + `<small class="pv-muted">공유 볼륨 ${nas.shares?.items?.length ?? 0}개 · 사용자 ${nas.users?.items?.length ?? 0}명</small>`));
  }
  if (leave?.configured && !leave.error) {
    panels.push(panel(`휴가 현황 · ${leave.employee}`, ['/#view=dashboard', '자세히'], `<dl class="pv-figures"><div><dt>연간 연차</dt><dd>${leave.annual_days ?? '—'}</dd></div><div><dt>사용</dt><dd>${leave.used_days ?? '—'}</dd></div><div><dt>잔여</dt><dd class="good">${leave.remaining_days ?? '—'}</dd></div></dl>`));
  }
  root.innerHTML = `
  <div class="pv-strip"><div class="pv-wrap"><strong>새 화면 미리보기</strong><span>포털 첫 화면을 바꾸기 전에 확인하는 화면입니다. 실제 포털은 바뀌지 않았습니다.</span><a href="/">기존 화면으로 →</a></div></div>
  <header class="pv-header"><div class="pv-wrap pv-header-row">
    <a class="pv-brand" href="/preview.html"><span class="pv-logo" aria-hidden="true">D</span><span><strong>DYKIM'S PORTAL</strong><small>PERSONAL WORKSPACE</small></span></a>
    <div class="pv-util"><a href="${view('notifications')}">알림 <b>${d.counts.unread}</b></a><span>${esc(user.name)} · ${user.role === 'admin' ? '관리자' : user.role === 'editor' ? '편집자' : '조회자'}</span><a href="${view('settings')}">설정</a></div>
  </div></header>
  <nav class="pv-nav" aria-label="주 메뉴"><div class="pv-wrap pv-nav-row"><a class="pv-home" href="/preview.html">홈</a>${navGroups(user)}</div></nav>
  <section class="pv-hero"><div class="pv-wrap pv-hero-row">
    <div class="pv-hero-text">
      <p class="pv-eyebrow">나의 업무를 잇는 작업 공간</p>
      <h1>필요한 업무를,<br><span>한 곳에서 빠르게</span></h1>
      <p class="pv-lead">${esc(user.name)}님, 오늘은 ${esc(today)}입니다. 미완료 할 일 <b>${d.openTodoCount}건</b>, 읽지 않은 알림 <b>${d.counts.unread}건</b>이 있습니다.</p>
      <form class="pv-search" id="pv-search" role="search"><input name="q" maxlength="100" placeholder="회의록·업무기안·업무일지·설치·프로젝트·자산을 한 번에 찾아보세요" aria-label="포털 통합 검색"><button type="submit">검색 ${icon('search')}</button></form>
      <div class="pv-chips"><span>자주 쓰는 메뉴</span><a href="${view('drafts')}">업무기안</a><a href="${view('meetings')}">회의록</a><a href="${view('library')}">자료 관리</a><a href="${view('work')}">업무관리</a></div>
    </div>
    <aside class="pv-cta"><span class="pv-cta-icon">${icon('pen')}</span><h2>업무기안 작성</h2><p>기안을 작성하고 저장할 때<br>승인 요청 메일까지 한 번에 보내세요.</p><a class="pv-cta-button" href="${view('drafts')}">기안 작성하러 가기 →</a></aside>
  </div></section>
  <section class="pv-results pv-wrap" id="pv-results" hidden></section>
  <section class="pv-wrap pv-section"><div class="pv-section-head"><h2>자주 찾는 메뉴</h2><p>메뉴를 누르면 해당 화면으로 이동합니다.</p></div>
    <div class="pv-tiles">${tiles.map(([id, label, sub]) => `<a class="pv-tile" href="${view(id)}">${icon(id)}<strong>${esc(label)}</strong><small>${esc(sub)}</small></a>`).join('')}</div></section>
  <section class="pv-wrap pv-section"><div class="pv-section-head"><h2>오늘의 현황</h2><p>${esc(today)} 기준</p></div>
    <div class="pv-stats">${[['등록 자산', d.counts.assets, 'items'], ['설치 정보', d.counts.installations, 'installations'], ['등록 자료', d.counts.manuals, 'library'], ['읽지 않은 알림', d.counts.unread, 'notifications']].map(([label, n, id]) => `<a class="pv-stat" href="${view(id)}"><small>${label}</small><strong>${n}<span>건</span></strong></a>`).join('')}</div>
    <div class="pv-panels">${panels.join('')}</div></section>
  <footer class="pv-footer"><div class="pv-wrap">DYKIM'S PORTAL · 개인 업무 포털 · 새 화면 미리보기(1단계)</div></footer>`;
  root.querySelector('#pv-search').addEventListener('submit', event => { event.preventDefault(); search(new FormData(event.target).get('q')).catch(error => showResults(`<p class="pv-error">${esc(error.message)}</p>`)); });
}

function showResults(html) { const box = root.querySelector('#pv-results'); box.hidden = false; box.innerHTML = html; box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// 미리보기 검색: 기존 목록 API(검색어 지원)를 함께 불러 분류별로 보여 준다.
async function search(raw) {
  const q = String(raw ?? '').trim();
  if (!q) return showResults('<p class="pv-empty">검색어를 입력해 주세요.</p>');
  showResults('<p class="pv-empty">찾는 중입니다…</p>');
  const p = new URLSearchParams({ q });
  const sources = [
    ['업무기안', 'drafts', `/drafts?${p}`, d => d.drafts, r => [r.title, `${r.doc_no ?? ''} · ${r.draft_date}`]],
    ['회의록', 'meetings', `/meetings?${p}`, d => d.meetings, r => [r.title, r.meeting_date]],
    ['업무일지', 'work', `/work-logs?${p}&page_size=25`, d => d.logs, r => [r.title, `${r.customer_name} · ${r.work_date}`]],
    ['설치관리', 'installations', `/installations?${p}&page_size=25`, d => d.installations, r => [r.name, `${r.customer} · ${r.installed_on}`]],
    ['프로젝트', 'projects', `/projects?${p}`, d => d.projects, r => [r.name, r.customer || '']],
    ['자산', 'items', `/items?${p}&page_size=25`, d => d.items, r => [r.name, r.asset_code || '']],
  ];
  const results = await Promise.all(sources.map(async ([label, id, path, pick, line]) => { try { return [label, id, (pick(await api(path)) ?? []).slice(0, 5).map(line)]; } catch { return [label, id, null]; } }));
  const found = results.filter(([, , rows]) => rows?.length);
  showResults(`<div class="pv-section-head"><h2>‘${esc(q)}’ 검색 결과</h2><p>분류마다 최대 5건 · 누르면 해당 화면으로 이동</p></div>${found.length ? `<div class="pv-result-grid">${found.map(([label, id, rows]) => panel(label, [view(id), '목록 보기'], `<ul class="pv-list">${rows.map(([title, sub]) => `<li><a href="${view(id)}">${esc(title)}<small>${esc(sub)}</small></a></li>`).join('')}</ul>`)).join('')}</div>` : '<p class="pv-empty">찾은 항목이 없습니다.</p>'}`);
}

(async () => {
  try {
    const me = await api('/auth/me');
    if (!me.user) { root.innerHTML = '<main class="pv-loading"><p>포털에 로그인한 뒤 이 미리보기를 열어 주세요.</p><a href="/">포털 로그인 →</a></main>'; return; }
    const admin = me.user.role === 'admin';
    const [d, usage, leave, nas] = await Promise.all([api('/dashboard'), admin ? api('/usage').catch(() => null) : null, admin ? api('/leave').catch(() => null) : null, admin ? api('/nas').catch(() => null) : null]);
    render(me.user, d, usage, leave, nas);
  } catch (error) { root.innerHTML = `<main class="pv-loading"><p>${esc(error.message)}</p><a href="/">포털로 →</a></main>`; }
})();
