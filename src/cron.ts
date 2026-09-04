// src/cron.ts
// Cron trigger handler: runs every minute to find dead checks and trigger alerts.

import type { ScheduledEvent } from '@cloudflare/workers-types';
import type { AppBindings, Check } from './types';
import { findDeadChecks, processCheckResult } from './services/logic';

export const scheduled = async (
  _event: ScheduledEvent,
  env: AppBindings,
  ctx: ExecutionContext
): Promise<void> => {
  ctx.waitUntil(
    (async () => {
      const now = Math.floor(Date.now() / 1000);

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

        // Clean old logs (7 days)
        await env.DB
          .prepare('DELETE FROM logs WHERE created_at < ?')
          .bind(now - 604800)
          .run();
      } catch (e) {
        console.error('Cron error:', e);
      }
    })()
  );
};
