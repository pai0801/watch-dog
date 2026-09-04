// src/views/dashboard.ts
// HTML builders for the public monitoring dashboard (GET /).

import { html } from 'hono/html';
import type { Check, Project } from '../types';

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
 * Full dashboard content: stats + HTMX-polled project grid.
 */
export const DashboardContent = (stats: Parameters<typeof StatsCards>[0], projectGrid: ReturnType<typeof html>) => html`
${StatsCards(stats)}
<div id="dashboard" hx-get="/" hx-trigger="every 30s" hx-swap="none" _="on htmx:afterRequest if window.location.hash === '' then location.reload()">
  ${projectGrid}
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

/** Shared error panel for dashboard rendering failures. */
export const ErrorState = (title: string, detail: string) => html`
<div class="empty-state">
  <h3>${title}</h3>
  <p>${detail}</p>
</div>
`;
