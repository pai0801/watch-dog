// src/services/logic.ts
// State machine logic for check processing in Watch-Dog Sentinel
//
// Concurrency model (D1 has no transactions across statements):
// - failure_count is incremented in SQL, never from the in-memory object,
//   so concurrent pulses count correctly.
// - Alert sending is guarded by a compare-and-swap on last_alert_at:
//   only the writer that flips it may send, so duplicate/racing runs
//   produce exactly one Slack alert.
// - 'dead' transitions CAS on last_seen AND status: a pulse that arrived
//   after findDeadChecks fetched the row is never clobbered, and two
//   overlapping cron runs mark dead at most once.

import { D1Database } from '@cloudflare/workers-types';
import { Check, Project } from '../types';
import { sendSlackAlert, isInSilencePeriod, getSilencePeriod } from './alert';

export async function processCheckResult(
  db: D1Database,
  check: Check,
  project: Project,
  newStatus: 'ok' | 'error' | 'dead',
  message: string,
  latency: number = 0
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const globalSilence = await getSilencePeriod(db);
  // A per-check cooldown overrides the global silence period when set.
  const silencePeriod = check.cooldown > 0 ? check.cooldown : globalSilence;

  const writeLog = () =>
    db
      .prepare(
        `INSERT INTO logs (check_id, status, latency, message, created_at)
        VALUES (?, ?, ?, ?, ?)`
      )
      .bind(check.id, newStatus, latency, message, now)
      .run();

  if (newStatus === 'ok') {
    // Recovery: previously failed and past its threshold.
    const shouldRecover = check.status !== 'ok' && check.failure_count >= check.threshold;

    // Claim the recovery alert first: concurrent ok pulses after a failure
    // streak must yield exactly one alert.
    let sendRecovery = false;
    if (shouldRecover) {
      const claim = await db
        .prepare('UPDATE checks SET last_alert_at = ? WHERE id = ? AND last_alert_at = ?')
        .bind(now, check.id, check.last_alert_at)
        .run();
      sendRecovery = (claim.meta.changes ?? 0) === 1;
    }

    await db
      .prepare(
        `UPDATE checks SET
          status = 'ok',
          last_seen = ?,
          failure_count = 0,
          last_message = ?
        WHERE id = ?`
      )
      .bind(now, message, check.id)
      .run();

    await writeLog();

    if (sendRecovery) {
      await sendSlackAlert(db, {
        checkId: check.id,
        projectName: project.display_name,
        checkName: check.display_name || check.name,
        level: 'recovery',
        title: 'Service Recovered',
        message,
        metadata: {
          Threshold: check.threshold,
          Interval: `${check.interval}s`,
          Grace: `${check.grace}s`,
        },
      });
    }
    return;
  }

  // ----- error / dead -----

  // Projection for the alert decision only; the stored failure_count is
  // incremented atomically in SQL below.
  const projectedFailures = check.failure_count + 1;
  const inMaintenance = project.maintenance_until > now;
  const hitThreshold = projectedFailures >= check.threshold;
  const outsideSilence = !isInSilencePeriod(check.last_alert_at, silencePeriod, now);
  let wantsAlert = !inMaintenance && hitThreshold && outsideSilence;

  if (newStatus === 'dead') {
    // CAS on last_seen (a fresher pulse won the race — bail out entirely;
    // the pulse records its own event) and on status != 'dead' (another
    // cron run already marked it). last_seen is NOT advanced: the public
    // feed must keep showing when the service was actually last heard from.
    const res = await db
      .prepare(
        `UPDATE checks SET
          status = 'dead',
          failure_count = failure_count + 1,
          last_alert_at = ?,
          last_message = ?
        WHERE id = ? AND last_seen = ? AND status != 'dead'`
      )
      .bind(wantsAlert ? now : check.last_alert_at, message, check.id, check.last_seen)
      .run();

    if ((res.meta.changes ?? 0) === 0) {
      return;
    }
  } else {
    // Claim the alert before sending; the state update itself is unconditional.
    if (wantsAlert) {
      const claim = await db
        .prepare('UPDATE checks SET last_alert_at = ? WHERE id = ? AND last_alert_at = ?')
        .bind(now, check.id, check.last_alert_at)
        .run();
      if ((claim.meta.changes ?? 0) === 0) {
        wantsAlert = false; // a racing writer already alerted
      }
    }

    await db
      .prepare(
        `UPDATE checks SET
          status = 'error',
          last_seen = ?,
          failure_count = failure_count + 1,
          last_message = ?
        WHERE id = ?`
      )
      .bind(now, message, check.id)
      .run();
  }

  await writeLog();

  if (wantsAlert) {
    const title = newStatus === 'dead' ? 'Service DEAD' : 'Service Warning';
    const level = newStatus === 'dead' ? 'critical' : 'warning';

    await sendSlackAlert(db, {
      checkId: check.id,
      projectName: project.display_name,
      checkName: check.display_name || check.name,
      level,
      title,
      message: `${message} (Failures: ${projectedFailures})`,
      metadata: {
        Failures: projectedFailures,
        Threshold: check.threshold,
        Interval: `${check.interval}s`,
        Grace: `${check.grace}s`,
      },
    });
  }
}

export async function findDeadChecks(
  db: D1Database,
  now: number
): Promise<Array<Check & { project_name: string; maintenance_until: number; token: string; created_at: number }>> {
  const result = await db
    .prepare(
      `SELECT c.*, p.display_name as project_name, p.maintenance_until, p.token, p.created_at
      FROM checks c
      JOIN projects p ON c.project_id = p.id
      WHERE c.type = 'heartbeat'
      AND c.status != 'dead'
      AND c.monitor = 1
      AND (c.last_seen + c.interval + c.grace) < ?`
    )
    .bind(now)
    .all<Check & { project_name: string; maintenance_until: number; token: string; created_at: number }>();

  return result.results;
}
