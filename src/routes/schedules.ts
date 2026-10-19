// src/routes/schedules.ts
// Scheduler-hub registration API: projects manage their own callback
// schedules with their existing project token (Bearer). Admin observes
// read-only via GET /admin/schedules — there is deliberately NO admin
// write path (operator decision 2026-10-19).
//
// Design: docs/plans/2026-10-19-scheduler-hub-design.md (dumb ticker).

import { Hono, type Context } from 'hono';
import type { AppBindings, Schedule, ScheduleCreatePayload, ScheduleUpdatePayload } from '../types';
import { authenticateProject } from '../lib/auth';
import { clampRange, isValidCheckName, isValidProjectId } from '../lib/validate';
import { toHex } from '../services/scheduler';

const schedules = new Hono<{ Bindings: AppBindings }>();

/** Everything except the secret — the response shape for all reads. */
function publicSchedule(s: Schedule): Omit<Schedule, 'secret'> {
  const { secret: _secret, ...rest } = s;
  return rest;
}

/** 32 random bytes as hex — same entropy class as the project tokens. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * https-only, bounded length — the hub POSTs this URL on every fire.
 * SSRF containment is the closed registration model itself (operator-created
 * projects, token-authed) inside a single-operator system; https-only is
 * defense in depth, not the boundary.
 */
function isValidCallbackUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://') && url.length <= 500;
}

/**
 * Load the :id schedule and verify the caller owns it: authenticate the
 * project named by ?project_id=, then require schedule.project_id match.
 * Mismatch -> 404 (no existence oracle across projects).
 */
async function loadOwnedSchedule(
  c: Context<{ Bindings: AppBindings }>
): Promise<{ schedule: Schedule } | Response> {
  const projectId = c.req.query('project_id');
  if (!projectId) {
    return c.json({ error: 'Missing required query: project_id' }, 400);
  }
  const auth = await authenticateProject(c, projectId);
  if (auth instanceof Response) return auth;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid schedule id' }, 400);
  }
  const schedule = await c.env.DB
    .prepare('SELECT * FROM schedules WHERE id = ?')
    .bind(id)
    .first<Schedule>();
  if (!schedule || schedule.project_id !== projectId) {
    return c.json({ error: 'Schedule not found' }, 404);
  }
  return { schedule };
}

/**
 * POST /api/schedules — register a callback schedule.
 * The per-schedule secret is returned EXACTLY ONCE, here.
 */
schedules.post('/api/schedules', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  let body: ScheduleCreatePayload;
  try {
    body = await c.req.json<ScheduleCreatePayload>();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { project_id, name, callback_url } = body;
  if (!project_id || !name || !callback_url) {
    return c.json({ error: 'Missing required fields: project_id, name, callback_url' }, 400);
  }
  // Same charset gate as /api/config: malformed ids should read as "invalid
  // input" (400), not "unknown project" (404).
  if (!isValidProjectId(project_id)) {
    return c.json(
      { error: 'Invalid project_id: use 1-63 chars of lowercase letters, digits or hyphens (must start alphanumeric)' },
      400
    );
  }
  const auth = await authenticateProject(c, project_id);
  if (auth instanceof Response) return auth;

  if (!isValidCheckName(name)) {
    return c.json(
      { error: 'Invalid name: use 1-64 chars of letters, digits, _ or - (alphanumeric first)' },
      400
    );
  }
  if (!isValidCallbackUrl(callback_url)) {
    return c.json({ error: 'Invalid callback_url: must be an https:// URL of at most 500 chars' }, 400);
  }
  // Numeric fields must be actual JSON numbers — Number() coerces "60" and
  // true silently, and retry_count: true → 1 would silently enable retrying
  // (fail loud on type, not just finiteness).
  if (
    body.interval_minutes !== undefined &&
    (typeof body.interval_minutes !== 'number' || !Number.isFinite(body.interval_minutes))
  ) {
    return c.json({ error: 'interval_minutes must be a number' }, 400);
  }
  if (
    body.retry_count !== undefined &&
    (typeof body.retry_count !== 'number' || !Number.isFinite(body.retry_count))
  ) {
    return c.json({ error: 'retry_count must be a number' }, 400);
  }
  if (
    body.alert_after_failures !== undefined &&
    (typeof body.alert_after_failures !== 'number' || !Number.isFinite(body.alert_after_failures))
  ) {
    return c.json({ error: 'alert_after_failures must be a number' }, 400);
  }

  const interval = clampRange(body.interval_minutes ?? 60, 1, 10080, 60);
  const retry = clampRange(body.retry_count ?? 0, 0, 1, 0);
  const alertAfter = clampRange(body.alert_after_failures ?? 0, 0, 100, 0);
  const secret = generateSecret();
  const nextRunAt = now + interval * 60;

  const result = await db
    .prepare(
      `INSERT INTO schedules (
        project_id, name, callback_url, interval_minutes, secret,
        retry_count, alert_after_failures, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO NOTHING`
    )
    .bind(project_id, name, callback_url, interval, secret, retry, alertAfter, nextRunAt)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'Schedule name already exists for this project' }, 409);
  }
  const id = result.meta.last_row_id;

  // Input-built response — no re-SELECT, no null branch; the stored row is
  // exactly the bound values plus engine bookkeeping defaults.
  const schedule: Omit<Schedule, 'secret'> = {
    id,
    project_id,
    name,
    callback_url,
    interval_minutes: interval,
    retry_count: retry,
    alert_after_failures: alertAfter,
    next_run_at: nextRunAt,
    last_run_at: null,
    last_status: null,
    consecutive_failures: 0,
    paused: 0,
    created_at: now,
  };
  return c.json({ success: true, schedule: { ...schedule, secret } });
});

