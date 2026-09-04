// src/routes/api.ts
// Machine-facing API routes: config, pulse, maintenance, status.
//
// Auth model:
// - /api/config, /api/pulse, /api/maintenance: project token required
//   (Authorization: Bearer {token} or legacy X-Project-Token header).
// - /api/status: public read-only status feed (documented behavior).

import { Hono } from 'hono';
import type { AppBindings, Check, ConfigPayload, Project, PulsePayload } from '../types';
import { extractProjectToken, authenticateProject, timingSafeEqual } from '../lib/auth';
import { processCheckResult } from '../services/logic';
import { setMaintenance } from '../services/maintenance';

const api = new Hono<{ Bindings: AppBindings }>();

/**
 * PUT /api/config
 * Register or update project and check configurations
 */
api.put('/api/config', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  const token = extractProjectToken(c);
  if (!token) {
    return c.json({ error: 'Missing Authorization header (use: Authorization: Bearer {token})' }, 401);
  }

  try {
    const body = await c.req.json<ConfigPayload & {
      project_id: string;
      display_name: string;
    }>();

    const { project_id, display_name, checks } = body;

    // Validate required fields
    if (!project_id || !display_name) {
      return c.json({ error: 'Missing required fields: project_id, display_name' }, 400);
    }

    if (!checks || !Array.isArray(checks)) {
      return c.json({ error: 'Missing or invalid checks array' }, 400);
    }

    // Verify token matches existing project (creating a new project is open,
    // but hijacking an existing project id requires its token)
    const existingProject = await db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind(project_id)
      .first<Project>();

    if (existingProject && !timingSafeEqual(existingProject.token, token)) {
      return c.json({ error: 'Invalid token for project' }, 403);
    }

    // Upsert project
    await db
      .prepare(`
        INSERT INTO projects (id, token, display_name, maintenance_until, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT (id) DO UPDATE SET
          display_name = ?
      `)
      .bind(project_id, token, display_name, now, display_name)
      .run();

    // Upsert checks
    for (const checkConfig of checks) {
      const {
        name,
        display_name: checkDisplayName,
        type,
        interval = 300,
        grace = 60,
        threshold = 1,
        cooldown = 900,
      } = checkConfig;

      // Validate check config
      if (!name || !type) {
        continue;
      }

      if (type !== 'heartbeat' && type !== 'event') {
        continue;
      }

      const checkId = `${project_id}:${name}`;

      await db
        .prepare(`
          INSERT INTO checks (
            id, project_id, name, display_name, type,
            interval, grace, threshold, cooldown,
            last_seen, status, failure_count, last_alert_at, last_message
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok', 0, 0, NULL)
          ON CONFLICT (id) DO UPDATE SET
            display_name = ?,
            type = ?,
            interval = ?,
            grace = ?,
            threshold = ?,
            cooldown = ?
        `)
        .bind(
          checkId,
          project_id,
          name,
          checkDisplayName || name,
          type,
          interval,
          grace,
          threshold,
          cooldown,
          checkDisplayName || name,
          type,
          interval,
          grace,
          threshold,
          cooldown
        )
        .run();
    }

    return c.json({
      success: true,
      project_id,
      message: 'Configuration updated',
      checks_registered: checks.length,
    });
  } catch (error) {
    console.error('Config error:', error);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

/**
 * POST /api/pulse
 * Receive heartbeat pulse from a service
 */
api.post('/api/pulse', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  const token = extractProjectToken(c);
  if (!token) {
    return c.json({ error: 'Missing Authorization header (use: Authorization: Bearer {token})' }, 401);
  }

  try {
    const body = await c.req.json<PulsePayload & { project_id?: string }>();
    const { project_id: projectIdFromBody, check_name, status = 'ok', message, latency } = body;

    if (!check_name) {
      return c.json({ error: 'Missing check_name' }, 400);
    }

    // Resolve the project: either verify token against the given project_id,
    // or look the project up by token directly.
    let project: Project | null;
    if (projectIdFromBody) {
      project = await db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .bind(projectIdFromBody)
        .first<Project>();
      if (!project) {
        return c.json({ error: 'Invalid token for project' }, 403);
      }
      if (!timingSafeEqual(project.token, token)) {
        return c.json({ error: 'Invalid token for project' }, 403);
      }
    } else {
      project = await db
        .prepare('SELECT * FROM projects WHERE token = ?')
        .bind(token)
        .first<Project>();
      if (!project) {
        return c.json({ error: 'Invalid token' }, 403);
      }
    }

    const projectId = project.id;
    const checkId = `${projectId}:${check_name}`;

    // Get check
    const check = await db
      .prepare('SELECT * FROM checks WHERE id = ?')
      .bind(checkId)
      .first<Check>();

    if (!check) {
      return c.json({ error: 'Check not found. Register via /api/config first.' }, 404);
    }

    // Process the pulse result
    const newStatus: 'ok' | 'error' = status === 'error' ? 'error' : 'ok';
    const pulseMessage = message || (status === 'error' ? 'Service reported error' : 'Pulse received');

    await processCheckResult(
      db,
      c.env,
      check,
      project,
      newStatus,
      pulseMessage,
      latency ?? 0
    );

    return c.json({
      success: true,
      check_id: checkId,
      status: newStatus,
      timestamp: now,
    });
  } catch (error) {
    console.error('Pulse error:', error);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

/**
 * POST /api/maintenance/:projectId
 * Toggle maintenance mode for a project (requires the project token).
 *
 * Note: this endpoint was previously unauthenticated — anyone could mute
 * alerts for any project. It now uses the same token auth as /api/pulse.
 */
api.post('/api/maintenance/:projectId', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const projectId = c.req.param('projectId');

  const auth = await authenticateProject(c, projectId);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = await c.req.json<{ duration?: number; enabled?: boolean }>();
    const result = await setMaintenance(db, auth, body, now);

    return c.json({
      success: true,
      project_id: projectId,
      maintenance_mode: result.maintenance_mode,
      maintenance_until: result.maintenance_until,
    });
  } catch (error) {
    console.error('Maintenance error:', error);
    return c.json({ error: 'Invalid request' }, 400);
  }
});

/**
 * GET /api/status
 * Get all projects and their checks (public, read-only)
 */
api.get('/api/status', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  try {
    const projectsResult = await db
      .prepare('SELECT * FROM projects ORDER BY display_name')
      .all<Project>();

    const projects = projectsResult.results;

    const checksResult = await db
      .prepare('SELECT * FROM checks ORDER BY project_id, name')
      .all<Check>();

    const checks = checksResult.results;

    // Public feed: never expose project tokens
    const projectsWithChecks = projects.map(({ token: _token, ...project }) => ({
      ...project,
      in_maintenance: project.maintenance_until > now,
      checks: checks
        .filter((check) => check.project_id === project.id)
        .map((check) => ({
          ...check,
          is_stale: check.type === 'heartbeat' && (check.last_seen + check.interval + check.grace) < now,
        })),
    }));

    return c.json({
      projects: projectsWithChecks,
      timestamp: now,
    });
  } catch (error) {
    console.error('Status error:', error);
    return c.json({ error: 'Failed to fetch status' }, 500);
  }
});

/**
 * GET /api/status/:projectId
 * Get status for a specific project (public, read-only)
 */
api.get('/api/status/:projectId', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const projectId = c.req.param('projectId');

  try {
    const project = await db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind(projectId)
      .first<Project>();

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const checksResult = await db
      .prepare('SELECT * FROM checks WHERE project_id = ? ORDER BY name')
      .bind(projectId)
      .all<Check>();

    const checks = checksResult.results.map((check) => ({
      ...check,
      is_stale: check.type === 'heartbeat' && (check.last_seen + check.interval + check.grace) < now,
    }));

    return c.json({
      project: {
        // Public feed: never expose the project token
        ...(({ token: _token, ...rest }) => rest)(project),
        in_maintenance: project.maintenance_until > now,
      },
      checks,
      timestamp: now,
    });
  } catch (error) {
    console.error('Status error:', error);
    return c.json({ error: 'Failed to fetch status' }, 500);
  }
});

export default api;
