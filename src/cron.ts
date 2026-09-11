// src/cron.ts
// Cron trigger handler: runs every minute to find dead checks and trigger alerts.

import type { ScheduledEvent } from '@cloudflare/workers-types';
import type { AppBindings, Check } from './types';
import { findDeadChecks, processCheckResult } from './services/logic';
import { pollCfUsage } from './services/cfUsage';

export const scheduled = async (
  event: ScheduledEvent,
  env: AppBindings,
  ctx: ExecutionContext
): Promise<void> => {
  ctx.waitUntil(
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      // Log cleanup gate: run at the top of each hour, not every minute.
      // Cron fires every minute but old-log DELETE only needs hourly cadence —
      // 1440×/day was burning the shared-account D1 rows-read quota (~4M/day).
      // scheduledTime is the XX:00 firing but may drift by a few ms, so match
      // any second within the first minute after the hour boundary (< 60).
      const cleanupDue = Math.floor(event.scheduledTime / 1000) % 3600 < 60;
      // CF usage poll gate: every 30 minutes, same drift-tolerant idiom.
      // (Kept independent from cleanupDue so the cadences can't entangle.)
      const usagePollDue = Math.floor(event.scheduledTime / 1000) % 1800 < 60;

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
        }
      } catch (e) {
        console.error('Cron error:', e);
      }

      // ===== CF account usage poll (every 30 min, gated above) =====
      // Own try/catch, deliberately outside the fail-dead path above: a bug
      // or outage in the usage monitor must never compromise dead-service
      // detection (invariant ①). pollCfUsage itself never throws, but the
      // SELECT could (e.g. schema not yet applied post-deploy) — belt and
      // suspenders.
      if (usagePollDue) {
        try {
          const summary = await pollCfUsage(env.DB, event.scheduledTime);
          if (summary.failures.length > 0) {
            console.error(
              `[cf-usage] poll failures: ${summary.failures.map((f) => `${f.label}: ${f.error}`).join('; ')}`
            );
          }
        } catch (e) {
          console.error('CF usage poll error:', e);
        }
      }
    })()
  );
};
