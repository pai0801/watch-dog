// src/routes/dashboard.ts
// Public monitoring dashboard (GET /).

import { Hono } from 'hono';
import type { AppBindings, Check, Project } from '../types';
import { METRICS } from '../services/cfUsage';
import { Layout } from '../views/layout';
import {
  CfUsagePane,
  DashboardContent,
  ErrorState,
  ProjectGrid,
} from '../views/dashboard';
import type { CfAccountCardData, CfUsageData, CfUsageRow } from '../views/dashboard';

const dashboard = new Hono<{ Bindings: AppBindings }>();

/** Shape the flat JOIN rows into per-account cards. Rows arrive sorted by
 *  label so a label change starts a new card (labels are the operator's
 *  per-account names — unique in practice for this single-operator system);
 *  metric order follows the METRICS registry. */
function groupCfUsage(rows: CfUsageRow[]): CfUsageData {
  const order = Object.keys(METRICS);
  const accounts: CfAccountCardData[] = [];
  for (const row of rows) {
    let card = accounts[accounts.length - 1];
    if (!card || card.label !== row.label) {
      card = { label: row.label, plan: row.plan, last_ok_at: row.last_ok_at, metrics: [] };
      accounts.push(card);
    }
    card.metrics.push({
      metric: row.metric,
      value: row.value,
      projected_eod: row.projected_eod,
      alerted_level: row.alerted_level,
    });
  }
  for (const card of accounts) {
    card.metrics.sort((a, b) => order.indexOf(a.metric) - order.indexOf(b.metric));
  }
  return {
    accounts,
    lastPolledAt: accounts.reduce((max, a) => Math.max(max, a.last_ok_at), 0),
  };
}

/**
 * GET /
 * Dashboard main page — dual tab: 服務狀態 (stats + project grid) and CF 用量.
 * Supports HTMX polling for auto-refresh (every 30s).
 */
dashboard.get('/', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const isHtmx = c.req.header('HX-Request');

  // CF usage pane — queried and caught on its own so a CF-side failure
  // degrades only this pane, never the service-status view (the same
  // isolation the cron poller applies to the fail-dead path).
  // account_id is deliberately NOT selected: this page is public and the
  // 32-hex id must never reach the response (source-level cutoff, not
  // front-end masking — it is joined on, never read out).
  let cfPane: ReturnType<typeof CfUsagePane>;
  try {
    const usage = await db
      .prepare(
        `SELECT s.metric, s.value, s.projected_eod, s.alerted_level, s.updated_at,
                a.label, a.plan, a.last_ok_at
         FROM cf_usage_state s JOIN cf_accounts a ON a.account_id = s.account_id
         WHERE s.day_utc = date('now') AND a.enabled = 1
         ORDER BY a.label, s.metric`
      )
      .all<CfUsageRow>();
    cfPane = CfUsagePane(groupCfUsage(usage.results));
  } catch (error) {
    console.error('CF usage pane error:', error);
    cfPane = ErrorState('Error loading CF usage', 'Unable to fetch CF usage data. Please try again.');
  }

  try {
    // Get all projects
    const projectsResult = await db
      .prepare('SELECT * FROM projects ORDER BY display_name')
      .all<Project>();

    const projects = projectsResult.results;

    // Get all checks
    const checksResult = await db
      .prepare('SELECT * FROM checks ORDER BY project_id, name')
      .all<Check>();

    const checks = checksResult.results;

    // Group checks by project
    const projectsWithChecks = projects.map((project) => ({
      ...project,
      in_maintenance: project.maintenance_until > now,
      checks: checks
        .filter((check) => check.project_id === project.id)
        .map((check) => ({
          ...check,
          is_stale: check.type === 'heartbeat' && (check.last_seen + check.interval + check.grace) < now,
        })),
    }));

    // Calculate overall stats
    const stats = {
      total: checks.length,
      ok: checks.filter((check) => check.status === 'ok').length,
      error: checks.filter((check) => check.status === 'error').length,
      dead: checks.filter((check) => check.status === 'dead').length,
      maintenance: projects.filter((p) => p.maintenance_until > now).length,
    };

    const projectGrid = ProjectGrid(projectsWithChecks);

    // HTMX request: only return the project grid (refresh stats via page reload)
    if (isHtmx) {
      return c.html(projectGrid);
    }

    // Full page: both panes behind the dual-tab shell
    return c.html(Layout({ content: DashboardContent(stats, projectGrid, cfPane) }));
  } catch (error) {
    console.error('Dashboard error:', error);
    if (isHtmx) {
      return c.html(ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.'));
    }
    return c.html(
      Layout({ content: ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.') })
    );
  }
});

export default dashboard;
