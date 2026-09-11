// src/views/dashboard.ts
// HTML builders for the public monitoring dashboard (GET /).

import { html } from 'hono/html';
import type { Check, Project } from '../types';
import { METRICS, quotaFor } from '../services/cfUsage';
import type { CfAccountCardData, CfMetricRowData, CfPlanId, CfUsageData } from '../services/cfUsage';
import { fmtMetricValue } from '../lib/format';

/**
 * ProjectCard component - Card showing project status and checks.
 * Read-only on the public dashboard: maintenance toggling lives in /admin.
 */
export const ProjectCard = (project: Project & { in_maintenance: boolean; checks: Array<Check & { is_stale: boolean }> }) => html`
<div class="project-card">
  <div class="project-header">
    <h3 class="project-title">${project.display_name}</h3>
    ${project.in_maintenance ? html`<span class="maintenance-badge">🚧 Maintenance</span>` : ''}
  </div>
  <div class="check-list">
    ${project.checks.length === 0 ? html`
      <p style="color: #888; font-size: 0.875rem;">No checks configured</p>
    ` : project.checks.map(check => html`
      <div class="check-item status-${check.status}">
        <div>
          <div class="check-name">${check.display_name || check.name}</div>
          <div class="check-meta">
            ${check.type === 'heartbeat' ? `Every ${check.interval}s` : 'Event'} • Last seen: <span x-data="{}" x-text="$time(${check.last_seen})"></span>
          </div>
          ${check.last_message ? html`<div class="check-meta" style="color: #aaa;">${check.last_message}</div>` : ''}
        </div>
        <span class="status-badge ${check.status}">${check.status}</span>
      </div>
    `)}
  </div>
</div>
`;

/**
 * Dashboard stats cards (Total / OK / Error / Dead / Maintenance).
 */
export const StatsCards = (stats: {
  total: number;
  ok: number;
  error: number;
  dead: number;
  maintenance: number;
}) => html`
<div class="stats-cards-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
  <div style="background: #2a2a2a; padding: 1rem; border-radius: 0.5rem; border-left: 3px solid #3498db;">
    <div style="font-size: 0.75rem; color: #888; text-transform: uppercase;">Total Checks</div>
    <div style="font-size: 1.5rem; font-weight: 600;">${stats.total}</div>
  </div>
  <div style="background: #2a2a2a; padding: 1rem; border-radius: 0.5rem; border-left: 3px solid #2ecc71;">
    <div style="font-size: 0.75rem; color: #888; text-transform: uppercase;">OK</div>
    <div style="font-size: 1.5rem; font-weight: 600; color: #2ecc71;">${stats.ok}</div>
  </div>
  <div style="background: #2a2a2a; padding: 1rem; border-radius: 0.5rem; border-left: 3px solid #e74c3c;">
    <div style="font-size: 0.75rem; color: #888; text-transform: uppercase;">Error</div>
    <div style="font-size: 1.5rem; font-weight: 600; color: #e74c3c;">${stats.error}</div>
  </div>
  <div style="background: #2a2a2a; padding: 1rem; border-radius: 0.5rem; border-left: 3px solid #7f8c8d;">
    <div style="font-size: 0.75rem; color: #888; text-transform: uppercase;">Dead</div>
    <div style="font-size: 1.5rem; font-weight: 600; color: #95a5a6;">${stats.dead}</div>
  </div>
  <div style="background: #2a2a2a; padding: 1rem; border-radius: 0.5rem; border-left: 3px solid #e67e22;">
    <div style="font-size: 0.75rem; color: #888; text-transform: uppercase;">Maintenance</div>
    <div style="font-size: 1.5rem; font-weight: 600; color: #e67e22;">${stats.maintenance}</div>
  </div>
</div>`;

/**
 * Full dashboard content behind the dual-tab shell: 服務狀態 (stats + grid)
 * and CF 用量 are both server-rendered; Alpine switches visibility and
 * persists the active tab in the URL hash (#status default / #cf), so the
 * 30s auto-reload lands back on the same tab (and #cf links are shareable).
 */
export const DashboardContent = (
  stats: Parameters<typeof StatsCards>[0],
  projectGrid: ReturnType<typeof html>,
  cfPane: ReturnType<typeof CfUsagePane>,
) => html`
<div x-data="{ tab: location.hash === '#cf' ? 'cf' : 'status' }">
  <div class="dashboard-tabs" role="tablist">
    <button type="button" role="tab" :aria-selected="tab === 'status'" :class="tab === 'status' ? 'primary' : 'outline secondary'" @click="tab = 'status'; location.hash = 'status'">服務狀態</button>
    <button type="button" role="tab" :aria-selected="tab === 'cf'" :class="tab === 'cf' ? 'primary' : 'outline secondary'" @click="tab = 'cf'; location.hash = 'cf'">CF 用量</button>
  </div>
  <div role="tabpanel" x-show="tab === 'status'">
    ${StatsCards(stats)}
    <div id="dashboard" hx-get="/" hx-trigger="every 30s" hx-swap="none" _="on htmx:afterRequest then location.reload()">
      ${projectGrid}
    </div>
  </div>
  <div role="tabpanel" x-show="tab === 'cf'" x-cloak>
    ${cfPane}
  </div>
</div>
`;

