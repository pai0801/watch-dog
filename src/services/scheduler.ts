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

// NOTE: D1Database / Schedule / sendSlackAlert imports and the subrequest-budget
// constants (FIRE_BATCH_LIMIT=20, ALERT_BATCH_LIMIT=5, FETCH_TIMEOUT_MS=10_000)
// are added by the due-fire engine task — dropped here because unused imports
// fail tsc (noUnusedLocals) and ESLint (no-unused-vars) in this repo.

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
