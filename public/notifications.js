const activityViews = {
  installations: '설치관리', library: '자료 관리', items: '자산 관리',
  work: '업무관리', reports: '리포트', users: '사용자 관리', backups: '백업/복구'
};
const activityKinds = { change: '변경', missing: '정보 누락', monthly: '월간 요약' };
const deadlineKinds = new Set(['upcoming', 'today', 'overdue']);

export function notificationHtml(notification, { esc, fmt, labels }) {
  const n = notification;
  const activity = String(n.id).startsWith('activity:');
  const view = activity ? activityViews[n.scope] : null;
  const kind = activity ? activityKinds[n.kind] ?? '활동' : labels[n.kind] ?? '기한';
  const badgeClass = !activity && deadlineKinds.has(n.kind) ? n.kind : '';
  const detail = activity ? n.detail : n.asset_code;
  const itemId = Number(n.item_id);
  const action = view
    ? `<button class="small" data-view="${n.scope}">${view} 보기</button>`
    : !activity && Number.isSafeInteger(itemId) && itemId > 0
      ? `<button class="small" data-action="item" data-id="${itemId}">물품 보기</button>`
      : '';
  return `<article class="notification ${n.read_at ? '' : 'unread'}"><span class="badge ${badgeClass}">${esc(kind)}</span><div class="notification-content"><p>${esc(n.title)}</p>${detail ? `<span class="notification-detail">${esc(detail)}</span>` : ''}<small>${activity ? `${esc(view ?? '활동')} · ` : ''}${fmt(n.created_at)}${n.read_at ? ' · 읽음' : ''}</small></div><div class="notification-actions">${action}${!n.read_at ? `<button class="small" data-action="read" data-id="${esc(n.id)}">읽음</button>` : ''}</div></article>`;
}
