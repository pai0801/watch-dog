// src/cron.ts
// Cron trigger handler: runs every minute to find dead checks and trigger alerts.

import type { ScheduledEvent } from '@cloudflare/workers-types';
import type { AppBindings, Check } from './types';
import { findDeadChecks, processCheckResult } from './services/logic';
import { pollCfUsage } from './services/cfUsage';
import { sendOpsControlHeartbeat } from './services/crossMonitor';
import { runDueSchedules } from './services/scheduler';
import { cleanupOldIssues, reportIssue } from './services/issues';
import type { Project } from './types';

/**
 * 引擎路徑錯誤 → 掛號進分診佇列（self-dogfood，WATCHDOG-016）。各引擎
 * catch 區塊本來只 console.error（靜默降級）；現在「偵測被跳過」這件事
 * 本身成為一筆可處置的 issue。fingerprint 固定 → 重複錯誤去重吸收，
 * 不會自我轟炸。
 *
 * 獨立 try/catch：掛號依賴 DB（可能與原錯誤同根因）＋專案列必須存在——
 * 掛號失敗只再 console.error，絕不在 catch 區塊裡二次拋出。
 */
const reportEngineError = async (
  env: AppBindings,
  fingerprint: string,
  what: string,
  e: unknown,
  severity: 'warning' | 'critical'
): Promise<void> => {
  try {
    const project = await env.DB
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind('watch-dog')
      .first<Project>();
    if (!project) return; // 專案列不存在（fresh DB）→ 只留 console.error
    await reportIssue(env.DB, project, {
      title: `${what}路徑錯誤（降級中）`,
      severity,
      fingerprint,
      message: String(e).slice(0, 2000),
    });
  } catch (err) {
    console.error(`report engine error failed (${fingerprint}):`, err);
  }
};

/**
 * One full engine pass — shared verbatim by the CF cron trigger and the
 * external trigger endpoint (POST /api/engine/trigger, rn1g VPS cron =
 * second trigger source, 2026-10-24). Same isolation classes, same order:
 * fail-dead path first, then usage poll, scheduler hub, cross-monitor.
 * `via` only tags the cross-monitor heartbeat source (ops-control engine
 * fuse); behavior is otherwise identical.
 */
