// src/routes/dashboard.ts
// Public monitoring dashboard (GET /).

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppBindings, Check, Project } from '../types';
import { Layout } from '../views/layout';
import { DashboardContent, ErrorState, ProjectGrid } from '../views/dashboard';

const dashboard = new Hono<{ Bindings: AppBindings }>();

/**
 * GET /
 * Dashboard main page
 * Renders the monitoring dashboard with all projects and checks
 * Supports HTMX polling for auto-refresh (every 30s)
 */
dashboard.get('/', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const isHtmx = c.req.header('HX-Request');

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
      return c.html(projectGrid as any);
    }

    // Full page: stats + grid
    return c.html(Layout({ content: DashboardContent(stats, projectGrid) }) as any);
  } catch (error) {
    console.error('Dashboard error:', error);
    if (isHtmx) {
      return c.html(ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.') as any);
    }
    return c.html(
      Layout({ content: ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.') }) as any
    );
  }
});

export default dashboard;
