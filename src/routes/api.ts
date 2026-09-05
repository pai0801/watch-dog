// src/routes/api.ts
// Machine-facing API routes: config, pulse, maintenance, status.
//
// Auth model:
// - /api/config, /api/pulse, /api/maintenance: project token required
//   (Authorization: Bearer {token}; legacy X-Project-Token removed 2026-09-04).
// - /api/status: public read-only status feed (documented behavior).

import { Hono } from 'hono';
import type { AppBindings, Check, ConfigPayload, Project, PulsePayload } from '../types';
import { extractProjectToken, authenticateProject, timingSafeEqual } from '../lib/auth';
import { clampInt, isValidCheckName, isValidProjectId } from '../lib/validate';
import { processCheckResult } from '../services/logic';
import { setMaintenance } from '../services/maintenance';

const api = new Hono<{ Bindings: AppBindings }>();

/**
 * PUT /api/config
 * Update project and check configurations for an operator-created project
 * (registration itself is closed — see the handler body).
 */
api.put('/api/config', async (c) => {
  const db = c.env.DB;

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
    // WD-02 replace-set: absent-from-payload checks of this project get
    // deleted (plus their logs). Default false keeps pure upsert semantics.
    const replaceSet = body.checks_replace === true;

    // Validate required fields
    if (!project_id || !display_name) {
      return c.json({ error: 'Missing required fields: project_id, display_name' }, 400);
    }

    // Project ids are interpolated into URLs, HTML attributes and check ids —
    // constrain the charset at ingestion instead of trusting output escaping.
    if (!isValidProjectId(project_id)) {
      return c.json(
        { error: 'Invalid project_id: use 1-63 chars of lowercase letters, digits or hyphens (must start alphanumeric)' },
        400
      );
    }

    if (!checks || !Array.isArray(checks)) {
      return c.json({ error: 'Missing or invalid checks array' }, 400);
    }

    // Closed registration (2026-09-05, TODO-REVIEW #17/#18): projects are
    // created by the operator via /admin only. Open self-registration let
    // anyone with the URL mint checks and then spam the alert channels (a
    // check that never pulses fires DEAD alerts into Slack). Config on an
    // existing project still needs only that project's token.
    const existingProject = await db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind(project_id)
      .first<Project>();

    if (!existingProject) {
      return c.json(
        { error: 'Project not found. Registration is closed — ask the operator to create it via /admin.' },
        404,
      );
    }
    if (!timingSafeEqual(existingProject.token, token)) {
      return c.json({ error: 'Invalid token for project' }, 403);
    }

    // Project row exists (operator-created); the client may rename its display
    await db
      .prepare('UPDATE projects SET display_name = ? WHERE id = ?')
      .bind(display_name, project_id)
      .run();

    // Upsert checks
    let registered = 0;
    const registeredNames: string[] = [];
    for (const checkConfig of checks) {
      const {
        name,
        display_name: checkDisplayName,
        type,
        interval: rawInterval = 300,
        grace: rawGrace = 60,
        threshold: rawThreshold = 1,
        cooldown: rawCooldown = 900,
      } = checkConfig;

      // Validate check config
      if (!name || !type) {
        continue;
      }

      if (type !== 'heartbeat' && type !== 'event') {
        continue;
      }

      // Check names become `{projectId}:{name}` ids rendered in URLs and the
      // admin UI; constrain the charset at ingestion.
      if (!isValidCheckName(name)) {
        continue;
      }

      // Clamp numerics so nonsense values (interval=0, negative grace,
      // strings) cannot silently break the dead-man's-switch math.
      const interval = clampInt(rawInterval, 10, 300);
      const grace = clampInt(rawGrace, 0, 60);
      const threshold = clampInt(rawThreshold, 1, 1);
      const cooldown = clampInt(rawCooldown, 0, 900);

      // Optional monitor toggle (WD-02): 0/1 updates it; absent keeps the
      // stored value. Two static statements instead of a dynamic column
      // list — the §B guard requires literal SQL in prepare calls.
      const monitor = checkConfig.monitor === 0 || checkConfig.monitor === 1 ? checkConfig.monitor : null;

      const checkId = `${project_id}:${name}`;

      if (monitor !== null) {
        await db
          .prepare(`
            INSERT INTO checks (
              id, project_id, name, display_name, type,
              interval, grace, threshold, cooldown, monitor,
              last_seen, status, failure_count, last_alert_at, last_message
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok', 0, 0, NULL)
            ON CONFLICT (id) DO UPDATE SET
              display_name = ?,
              type = ?,
              interval = ?,
              grace = ?,
              threshold = ?,
              cooldown = ?,
              monitor = ?
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
            monitor,
            checkDisplayName || name,
            type,
            interval,
            grace,
            threshold,
            cooldown,
            monitor
          )
          .run();
      } else {
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
      registered++;
      registeredNames.push(name);
    }

    // WD-02 replace-set: remove this project's checks absent from the
    // payload (and their logs). Per-row static deletes — dynamic IN lists
    // would violate the §B literal guard. Scoped to this project only.
    let checksDeleted = 0;
    if (replaceSet) {
      const existingChecks = await db
        .prepare('SELECT name FROM checks WHERE project_id = ?')
        .bind(project_id)
        .all<{ name: string }>();
      const keep = new Set(registeredNames);
      for (const row of existingChecks.results) {
        if (!keep.has(row.name)) {
          const removedId = `${project_id}:${row.name}`;
          await db.prepare('DELETE FROM logs WHERE check_id = ?').bind(removedId).run();
          await db.prepare('DELETE FROM checks WHERE id = ?').bind(removedId).run();
          checksDeleted++;
        }
      }
    }

    return c.json({
      success: true,
      project_id,
      message: replaceSet ? 'Configuration updated (replace-set)' : 'Configuration updated',
      checks_registered: registered,
      checks_deleted: checksDeleted,
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
