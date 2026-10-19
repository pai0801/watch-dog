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

import type { AppBindings } from '../types';

/** Send one heartbeat to ops-control. No-op (returns false) when the
 *  optional token/URL isn't configured. Never throws to the caller. */
export async function sendOpsControlHeartbeat(env: AppBindings): Promise<boolean> {
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
      // (heartbeat staleness) is meaningful for this host.
      body: JSON.stringify({ host: 'watch-dog', sentinelOk: true, internetOk: true }),
      signal: AbortSignal.timeout(5_000),
    });
    void res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}
