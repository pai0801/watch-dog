// src/services/crossMonitor.ts
// Cross-monitor heartbeat: watch-dog pulses to ops-control (an INDEPENDENT
// CF account) every cron tick. When watch-dog dies, its heartbeat goes
// stale → ops-control detects offline → Slack + email-king email to the
// operator. The dead can't send their own obituary — that's this module's
// entire reason to exist (2026-10-19, operator request).
//
// Optional wiring (10-SECRETS-CONTRACT §5.2): missing OPS_CONTROL_HOST_TOKEN
// → silent skip — a cross-monitor outage must never compromise the core
// sentinel (same isolation philosophy as the scheduler hub).

import type { ExecutionContext } from '@cloudflare/workers-types';
import type { AppBindings } from '../types';

/** Heartbeat source tag. ops-control's engine fuse distinguishes engine
 *  runs (cron / external trigger) from fetch-path piggyback refreshes —
 *  a host whose freshest heartbeats are ALL 'fetch' may have a dead
 *  detection engine while the worker keeps serving (2026-10-24). */
export type HeartbeatSource = 'cron' | 'trigger' | 'fetch';

/** Send one heartbeat to ops-control. No-op (returns false) when the
 *  optional token/URL isn't configured. Never throws to the caller.
 *  Failures are logged (console.error) — tail-visible — so cross-monitor
 *  outages are diagnosable instead of silently swallowed. */
export async function sendOpsControlHeartbeat(
  env: AppBindings,
  via: HeartbeatSource = 'cron'
): Promise<boolean> {
  const url = env.OPS_CONTROL_HEARTBEAT_URL;
  const token = env.OPS_CONTROL_HOST_TOKEN;
  if (!url || !token) return false;

  try {
    const res = await fetch(`${url}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      // sentinel fields don't apply to watch-dog; only offline detection
      // (heartbeat staleness) is meaningful for this host. `via` tells
      // ops-control which path produced this heartbeat (engine fuse).
      body: JSON.stringify({ host: 'watch-dog', sentinelOk: true, internetOk: true, via }),
      signal: AbortSignal.timeout(5_000),
    });
    void res.body?.cancel().catch(() => {});
    if (!res.ok) {
      console.error(`[cross-monitor] heartbeat rejected (via=${via}): ${res.status} ${url}`);
    }
    return res.ok;
  } catch (e) {
    console.error(`[cross-monitor] heartbeat failed (via=${via}): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ===== Fetch-path piggyback (2026-10-23 dispatch-jitter incident) =====
// CF scheduled events on this account chronically dispatch ~50s late and,
// under load, cross minute boundaries where at-most-once-per-minute
// coalescing DROPS them (observed 2-8 min heartbeat gaps → ops-control
// false "offline" CRITICALs). Fetch dispatch is unaffected by the scheduler
// queue, and monitored projects' pulses arrive ~every 20s via the fetch
// handler — an alive worker can keep its heartbeat fresh from the request
// path. Fail-dead intact: a dead worker takes no requests → no piggyback.
//
// Deliberate trade-off (operator decision 2026-10-23): this MASKS the
// "cron engine dead while fetch alive" failure class — and since healthy
// monitored projects pulse continuously, that masking is INDEFINITE while
// fetch traffic flows (not merely delayed detection): cron death surfaces
// to ops-control only once traffic stops too. Dispatch jitter of that shape
// is not page-worthy; true worker death stays detected. If that judgment
// changes, the fix is an ops-control-side signal (e.g. alert when only
// fetch-path heartbeats arrive for > N minutes) — gating here on self-health
// freshness would defeat the piggyback's entire purpose (jitter gaps ARE
// self-health staleness).
//
// Module-level throttle: each isolate throttles independently (harmless —
// ops-control dedupes same-second inserts; KV/D1 cost stays O(pulses)).
const PIGGYBACK_INTERVAL_MS = 45_000;
let lastPiggybackMs = 0;

/** Fire-and-forget heartbeat refresh from the fetch path. Never throws,
 *  never blocks the request. No-op when the optional wiring is absent. */
export function piggybackOpsControlHeartbeat(
  env: AppBindings,
  ctx: Pick<ExecutionContext, 'waitUntil'>
): void {
  const url = env.OPS_CONTROL_HEARTBEAT_URL;
  const token = env.OPS_CONTROL_HOST_TOKEN;
  if (!url || !token) return;
  const now = Date.now();
  if (now - lastPiggybackMs < PIGGYBACK_INTERVAL_MS) return;
  lastPiggybackMs = now;
  ctx.waitUntil(
    sendOpsControlHeartbeat(env, 'fetch').catch(() => {
      /* containment only — sendOpsControlHeartbeat never throws */
    })
  );
}

/** Test-only: reset the piggyback throttle (module state persists across
 *  tests within a file; each test needs a fresh window). */
export function resetPiggybackThrottleForTests(): void {
  lastPiggybackMs = 0;
}
