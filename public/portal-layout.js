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
// chips: 첫 화면 '자주 쓰는 메뉴'(관리자가 설정에서 체크, 포털 전체) [id, 이름, 외부 주소 여부]
export function portalHeroHtml({ user, d, names, shown, chips = [] }) {
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const visible = new Set(shown);
  const chipHtml = chips.map(([id, label, external]) => `<button type="button" data-view="${esc(id)}">${esc(label)}${external ? ' <small>↗</small>' : ''}</button>`).join('');
  const tileHtml = tiles.filter(([id]) => visible.has(id)).map(([id, sub]) => `<button type="button" class="ph-tile" data-view="${id}">${portalIcon(id)}<strong>${esc(names.get(id))}</strong><small>${esc(sub)}</small></button>`).join('');
  return `<section class="ph-hero"><div class="ph-hero-row">
      <div class="ph-hero-text"><p class="ph-eyebrow">나의 업무를 잇는 작업 공간</p><h1>필요한 업무를,<br><span>한 곳에서 빠르게</span></h1>
        <p class="ph-lead">${esc(user.name)}님, 오늘은 ${esc(today)}입니다. 미완료 할 일 <b>${d.openTodoCount}건</b>, 읽지 않은 알림 <b>${d.counts.unread}건</b>이 있습니다.</p>
        <form class="ph-search" id="portal-search" role="search"><input name="q" maxlength="100" placeholder="포털 전체(기록 내용·자료·첨부 파일 이름)에서 찾아보세요" aria-label="포털 통합 검색"><button type="submit">검색 ${portalIcon('search', 20)}</button></form>
        ${chipHtml ? `<div class="ph-chips"><span>자주 쓰는 메뉴</span>${chipHtml}</div>` : ''}</div>
      <aside class="ph-calendar" id="portal-calendar" aria-label="달력"><p class="muted">달력을 불러오는 중입니다.</p></aside>
    </div></section>
    <section class="ph-results" id="portal-search-results" hidden></section>
    ${tileHtml ? `<section class="ph-section"><div class="ph-section-head"><h2>자주 찾는 메뉴</h2><p>메뉴를 누르면 해당 화면으로 이동합니다.</p></div><div class="ph-tiles">${tileHtml}</div></section>` : ''}
    <div class="ph-section-head ph-today-head"><h2>오늘의 현황</h2><p>${esc(today)} 기준</p></div>`;
}

// 달력(공휴일 포함): month는 0~11. holidays: [{date:'YYYY-MM-DD', name}] — 서버(/api/holidays)가 받은 출처 그대로.
export function seoulToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function portalCalendarHtml({ year, month, holidays = [], source = '', fetchedAt = null, error = '', loading = false }) {
  const pad = n => String(n).padStart(2, '0'), today = seoulToday();
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay(), days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const prefix = `${year}-${pad(month + 1)}-`, monthHolidays = holidays.filter(h => h.date.startsWith(prefix));
  const byDate = new Map(); for (const h of monthHolidays) byDate.set(h.date, [...(byDate.get(h.date) ?? []), h.name]);
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<span class="ph-cal-day ph-cal-blank" aria-hidden="true"></span>');
  for (let day = 1; day <= days; day++) {
    const date = prefix + pad(day), weekday = (first + day - 1) % 7, names = byDate.get(date);
    const cls = ['ph-cal-day', weekday === 0 ? 'sun' : weekday === 6 ? 'sat' : '', names ? 'holiday' : '', date === today ? 'today' : ''].filter(Boolean).join(' ');
    const label = `${month + 1}월 ${day}일${names ? ' ' + names.join(', ') : ''}${date === today ? ' (오늘)' : ''}`;
    cells.push(`<span class="${cls}" title="${esc(label)}" aria-label="${esc(label)}">${day}</span>`);
  }
  const list = monthHolidays.map(h => `<li><b>${Number(h.date.slice(8))}일</b> ${esc(h.name)}</li>`).join('');
  const updated = fetchedAt ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(fetchedAt)) : '';
  return `<div class="ph-cal-head"><button type="button" class="ph-cal-nav" data-action="portal-cal" data-step="-1" aria-label="이전 달">‹</button><h2><button type="button" class="ph-cal-title" data-action="portal-cal" data-step="0" title="이번 달로">${year}년 ${month + 1}월</button></h2><button type="button" class="ph-cal-nav" data-action="portal-cal" data-step="1" aria-label="다음 달">›</button></div>
    <div class="ph-cal-grid" role="grid"><span class="ph-cal-wd sun">일</span><span class="ph-cal-wd">월</span><span class="ph-cal-wd">화</span><span class="ph-cal-wd">수</span><span class="ph-cal-wd">목</span><span class="ph-cal-wd">금</span><span class="ph-cal-wd sat">토</span>${cells.join('')}</div>
    <div class="ph-cal-holidays">${loading ? '<p class="muted">공휴일을 불러오는 중입니다.</p>' : list ? `<ul>${list}</ul>` : '<p class="muted">이번 달 공휴일이 없습니다.</p>'}</div>
    <p class="ph-cal-source">${error ? `<span class="ph-cal-error">${esc(error)}</span> ` : ''}${source ? `공휴일 출처: ${esc(source)}${updated ? ` (${esc(updated)} 받음)` : ''}` : ''}</p>`;
}

