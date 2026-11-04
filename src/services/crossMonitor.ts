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
// 2026-11-04 OPSCONT-006 方案 A（Peter 裁決 A+B+C）：45s → 300s。ops-control 端
// watch-dog host 的 staleSeconds 同步放寬（≥ 2× 間隔），慢拍不再誤判離線；
// fail-dead 語義不變——worker 死 → 無 fetch → piggyback 停 → 心跳停滯 → 告警。
const PIGGYBACK_INTERVAL_MS = 300_000;
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

// ===== Engine-path heartbeat cadence gate (2026-11-04, OPSCONT-006 方案 A) =====
// runEngineTick 的 cross-monitor 心跳原本每 tick（1/min，cron+trigger 雙源）
// 都發 = ~1,440+ 列/天灌進 ops-control heartbeats 表；與 piggyback（每 isolate
// 節流）合計 ~5.2k 列/天線性成長。本 gate 把 engine 路徑降為每 5 分鐘一拍。
//
// 為什麼記在 D1 settings 而非 module state：cron/trigger tick 可能落在不同
// isolate，module-level 節流對 engine 路徑不可靠（isolate 換新即重發）；
// settings PK 讀 1 列/tick（rows_read 可忽略），跨 isolate 唯一真源。
// 只在送出成功後才蓋章——送失敗下一 tick 重試，不吞心跳。
export const ENGINE_HEARTBEAT_INTERVAL_S = 300;

const ENGINE_HB_SETTING_KEY = 'ops_ctl_hb_last_sent';

/** True when an engine-path heartbeat is due (no stamp yet, or the last
 * successful send is older than ENGINE_HEARTBEAT_INTERVAL_S). */
export async function engineHeartbeatDue(db: D1Database, nowSec: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(ENGINE_HB_SETTING_KEY)
    .first<{ value: string }>();
  const last = row ? Number(row.value) : 0;
  return !Number.isFinite(last) || nowSec - last >= ENGINE_HEARTBEAT_INTERVAL_S;
}

/** Stamp the last successful engine-path send. Call ONLY after a send
 * returned true, so failures retry on the next tick. */
export async function markEngineHeartbeatSent(db: D1Database, nowSec: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?'
    )
    .bind(ENGINE_HB_SETTING_KEY, String(nowSec), nowSec, String(nowSec), nowSec)
    .run();
}
