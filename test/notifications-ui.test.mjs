import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationHtml } from '../public/notifications.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const options = { esc, fmt: () => '2026. 10. 4.', labels: { today: '오늘 기한' } };

test('activity alerts show their details and open the related menu', () => {
  const html = notificationHtml({ id: 'activity:17', scope: 'reports', kind: 'monthly', title: '9월 리포트 집계 완료', detail: '설치 2건 <script>', created_at: '2026-10-04T00:00:00Z' }, options);
  assert.match(html, /월간 요약/);
  assert.match(html, /설치 2건 &lt;script&gt;/);
  assert.match(html, /data-view="reports"/);
  assert.match(html, /data-action="read" data-id="activity:17"/);
  assert.doesNotMatch(html, /undefined|물품 보기|<script>/);
});

test('deadline alerts keep the item link and readable status', () => {
  const html = notificationHtml({ id: 'deadline:3', item_id: 8, kind: 'today', title: '점검일', asset_code: 'SW-008', created_at: '2026-10-04T00:00:00Z', read_at: '2026-10-04T01:00:00Z' }, options);
  assert.match(html, /오늘 기한/);
  assert.match(html, /SW-008/);
  assert.match(html, /data-action="item" data-id="8"/);
  assert.doesNotMatch(html, /data-action="read"|undefined/);
});
