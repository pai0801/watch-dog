// src/views/issues.ts
// HTML builders for the 待處理 log 觀察頁 (GET /issues, 2026-10-31).
//
// 公開唯讀，同首頁方針：只渲染 title / 狀態 / Windmill 認領標記 /
// 嘗試次數等詮釋資料——raw payload（可能含 stack trace 內容）留在 DB。

import { html } from 'hono/html';
import type { Issue } from '../types';

/** 狀態 → badge 樣式（沿用 status-badge 語彙；escalated 用 warning 色）。 */
const STATE_STYLE: Record<Issue['state'], { label: string; cls: string }> = {
  open: { label: '待處理', cls: 'error' },
  claimed: { label: '處理中', cls: 'ok' },
  done: { label: '已修復', cls: 'ok' },
  escalated: { label: '需人工', cls: 'dead' },
  resolved: { label: 'CF 已解決', cls: 'dead' },
};

/** 認領標記：Windmill 取過就亮（含多久前認領）。 */
const ClaimMark = (issue: Issue) =>
  issue.claimed_at
    ? html`<span title="Windmill 認領於 Unix ${issue.claimed_at}">⚓ <span x-data="{}" x-text="$time(${issue.claimed_at})"></span></span>`
    : html`<span style="color: #666;">—</span>`;

const IssueRow = (issue: Issue) => {
  const s = STATE_STYLE[issue.state];
  const attemptsLeft = issue.attempt_count;
  return html`
    <tr>
      <td><span x-data="{}" x-text="$time(${issue.last_seen})"></span></td>
      <td>${issue.script_name ?? html`<span style="color: #666;">(unknown)</span>`}</td>
      <td style="max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${issue.title}">${issue.title}</td>
      <td>${issue.project_id ?? html`<span style="color: #666;">未映射</span>`}</td>
      <td><span class="status-badge ${s.cls}">${s.label}</span></td>
      <td>${ClaimMark(issue)}</td>
      <td style="font-variant-numeric: tabular-nums;">${attemptsLeft}/2</td>
    </tr>
  `;
};

/** 觀察頁主內容（route 包 Layout；htmx 輪詢直接換 fragment）。 */
export const IssuesContent = (rows: Issue[], counts: Record<string, number>) => html`
<div>
  <p class="cf-summary" style="display: flex; gap: 1rem; align-items: center;">
    <a href="/" style="font-size: 0.85rem;">← 回儀表板</a>
    <span>待處理 ${counts.open} · 處理中 ${counts.claimed} · 需人工 ${counts.escalated} · 已修復 ${counts.done} · CF 已解決 ${counts.resolved}</span>
  </p>
  <div id="issues-list" hx-get="/issues" hx-trigger="every 30s" hx-swap="none"
       _="on htmx:afterRequest location.reload()">
    ${rows.length === 0
      ? html`<div class="empty-state"><h3>目前沒有任何 CF Issue</h3><p>Issues 收集器尚未收到事件（或尚未接入——見 README「Issues 收集器」段）。</p></div>`
      : html`
    <div style="overflow-x: auto;">
      <table style="width: 100%; font-size: 0.82rem; border-collapse: collapse;">
        <thead>
          <tr style="color: #888; text-align: left;">
            <th>最後事件</th>
            <th>Script</th>
            <th>標題</th>
            <th>映射專案</th>
            <th>狀態</th>
            <th>Windmill</th>
            <th>嘗試</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((issue) => IssueRow(issue))}
        </tbody>
      </table>
    </div>`}
  </div>
</div>`;