/**
 * Project grid (or the empty-state hint when nothing is registered).
 */
export const ProjectGrid = (projectsWithChecks: Array<Parameters<typeof ProjectCard>[0]>) =>
  projectsWithChecks.length === 0
    ? html`
      <div class="empty-state">
        <h3>No projects registered</h3>
        <p>Register a project via the <code>/api/config</code> endpoint to get started.</p>
      </div>
    `
    : html`
      <div class="dashboard-grid">
        ${projectsWithChecks.map(p => ProjectCard(p))}
      </div>
    `;

/** One metric line: name | value, then bar + pct when the metric has a quota.
 *  Bar color is status (plain <60% / amber >=60% / red >=80%) — the printed
 *  percentage is the primary signal, color only reinforces (never
 *  color-alone); a projected-over-quota row adds 45-degree stripes + a
 *  warning flag with the projected end-of-day value in the tooltip. */
const CfMetricLine = (row: CfMetricRowData, plan: CfPlanId) => {
  const def = METRICS[row.metric];
  const quota = quotaFor(row.metric, plan);
  const name = def ? def.label : row.metric;
  const projectedOver = row.projected_eod !== null && quota > 0 && row.projected_eod > quota;
  const projTitle = projectedOver
    ? `預估今日收盤 ${fmtMetricValue(row.metric, row.projected_eod ?? 0)} — 超過配額 ${fmtMetricValue(row.metric, quota)}`
    : '';
  const title =
    quota > 0
      ? `${name}: ${fmtMetricValue(row.metric, row.value)} / ${fmtMetricValue(row.metric, quota)} 配額${projectedOver ? ` — ${projTitle}` : ''}`
      : `${name}: ${fmtMetricValue(row.metric, row.value)}`;

  if (quota <= 0) {
    return html`
      <div class="cf-metric" title="${title}">
        <div class="cf-metric-top">
          <span class="cf-metric-name">${name}</span>
          <span class="cf-metric-val">${fmtMetricValue(row.metric, row.value)}</span>
        </div>
      </div>
    `;
  }

  const pct = row.value / quota;
  const level = pct >= 0.8 ? ' cf-danger' : pct >= 0.6 ? ' cf-warn' : '';
  const fillClass = `cf-bar-fill${level}${projectedOver ? ' cf-projected' : ''}`;
  return html`
    <div class="cf-metric" title="${title}">
      <div class="cf-metric-top">
        <span class="cf-metric-name">${name}</span>
        <span class="cf-metric-val">${fmtMetricValue(row.metric, row.value)}</span>
      </div>
      <div class="cf-metric-bar-row">
        <div class="cf-bar">
          <div class="${fillClass}" style="width: ${Math.min(100, pct * 100)}%"></div>
        </div>
        <span class="cf-metric-pct">${Math.round(pct * 100)}%</span>
        ${projectedOver ? html`<span class="cf-proj-flag" title="${projTitle}">⚠</span>` : ''}
      </div>
    </div>
  `;
};

/** Account card: label + plan badge + all metric lines (registry order). */
const CfAccountCard = (card: CfAccountCardData) => html`
<div class="cf-account-card">
  <div class="cf-account-header">
    <h3>${card.label}</h3>
    <span class="cf-plan-badge">${card.plan}</span>
  </div>
  ${card.metrics.map((row) => CfMetricLine(row, card.plan))}
</div>
`;

/** The CF 用量 tab pane. Public by design — renders labels and numbers only,
 *  never account ids (empty state points operators at /admin for setup). */
export const CfUsagePane = (data: CfUsageData) =>
  data.accounts.length === 0
    ? html`
      <div class="empty-state">
        <h3>尚無 CF 用量資料</h3>
        <p>到 <a href="/admin">/admin → CF 用量</a> 新增監控帳號（或按「立即輪詢」抓第一份快照），之後每 30 分鐘自動更新。</p>
      </div>
    `
    : html`
      <p class="cf-summary">
        ${data.accounts.length} 帳號監控中 · 最後輪詢 <span x-data="{}" x-text="$time(${data.lastPolledAt})"></span> · 額度 UTC 00:00（台北 08:00）重置
      </p>
      <div class="cf-grid">
        ${data.accounts.map((card) => CfAccountCard(card))}
      </div>
    `;

/** Shared error panel for dashboard rendering failures. */
export const ErrorState = (title: string, detail: string) => html`
<div class="empty-state">
  <h3>${title}</h3>
  <p>${detail}</p>
</div>
`;
