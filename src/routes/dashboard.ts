// src/routes/dashboard.ts
// Public monitoring dashboard (GET /).

import { Hono } from 'hono';
import type { AppBindings, Check, Project } from '../types';
import { getTodayCfUsage } from '../services/cfUsage';
import { Layout } from '../views/layout';
import {
  CfUsagePane,
  DashboardContent,
  ErrorState,
  ProjectGrid,
} from '../views/dashboard';

const dashboard = new Hono<{ Bindings: AppBindings }>();

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
  // account_id is deliberately never selected: this page is public and the
  // 32-hex id must never reach the response — the invariant is documented
  // with the SQL in services/cfUsage.ts (getTodayCfUsage).
  let cfPane: ReturnType<typeof CfUsagePane>;
  try {
    cfPane = CfUsagePane(await getTodayCfUsage(db));
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
