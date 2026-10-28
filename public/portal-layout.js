// 포털형 화면(2026-10-28, 2단계): 왼쪽 세로 메뉴 대신 헤더 + 묶음 가로 메뉴 + 첫 화면 히어로(검색·바로가기).
// 설정 → 화면 스타일에서 '기존 메뉴형'으로 되돌릴 수 있다(이 브라우저에 저장). 미리보기(public/preview.*)를 실제 포털에 옮긴 것.
const layoutKey = 'portal-layout';
export function layoutMode() { try { return localStorage.getItem(layoutKey) === 'classic' ? 'classic' : 'portal'; } catch { return 'portal'; } }
export function setLayoutMode(mode) { try { localStorage.setItem(layoutKey, mode === 'classic' ? 'classic' : 'portal'); } catch {} }

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function portalIcon(name, size = 28) {
  const paths = {
    meetings: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h5"/>',
    drafts: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h6M10 16h6"/>',
    work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12h18"/>',
    library: '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h6l2 2"/>',
    installations: '<path d="M14 6l4 4-8 8H6v-4z"/><path d="M12 8l4 4"/>',
    todos: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    projects: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    items: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 8v8l8 4 8-4V8"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    pen: '<path d="M5 19l1-4 10-10 3 3-10 10z"/><path d="M14 7l3 3"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
}

// 가로 메뉴 묶음. 메뉴 id는 기존 메뉴(app.js shell의 menus)와 같고, 표시 설정에서 숨긴 메뉴는 빠진다.
export const portalGroups = [
  ['업무', ['meetings', 'drafts', 'work', 'todos']],
  ['설치·자산', ['installations', 'projects', 'items']],
  ['자료·리포트', ['library', 'reports']],
  ['바로가기', ['tools', 'outlook', 'gracecns', 'nas']],
];
const adminViews = [['users', '사용자 관리'], ['backups', '백업/복구'], ['operations', '운영관리'], ['usage', '사용량 관리']];

// shown: 표시할 최상위 메뉴 id(순서 무관), names: id → 이름, nasLinks: NAS 묶음 하위 [id,label,url]
export function portalNavHtml({ shown, names, nasLinks, admin }) {
  const visible = new Set(shown), grouped = new Set(portalGroups.flatMap(([, ids]) => ids));
  const item = id => `<button type="button" data-view="${id}">${esc(names.get(id))}${['outlook', 'gracecns'].includes(id) ? ' <small>↗</small>' : ''}</button>`;
  const groups = portalGroups.map(([title, ids]) => {
    const items = ids.filter(id => visible.has(id)).flatMap(id => id === 'nas' ? nasLinks.map(([child, label]) => `<button type="button" data-view="${child}">${esc(label)} <small>↗</small></button>`) : [item(id)]);
    return [title, items, ids];
  });
  // 묶음에 없는 새 메뉴는 '바로가기' 끝에 넣는다(설정 제외).
  const extra = shown.filter(id => !grouped.has(id) && id !== 'settings' && id !== 'dashboard');
  if (extra.length) groups[3][1].push(...extra.map(item));
  groups.push([admin ? '관리' : '설정', [item('settings'), ...(admin ? adminViews.map(([id, label]) => `<button type="button" data-view="${id}">${label}</button>`) : [])], ['settings', ...adminViews.map(([id]) => id)]]);
  return `<button type="button" class="ph-home" data-view="dashboard">홈</button>` + groups.filter(([, items]) => items.length).map(([title, items, ids]) =>
    `<div class="ph-menu" data-views="${ids.join(' ')}"><button type="button" class="ph-menu-button" aria-haspopup="true">${esc(title)}</button><div class="ph-sub">${items.join('')}</div></div>`).join('');
}

export function portalShellHtml({ user, roleLabel }) {
  return `<div class="layout portal-layout"><header class="ph-header"><div class="ph-wrap ph-header-row">
    <button type="button" class="ph-brand" data-view="dashboard" aria-label="첫 화면으로"><span class="ph-logo" aria-hidden="true">D</span><span class="ph-title"><strong>DYKIM'S PORTAL</strong><small>PERSONAL WORKSPACE</small></span></button>
    <div class="ph-util"><button type="button" data-view="notifications">알림 <span id="nav-count" class="badge" hidden></span></button><button type="button" data-action="account">${esc(user.name)} · ${esc(roleLabel)}</button><button type="button" data-view="settings">설정</button></div>
  </div></header>
  <nav class="ph-nav" aria-label="주 메뉴"><div class="ph-wrap ph-nav-row" id="portal-nav"></div></nav>
  <div class="ph-crumbs"><div class="ph-wrap"><button type="button" class="back-button" data-action="view-back" aria-label="이전 화면으로 돌아가기">← 뒤로가기</button><span>내 작업 공간 / <strong id="breadcrumb"></strong></span></div></div>
  <main class="content ph-content" id="content"></main></div>`;
}

const tiles = [['meetings', '회의 기록·결정 사항'], ['drafts', '기안 작성·메일 발송'], ['work', '고객별 업무일지'], ['library', '매뉴얼·링크·파일'], ['installations', '설치 이력·엔지니어'], ['todos', '오늘의 할 일 메모']];
export function portalHeroHtml({ user, d, names, shown, canEdit }) {
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const visible = new Set(shown);
  const chips = ['drafts', 'meetings', 'library', 'work'].filter(id => visible.has(id)).map(id => `<button type="button" data-view="${id}">${esc(names.get(id))}</button>`).join('');
  const tileHtml = tiles.filter(([id]) => visible.has(id)).map(([id, sub]) => `<button type="button" class="ph-tile" data-view="${id}">${portalIcon(id)}<strong>${esc(names.get(id))}</strong><small>${esc(sub)}</small></button>`).join('');
  return `<section class="ph-hero"><div class="ph-hero-row">
      <div class="ph-hero-text"><p class="ph-eyebrow">나의 업무를 잇는 작업 공간</p><h1>필요한 업무를,<br><span>한 곳에서 빠르게</span></h1>
        <p class="ph-lead">${esc(user.name)}님, 오늘은 ${esc(today)}입니다. 미완료 할 일 <b>${d.openTodoCount}건</b>, 읽지 않은 알림 <b>${d.counts.unread}건</b>이 있습니다.</p>
        <form class="ph-search" id="portal-search" role="search"><input name="q" maxlength="100" placeholder="회의록·업무기안·업무일지·설치·프로젝트·자산을 한 번에 찾아보세요" aria-label="포털 통합 검색"><button type="submit">검색 ${portalIcon('search', 20)}</button></form>
        ${chips ? `<div class="ph-chips"><span>자주 쓰는 메뉴</span>${chips}</div>` : ''}</div>
      ${visible.has('drafts') ? `<aside class="ph-cta"><span class="ph-cta-icon">${portalIcon('pen')}</span><h2>업무기안 작성</h2><p>기안을 작성하고 저장할 때<br>승인 요청 메일까지 한 번에 보내세요.</p><button type="button" class="ph-cta-button" ${canEdit ? 'data-action="portal-new-draft"' : 'data-view="drafts"'}>${canEdit ? '기안 작성하기 →' : '업무기안 보기 →'}</button></aside>` : ''}
    </div></section>
    <section class="ph-results" id="portal-search-results" hidden></section>
    ${tileHtml ? `<section class="ph-section"><div class="ph-section-head"><h2>자주 찾는 메뉴</h2><p>메뉴를 누르면 해당 화면으로 이동합니다.</p></div><div class="ph-tiles">${tileHtml}</div></section>` : ''}
    <div class="ph-section-head ph-today-head"><h2>오늘의 현황</h2><p>${esc(today)} 기준</p></div>`;
}

// 통합 검색(간이): 기존 목록 API(검색어 지원)를 함께 불러 분류마다 5건씩 보여 준다.
export async function portalSearch({ api, q, shown }) {
  const p = new URLSearchParams({ q }), visible = new Set(shown);
  const sources = [
    ['업무기안', 'drafts', `/drafts?${p}`, d => d.drafts, r => [r.title, `${r.doc_no ?? ''} · ${r.draft_date}`]],
    ['회의록', 'meetings', `/meetings?${p}`, d => d.meetings, r => [r.title, r.meeting_date]],
    ['업무일지', 'work', `/work-logs?${p}&page_size=25`, d => d.logs, r => [r.title, `${r.customer_name} · ${r.work_date}`]],
    ['설치관리', 'installations', `/installations?${p}&page_size=25`, d => d.installations, r => [r.name, `${r.customer} · ${r.installed_on}`]],
    ['프로젝트', 'projects', `/projects?${p}`, d => d.projects, r => [r.name, r.customer || '']],
    ['자산', 'items', `/items?${p}&page_size=25`, d => d.items, r => [r.name, r.asset_code || '']],
  ].filter(([, id]) => visible.has(id));
  const results = await Promise.all(sources.map(async ([label, id, path, pick, line]) => { try { return [label, id, (pick(await api(path)) ?? []).slice(0, 5).map(line)]; } catch { return [label, id, null]; } }));
  const found = results.filter(([, , rows]) => rows?.length);
  return `<div class="ph-section-head"><h2>‘${esc(q)}’ 검색 결과</h2><p>분류마다 최대 5건 · 누르면 해당 화면으로 이동</p></div>${found.length ? `<div class="ph-result-grid">${found.map(([label, id, rows]) => `<section class="panel ph-result"><div class="panel-head"><h2>${esc(label)}</h2><button class="small" data-view="${id}">목록 보기</button></div>${rows.map(([title, sub]) => `<div class="dashboard-row"><button class="link-button" data-view="${id}">${esc(title)}<span class="secondary-line">${esc(sub)}</span></button></div>`).join('')}</section>`).join('')}</div>` : '<p class="muted">찾은 항목이 없습니다.</p>'}`;
}
