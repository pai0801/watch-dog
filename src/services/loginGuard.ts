// src/services/loginGuard.ts
// D1-backed failure counter + lockout for the admin Basic-Auth surface
// (SEC-REVIEW 1a / TODO-REVIEW N2, 2026-11-06).
//
// Design (THINK N2, 2026-11-06):
// - ONE mechanism covers both SEC §1a layers: every admin request passes the
//   lock check (a hard cap on failed attempts per IP per window = the volume
//   bound), and the counter is the failure count / lockout layer.
// - D1, not KV: cross-isolate, and KV read-modify-write races would let a
//   concurrent burst all read the same count (SEC §2 陷阱 2). A single
//   UPSERT is atomic per statement in D1.
// - Key = cf-connecting-ip ONLY (陷阱 4: XFF is attacker-controlled). Local
//   dev (wrangler dev) may lack the header — a single 'local' bucket is the
//   honest fallback.
// - Write budget (D1 quota discipline): a locked IP is answered 429 with a
//   single indexed SELECT — no further writes. Normal operation records
//   near-zero failures.
// - Deliberately NOT in the alert path: a D1 outage inside the guard
//   degrades to "counting unavailable" (fail-open for the counter only) —
//   the timingSafeEqual credential check itself stays as the real gate.

import type { D1Database } from '@cloudflare/workers-types';

/** Lockout window in seconds (15 min). Locked out = count within window ≥ MAX_FAILURES. */
export const LOGIN_FAILURE_WINDOW_S = 900;
/** Failed attempts (per IP, per window) before lockout. */
export const LOGIN_FAILURE_MAX = 20;

/** Fallback bucket when cf-connecting-ip is absent (wrangler dev / local tools). */
export const LOCAL_IP_BUCKET = 'local';

/**
 * Atomically record one failed attempt. A single UPSERT: expired window
 * resets the count to 1, otherwise increments. Returns the live count so
 * callers can log/log the lock transition without a second read.
 */
export async function registerLoginFailure(
  db: D1Database,
  ip: string,
  now: number
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO login_failures (ip, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ? - window_start >= ? THEN excluded.window_start ELSE window_start END
       RETURNING count`
    )
    .bind(ip, now, now, LOGIN_FAILURE_WINDOW_S, now, LOGIN_FAILURE_WINDOW_S)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** Locked = ≥ MAX_FAILURES failures recorded inside the current window. */
export async function isLoginLocked(db: D1Database, ip: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT count FROM login_failures WHERE ip = ? AND ? - window_start < ?')
    .bind(ip, now, LOGIN_FAILURE_WINDOW_S)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= LOGIN_FAILURE_MAX;
}

/** Clear the counter after a successful authentication (no-op DELETE when clean). */
export async function clearLoginFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
}
