// src/views/cfDetail.ts
// Server-rendered fragment for the homepage card's expand area (htmx,
// toggle-triggered) — per-resource usage tables. Public like the CF pane:
// labels, names and numbers only, never any id (ResourceItem.id is internal;
// unresolved resources arrive here already degraded to short-id names).

import { html } from 'hono/html';
import type { ResourceDetail, ResourceGroup, ResourceGroupType, ResourceItem } from '../services/cfResources';
import { fmtMetricValue } from '../lib/format';

const GROUP_COLUMNS: Record<ResourceGroupType, string[]> = {
  workers: ['workers_requests', 'workers_errors'],
  pages: ['pages_requests'],
  d1: ['d1_rows_read', 'd1_rows_written'],
  kv: ['kv_ops', 'kv_storage_bytes', 'kv_storage_keys'],
  r2: ['r2_storage_bytes', 'r2_objects'],
};

const COLUMN_LABELS: Record<string, string> = {
  workers_requests: '請求',
  workers_errors: '錯誤',
  pages_requests: '請求',
  d1_rows_read: 'Rows 讀',
  d1_rows_written: 'Rows 寫',
  kv_ops: '操作',
  kv_storage_bytes: '儲存量',
  kv_storage_keys: 'Keys',
  r2_storage_bytes: '儲存量',
  r2_objects: '物件數',
};

const taipeiTime = (unixSec: number): string =>
  new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSec * 1000));

/** One metric cell: today's value with yesterday's below it in muted text.
 *  A resource with no yesterday row (created today / no usage) shows '—'. */
const MetricCell = (metric: string, item: ResourceItem) => {
  const prev = item.metrics_prev[metric];
  return html`<td>
    ${fmtMetricValue(metric, item.metrics[metric] ?? 0)}
    <div class="cf-res-prev">昨 ${prev === undefined ? '—' : fmtMetricValue(metric, prev)}</div>
  </td>`;
};

const GroupTable = (group: ResourceGroup) => html`
<div class="cf-res-group">
  <h4 class="cf-res-title">${group.title}</h4>
  <table class="cf-res-table">
    <thead>
      <tr>
        <th>資源</th>
        ${GROUP_COLUMNS[group.type].map((m) => html`<th>${COLUMN_LABELS[m] ?? m}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${group.items.map(
        (item) => html`
        <tr>
          <td class="cf-res-name">${item.name}</td>
          ${GROUP_COLUMNS[group.type].map((m) => MetricCell(m, item))}
        </tr>
        `
      )}
    </tbody>
  </table>
</div>`;

/** The expand-area fragment: one table per resource group. The root carries
 *  no `cf-detail` class — the swap target (trigger div) already has it, and
 *  nesting two `.cf-detail`s doubles the margin (final-review nit #24). */
export const CfResourceDetailFragment = (detail: ResourceDetail) => html`
<div>
  <p class="cf-detail-meta">逐資源明細（上列＝今日 UTC，灰字＝昨日）· 查詢時間 ${taipeiTime(detail.fetchedAt)}</p>
  ${detail.groups.map((g) => GroupTable(g))}
  ${detail.groups.length === 0 ? html`<p class="cf-detail-meta">近兩日無任何資源用量。</p>` : ''}
</div>`;

/** 200-status error panel — htmx does not swap non-2xx responses, so the
 *  fragment route ALWAYS answers 200 and degrades visually (design §安全
 *  不變式 5). `cf-detail` omitted for the same nested-margin reason. */
export const CfDetailError = (message: string) => html`
<div class="cf-detail-error">
  <p>資源明細載入失敗：${message}</p>
  <p class="cf-detail-meta">稍後再收合重新展開即可重試（成功後 5 分鐘快取生效）。</p>
</div>`;
