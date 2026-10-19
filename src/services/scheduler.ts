// src/services/scheduler.ts
// Scheduler hub (dumb ticker): fires registered callbacks on their interval.
//
// Design contract (docs/plans/2026-10-19-scheduler-hub-design.md):
// - The hub is deliberately dumb: it wakes targets at their registered
//   interval and nothing else. Precision control, debouncing, idempotency
//   and missed-tick self-healing all live in the TARGET (register
//   interval_minutes=1 and self-throttle for high precision).
// - next_run_at is advanced BEFORE firing (at-most-once per period): a
//   failing target waits a full period, never gets re-hammered each tick.
// - No auto-pause (operator decision 2026-10-19): a paused job is a silent
//   failure. Failures are made visible (last_status/consecutive_failures
//   + optional Slack warning), not acted on.
// - Subrequest budget: <=20 fires x (1+retry) + <=5 alerts = <=45 external
//   fetches per tick (Free plan cap: 50/invocation).

import type { D1Database } from '@cloudflare/workers-types';
import type { Schedule } from '../types';
import { sendSlackAlert } from './alert';

/** Hex-encode helper — single implementation shared by signing and
 *  secret generation (14-DESIGN-PRINCIPLES §2 rule 1: no second copy). */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256(secret, message) as lowercase hex (Web Crypto only). */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * Build the callback signature header: `t=<firedAt>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${firedAt}.${scheduleId}.${scheduledAt}`).
 *
 * Targets verify with the same recipe (docs/client-guide.md) and reject
 * timestamps outside a freshness window (replay defense).
 */
export async function signScheduleHeader(
  secret: string,
  scheduleId: number,
  scheduledAt: number,
  firedAt: number
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${firedAt}.${scheduleId}.${scheduledAt}`);
  return `t=${firedAt},v1=${v1}`;
}

// Subrequest budget (Free plan cap: 50/invocation):
// <=20 fires x (1+retry) + <=5 alerts = <=45 external fetches per tick.
const FIRE_BATCH_LIMIT = 20;
const ALERT_BATCH_LIMIT = 5;
const FETCH_TIMEOUT_MS = 10_000;

/** One callback delivery. Returns true on 2xx ack. */
async function fireSchedule(s: Schedule, scheduledAt: number): Promise<boolean> {
  const firedAt = Math.floor(Date.now() / 1000);
  const signature = await signScheduleHeader(s.secret, s.id, scheduledAt, firedAt);
  const body = JSON.stringify({ schedule_id: s.id, scheduled_at: scheduledAt, fired_at: firedAt });

  const attempt = (): Promise<Response> =>
    fetch(s.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Schedule-Signature': signature },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  let ok: boolean;
  try {
    const res = await attempt();
    res.body?.cancel().catch(() => {});
    ok = res.ok;
  } catch {
    ok = false;
  }
  // Optional single retry — registration choice, never hub policy.
  if (!ok && s.retry_count === 1) {
    try {
      const res = await attempt();
      res.body?.cancel().catch(() => {});
      ok = res.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * Fire every due schedule (paused = 0 AND next_run_at <= now), at most
 * FIRE_BATCH_LIMIT per tick; leftovers fire on the next tick (late but
 * not lost — ORDER BY next_run_at serves the most overdue first).
 *
 * Throw surface: per-fire failures are contained (Promise.allSettled +
 * per-alert error logging), but the due SELECT, the projects SELECT and
 * getAllSettings inside sendSlackAlert sit OUTSIDE that containment and can
 * still throw (e.g. schema not yet applied post-deploy) — the cron.ts
 * wrapper try/catch is the containment boundary (invariant ①), NOT
 * belt-and-suspenders.
 *
 * Single-cron-instance assumption: at-most-once correctness relies on cron
 * invocations not overlapping. A pathological tail (~20s fire phase + up to
 * 5x10s sequential alert sends ≈ 70s) can exceed the 1-min interval;
 * consequences are bounded — target-side idempotency, and scheduledAt in
 * the signature makes replays detectable client-side.
 */
export async function runDueSchedules(
  db: D1Database,
  now: number,
  scheduledTimeMs: number
): Promise<void> {
  const scheduledAt = Math.floor(scheduledTimeMs / 1000);
  const due = await db
    .prepare('SELECT * FROM schedules WHERE paused = 0 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?')
    .bind(now, FIRE_BATCH_LIMIT)
    .all<Schedule>();
  if (due.results.length === 0) return;

  const alertTargets: Schedule[] = [];
  await Promise.allSettled(
    due.results.map(async (s) => {
      // Advance BEFORE firing: at-most-once per period. If the isolate dies
      // mid-fire the job waits a full period instead of being retried
      // every minute.
      await db
        .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
        .bind(now + s.interval_minutes * 60, s.id)
        .run();

      const ok = await fireSchedule(s, scheduledAt);
      const failures = ok ? 0 : s.consecutive_failures + 1;
      await db
        .prepare('UPDATE schedules SET last_run_at = ?, last_status = ?, consecutive_failures = ? WHERE id = ?')
        .bind(now, ok ? 'ok' : 'fail', failures, s.id)
        .run();

      // Crossing alert (alert_after_failures = 0 = off). Exact-equality
      // fires once per crossing; flapping re-crossings re-alert by design
      // (visible, never silent).
      if (!ok && s.alert_after_failures > 0 && failures === s.alert_after_failures) {
        alertTargets.push({ ...s, consecutive_failures: failures });
      }
    })
  );

  if (alertTargets.length === 0) return;
  // Resolve project display names for the alert text (small table, one read).
  const projects = await db.prepare('SELECT id, display_name FROM projects').all<{
    id: string;
    display_name: string;
  }>();
  const nameById = new Map(projects.results.map((p) => [p.id, p.display_name]));
  for (const s of alertTargets.slice(0, ALERT_BATCH_LIMIT)) {
    // Direct send — warning level never emails; deliberately not dispatchAlert.
    const result = await sendSlackAlert(db, {
      checkId: `schedule:${s.id}`,
      projectName: nameById.get(s.project_id) ?? s.project_id,
      checkName: s.name,
      level: 'warning',
      title: '排程回呼連續失敗',
      message: `${s.name} 已連續失敗 ${s.consecutive_failures} 次（門檻 ${s.alert_after_failures}），目標未回 2xx。`,
      metadata: {
        schedule_id: s.id,
        interval_minutes: s.interval_minutes,
        consecutive_failures: s.consecutive_failures,
      },
    });
    if (!result.ok) {
      console.error(`[scheduler] alert send failed for schedule ${s.id}: ${result.error}`);
    }
  }
}
