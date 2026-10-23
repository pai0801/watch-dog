// src/routes/trigger.ts
// External engine trigger (2026-10-24): POST /api/engine/trigger — the
// rn1g VPS cron (1/min) uses this as a SECOND trigger source for the
// detection engine. CF cron dispatch is best-effort (chronically ~50s
// late on this account, boundary-crossing ticks get dropped — see
// FIX-LOG 2026-10-23/24); this endpoint keeps findDeadChecks + the
// scheduler hub running during CF scheduling outages. It also feeds the
// ops-control engine fuse: its heartbeats are tagged via='trigger'.
//
// Fail-dead note (invariant ①): this ADDS a trigger path; it can never
// disable or replace the CF cron path. Auth is a dedicated static Bearer
// token (TRIGGER_TOKEN, optional wiring — missing → fail-closed 503).
//
// Double-run containment: when CF cron is healthy both sources fire ~1/min.
// A cheap recency guard (self-health last_seen < 30s → skip) keeps the
// steady-state cost at one extra PK SELECT per minute; everything behind
// the guard is idempotent anyway (scheduler hub: at-most-once per period
// via next_run_at advance; dead-check scan: state machine, not counters).

import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { timingSafeEqual } from '../lib/auth';
import { runEngineTick } from '../cron';

const trigger = new Hono<{ Bindings: AppBindings }>();

/** Skip the engine pass if one ran within this window (double-source dedup). */
const RECENT_TICK_SKIP_MS = 30_000;

trigger.post('/api/engine/trigger', async (c) => {
  const token = c.env.TRIGGER_TOKEN;
  // Fail-closed, loud: optional wiring missing ≠ open endpoint.
  if (!token) return c.json({ error: 'trigger disabled (TRIGGER_TOKEN not set)' }, 503);

  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7), token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Recency guard: a CF cron tick (or another trigger) ran seconds ago →
  // this pass would duplicate work for no detection value. Report the skip
  // so the prober can distinguish "engine alive" from "work done".
  const self = await c.env.DB
    .prepare('SELECT last_seen FROM checks WHERE id = ?')
    .bind('watch-dog:self-health')
    .first<{ last_seen: number }>();
  const lastTickAgo = self?.last_seen ? Date.now() / 1000 - self.last_seen : Infinity;
  if (lastTickAgo < RECENT_TICK_SKIP_MS / 1000) {
    return c.json({ ok: true, skipped: true, lastTickAgoSec: Math.floor(lastTickAgo) });
  }

  await runEngineTick(c.env, Date.now(), 'trigger');
  return c.json({ ok: true, skipped: false });
});

export default trigger;