/** GET /api/schedules?project_id=... — list the caller's own schedules. */
schedules.get('/api/schedules', async (c) => {
  const projectId = c.req.query('project_id');
  if (!projectId) {
    return c.json({ error: 'Missing required query: project_id' }, 400);
  }
  const auth = await authenticateProject(c, projectId);
  if (auth instanceof Response) return auth;

  const rows = await c.env.DB
    .prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY name')
    .bind(projectId)
    .all<Schedule>();
  return c.json({ schedules: rows.results.map(publicSchedule) });
});

/** GET /api/schedules/:id?project_id=... */
schedules.get('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  return c.json({ schedule: publicSchedule(owned.schedule) });
});

/**
 * PUT /api/schedules/:id?project_id=... — update own schedule.
 * Changing interval does NOT recompute next_run_at: the new cadence applies
 * from the next advance (documented in docs/api.md).
 */
schedules.put('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  const { schedule } = owned;
  const db = c.env.DB;

  let body: ScheduleUpdatePayload;
  try {
    body = await c.req.json<ScheduleUpdatePayload>();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Fail loud on wrong-typed or non-finite numerics — silently clamping to
  // the fallback would store a cadence the caller never asked for.
  if (
    body.interval_minutes !== undefined &&
    (typeof body.interval_minutes !== 'number' || !Number.isFinite(body.interval_minutes))
  ) {
    return c.json({ error: 'interval_minutes must be a number' }, 400);
  }
  if (
    body.retry_count !== undefined &&
    (typeof body.retry_count !== 'number' || !Number.isFinite(body.retry_count))
  ) {
    return c.json({ error: 'retry_count must be a number' }, 400);
  }
  if (
    body.alert_after_failures !== undefined &&
    (typeof body.alert_after_failures !== 'number' || !Number.isFinite(body.alert_after_failures))
  ) {
    return c.json({ error: 'alert_after_failures must be a number' }, 400);
  }
  // paused must be 0 or 1 when present — silent-ignore would leave the
  // caller believing a mute took effect when it did not.
  if (body.paused !== undefined && body.paused !== 0 && body.paused !== 1) {
    return c.json({ error: 'Invalid paused: must be 0 or 1' }, 400);
  }

  const name = body.name === undefined ? null : isValidCheckName(body.name) ? body.name : null;
  if (body.name !== undefined && name === null) {
    return c.json({ error: 'Invalid name' }, 400);
  }
  const url =
    body.callback_url === undefined ? null : isValidCallbackUrl(body.callback_url) ? body.callback_url : null;
  if (body.callback_url !== undefined && url === null) {
    return c.json({ error: 'Invalid callback_url' }, 400);
  }
  if (name !== null && name !== schedule.name) {
    const clash = await db
      .prepare('SELECT id FROM schedules WHERE project_id = ? AND name = ?')
      .bind(schedule.project_id, name)
      .first();
    if (clash) {
      return c.json({ error: 'Schedule name already exists for this project' }, 409);
    }
  }

  const interval =
    body.interval_minutes === undefined ? null : clampRange(body.interval_minutes, 1, 10080, 60);
  const retry = body.retry_count === undefined ? null : clampRange(body.retry_count, 0, 1, 0);
  const alertAfter =
    body.alert_after_failures === undefined ? null : clampRange(body.alert_after_failures, 0, 100, 0);
  const paused = body.paused === undefined ? null : body.paused;

  await db
    .prepare(
      `UPDATE schedules SET
        name = COALESCE(?, name),
        callback_url = COALESCE(?, callback_url),
        interval_minutes = COALESCE(?, interval_minutes),
        retry_count = COALESCE(?, retry_count),
        alert_after_failures = COALESCE(?, alert_after_failures),
        paused = COALESCE(?, paused)
      WHERE id = ?`
    )
    .bind(name, url, interval, retry, alertAfter, paused, schedule.id)
    .run();

  const row = await db.prepare('SELECT * FROM schedules WHERE id = ?').bind(schedule.id).first<Schedule>();
  return c.json({ success: true, schedule: row ? publicSchedule(row) : null });
});

/** DELETE /api/schedules/:id?project_id=... */
schedules.delete('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  await c.env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(owned.schedule.id).run();
  return c.json({ success: true, deleted: owned.schedule.id });
});

export default schedules;