// 통합 검색: 서버 /api/search가 포털 전체(기록 제목·내용, 자료 폴더·파일·링크 이름, 첨부 파일 이름)를 찾는다.
const kindView = { drafts: 'drafts', meetings: 'meetings', work: 'work', customers: 'work', installations: 'installations', projects: 'projects', items: 'items', todos: 'todos', folders: 'library', manuals: 'library', links: 'library' };
export async function portalSearch({ api, q }) {
  const data = await api('/search?' + new URLSearchParams({ q, limit: '8' }));
  const pattern = new RegExp(data.terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const mark = text => { const value = String(text ?? ''); let html = '', last = 0; for (const m of value.matchAll(pattern)) { if (!m[0]) continue; html += esc(value.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`; last = m.index + m[0].length; } return html + esc(value.slice(last)); };
  const open = (kind, row) => kind === 'links'
    ? `<a class="link-button" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${mark(row.title)} <small>↗</small><span class="secondary-line">${mark(row.sub ?? '')}</span></a>`
    : `<button type="button" class="link-button" data-action="search-open" data-kind="${esc(kind)}" data-id="${Number(row.id)}"${row.folder_id != null ? ` data-folder="${Number(row.folder_id)}"` : ''}${row.preview_type ? ' data-preview="1"' : ''}>${mark(row.title)}<span class="secondary-line">${esc(row.sub ?? '')}</span>${row.snippet ? `<span class="ph-snippet">${mark(row.snippet)}</span>` : ''}</button>`;
  const panel = group => {
    const rows = group.rows.map(row => `<div class="dashboard-row">${open(group.id === 'attachments' ? row.kind : group.id, group.id === 'attachments' ? { ...row, id: row.parent_id, sub: `${row.parent_title} 첨부`, snippet: '' } : row)}</div>`).join('');
    const more = group.view ? `<button class="small" data-view="${group.view}">목록 보기</button>` : '';
    return `<section class="panel ph-result"><div class="panel-head"><h2>${esc(group.label)} <small>${group.total}건</small></h2>${more}</div>${rows}${group.total > group.rows.length ? `<p class="ph-more muted">외 ${group.total - group.rows.length}건 — 검색어를 더 넣어 좁혀 보세요.</p>` : ''}</section>`;
  };
  return `<div class="ph-section-head"><h2>‘${esc(data.q)}’ 검색 결과 <small>${data.total}건</small></h2><p>포털 전체 · 분류마다 최대 8건 · 누르면 해당 항목을 엽니다</p></div>${data.groups.length ? `<div class="ph-result-grid">${data.groups.map(panel).join('')}</div>` : '<p class="muted">찾은 항목이 없습니다. 띄어쓰기로 나눈 낱말이 모두 들어 있는 항목만 찾습니다.</p>'}`;
}
export { kindView };