export async function runEngineTick(
  env: AppBindings,
  scheduledTimeMs: number,
  via: 'cron' | 'trigger'
): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      // Log cleanup gate: run at the top of each hour, not every minute.
      // Cron fires every minute but old-log DELETE only needs hourly cadence —
      // 1440×/day was burning the shared-account D1 rows-read quota (~4M/day).
      // scheduledTime is the XX:00 firing but may drift by a few ms, so match
      // any second within the first minute after the hour boundary (< 60).
      const cleanupDue = Math.floor(scheduledTimeMs / 1000) % 3600 < 60;
      // CF usage poll gate: every 30 minutes, same drift-tolerant idiom.
      // (Kept independent from cleanupDue so the cadences can't entangle.)
      const usagePollDue = Math.floor(scheduledTimeMs / 1000) % 1800 < 60;

      try {
        // ===== Self-Monitoring: Watch-Dog monitors itself =====
        const selfCheckId = 'watch-dog:self-health';

        const selfCheck = await env.DB
          .prepare('SELECT * FROM checks WHERE id = ?')
          .bind(selfCheckId)
          .first<Check>();

        if (selfCheck) {
          // Update self-health with OK status (Cron is running!)
          await env.DB
            .prepare(`
              UPDATE checks SET
                status = 'ok',
                last_seen = ?,
                failure_count = 0,
                last_message = 'Cron heartbeat received'
              WHERE id = ?
            `)
            .bind(now, selfCheckId)
            .run();

          // Log the self-pulse
          await env.DB
            .prepare(`
              INSERT INTO logs (check_id, status, latency, message, created_at)
              VALUES (?, 'ok', 0, ?, ?)
            `)
            .bind(selfCheckId, 'Self-monitoring pulse via Cron', now)
            .run();
        }

        // ===== Find dead checks from other projects =====
        const deadChecks = await findDeadChecks(env.DB, now);

        for (const check of deadChecks) {
          if (check.id === selfCheckId) continue;

          const project = {
            id: check.project_id,
            token: check.token,
            display_name: check.project_name,
            maintenance_until: check.maintenance_until,
            created_at: check.created_at,
          };

          await processCheckResult(
            env.DB,
            check,
            project,
            'dead',
            `Heartbeat missed! Last seen: ${now - check.last_seen}s ago`
          );
        }

        // Clean old logs (7 days) — hourly, gated above (D1 rows-read quota:
        // relies on idx_logs_created_at; without it this was a full-table scan)
        if (cleanupDue) {
          await env.DB
            .prepare('DELETE FROM logs WHERE created_at < ?')
            .bind(now - 604800)
            .run();
          // CF usage state retention: 14 days of daily snapshots is ample
          // (carry-over only needs yesterday). day_utc lead of the PK makes
          // this a prefix range scan, not a full-table sweep.
          await env.DB
            .prepare("DELETE FROM cf_usage_state WHERE day_utc < date('now', '-14 days')")
            .run();
          // Issues collector retention (2026-10-31): resolved/done 30 天、
          // 事件史隨宿主刪 + 自身 90 天。低量表，與 logs 同班車無額度疑慮。
          await cleanupOldIssues(env.DB);
        }
      } catch (e) {
        console.error('Cron error:', e);
        // Self-dogfood（WATCHDOG-016）：fail-dead 引擎出錯 = 偵測被跳過，
        // 是「handled error 有降級後果」的教科書案例 → 掛號進分診佇列。
        await reportEngineError(env, 'watch-dog:engine-faildead', 'fail-dead 引擎', e, 'critical');
      }

      // ===== CF account usage poll (every 30 min, gated above) =====
      // Own try/catch, deliberately outside the fail-dead path above: a bug
      // or outage in the usage monitor must never compromise dead-service
      // detection (invariant ①). pollCfUsage itself never throws, but the
      // SELECT could (e.g. schema not yet applied post-deploy) — belt and
      // suspenders.
      if (usagePollDue) {
        try {
          const summary = await pollCfUsage(env.DB, scheduledTimeMs);
          if (summary.failures.length > 0) {
            console.error(
              `[cf-usage] poll failures: ${summary.failures.map((f) => `${f.label}: ${f.error}`).join('; ')}`
            );
          }
        } catch (e) {
          console.error('CF usage poll error:', e);
          await reportEngineError(env, 'watch-dog:engine-usage', 'CF 用量輪詢', e, 'warning');
        }
      }

      // ===== Scheduler hub: fire due schedule callbacks =====
      // Same isolation class as the usage poll above — its own try/catch,
      // deliberately AFTER the fail-dead path (invariant ①: a scheduler
      // bug must never compromise dead-service detection). runDueSchedules
      // contains per-fire failures but its due/projects SELECTs can throw —
      // THIS wrapper is the containment boundary, not belt-and-suspenders.
      try {
        await runDueSchedules(env.DB, now, scheduledTimeMs);
      } catch (e) {
        console.error('Scheduler hub error:', e);
        await reportEngineError(env, 'watch-dog:engine-scheduler', '排程樞紐', e, 'warning');
      }

      // ===== Cross-monitor: heartbeat to ops-control (independent account) =====
      // Same isolation class — own try/catch, after the fail-dead path. The
      // dead can't send their own obituary: when watch-dog dies this heartbeat
      // goes stale and ops-control alerts the operator (Slack + email-king).
      // Optional wiring: missing token/URL → sendOpsControlHeartbeat no-ops.
      try {
        await sendOpsControlHeartbeat(env, via);
      } catch (e) {
        console.error('Cross-monitor heartbeat error:', e);
        await reportEngineError(env, 'watch-dog:engine-crossmonitor', '跨監控心跳', e, 'warning');
      }
}

export const scheduled = async (
  event: ScheduledEvent,
  env: AppBindings,
  ctx: ExecutionContext
): Promise<void> => {
  ctx.waitUntil(runEngineTick(env, event.scheduledTime, 'cron'));
};
