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
import { dispatchAlert, isInSilencePeriod, getSilencePeriod } from './alert';

// Claim the alert slot via CAS on last_alert_at: only the writer that flips
// it may send, so concurrent pulses / overlapping runs yield exactly one
// Slack alert (recovery and error paths share this claim). The SQL stays a
// single inline literal per the §B guard (no const indirection).
const claimAlertSlot = (db: D1Database, check: Check, now: number) =>
  db
    .prepare('UPDATE checks SET last_alert_at = ? WHERE id = ? AND last_alert_at = ?')
    .bind(now, check.id, check.last_alert_at)
    .run();

// ===== Email escalation (2026-09-10 incident) =====
// An error episode becomes email-worthy after ESCALATION_THRESHOLD error
// pulses within ESCALATION_WINDOW_SECONDS. Keyed on log history (append-only)
// rather than checks.failure_count: when one check multiplexes several jobs
// (e.g. ek-gateway pulsing all jobs into "jobs"), interleaved ok pulses from
// healthy jobs reset failure_count to 0 every couple of minutes — a
// consecutive counter would never fire while a real incident is ongoing
// (ek-gateway flap: failure_count oscillated 0↔1 for 45 minutes).
const ESCALATION_WINDOW_SECONDS = 900;
const ESCALATION_THRESHOLD = 3;

// ===== Ok-pulse log sampling (2026-11-03 quota incident) =====
// The logs table used to take one row per ok pulse (~32k rows/day across all
// checks) — the single largest writer on the shared-account D1 write quota
// (100k rows/day, account-level, post-facto hard-fail; 2026-11-02 actually
// exceeded it at 101,356). Detection NEVER reads these rows (fail-dead uses
// checks.last_seen; escalation counts error rows only), so steady-state ok
// rows are admin-viewer convenience, not evidence — the "unconditional put
// every minute" anti-pattern (quota discipline §3), never audited until the
// quota bit. Sampling rule, deterministic and stateless:
//   - non-ok -> ok (recovery): ALWAYS write — this is the transition
//     evidence an operator will want. (The CAS-lost racing path in
//     processCheckResult logs unconditionally for the same reason — it is
//     only reachable during a live incident.)
//   - steady-state ok: write only when the pulse crosses an hour boundary
//     since the previous pulse's last_seen (~1 row/check/hour for the admin
//     viewer). Zero schema change, zero extra reads, no new state.
export const shouldWriteOkLog = (prev: Pick<Check, 'status' | 'last_seen'>, now: number): boolean =>
  prev.status !== 'ok' || Math.floor(now / 3600) !== Math.floor(prev.last_seen / 3600);

/** Count error log rows for a check inside the escalation window. */
const countRecentErrors = (db: D1Database, checkId: string, now: number) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM logs
      WHERE check_id = ? AND status = 'error' AND created_at >= ?`
    )
    .bind(checkId, now - ESCALATION_WINDOW_SECONDS)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);

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
    // ===== ok-transition is a CAS on failure_count (TODO-REVIEW #19) =====
    // Error and dead writes bump the counter atomically; if it moved since
    // our snapshot, a fresher failure owns this row and a stale ok pulse
    // must not erase it (2026-09-10 incident, observed 04:15→04:16: the
    // clobber also erased the recovery that should have followed). Losing
    // the CAS degrades to advancing last_seen only — the pulse is still
    // recorded (fail-dead detection must never miss a heartbeat), but the
    // failure state stands until the next ok pulse that does not race a
    // failure; that pulse performs the recovery transition.
    const transition = await db
      .prepare(
        `UPDATE checks SET
          status = 'ok',
          last_seen = ?,
          failure_count = 0,
          last_message = ?
        WHERE id = ? AND failure_count = ?`
      )
      .bind(now, message, check.id, check.failure_count)
      .run();

    if ((transition.meta.changes ?? 0) !== 1) {
      // A fresher error/dead write owns the row now. Record the heartbeat
      // without regressing state; no recovery semantics may run on a
      // snapshot the row has already moved past. (Row gone = config
      // replace-set deleted it mid-flight: nothing to record.)
      const heartbeat = await db
        .prepare(
          `UPDATE checks SET
            last_seen = MAX(last_seen, ?),
            last_message = ?
          WHERE id = ?`
        )
        .bind(now, message, check.id)
        .run();
      // Unsampled on purpose: this path is only reachable while a failure
      // write raced us (failure_count moved since our snapshot) — i.e. during
      // a live incident. Race-path pulses are exactly the evidence an
      // operator will want, and steady state never reaches this branch.
      if ((heartbeat.meta.changes ?? 0) === 1) {
        await writeLog();
      }
      return;
    }

    // Recovery: previously failed and past its threshold.
    const shouldRecover = check.status !== 'ok' && check.failure_count >= check.threshold;

    // ===== Recovery email gating (fix A) =====
    // The email channel is page-worthy only: a recovery emails when the
    // episode was DEAD (critical level) or had escalated (sustained errors).
    // Recovering from a plain warning never emails — that was the
    // orphan-recovery bug (operators got "recovered" for failures they were
    // never told about, because warnings are Slack-only).
    // An escalated episode resolves only when the error window has drained:
    // interleaved ok pulses from healthy jobs sharing the check must not
    // "resolve" an incident that is still erroring. CAS on the flag makes
    // the resolution fire exactly once.
    let sendRecoveryEmail = check.status === 'dead';
    let resolveEpisode = false;
    if (check.escalated === 1) {
      const recentErrors = await countRecentErrors(db, check.id, now);
      if (recentErrors === 0) {
        const release = await db
          .prepare('UPDATE checks SET escalated = 0 WHERE id = ? AND escalated = 1')
          .bind(check.id)
          .run();
        resolveEpisode = (release.meta.changes ?? 0) === 1;
        sendRecoveryEmail = sendRecoveryEmail || resolveEpisode;
      }
    }

    // Claim the recovery alert first: concurrent ok pulses after a failure
    // streak must yield exactly one alert.
    let sendRecovery = false;
    if (shouldRecover) {
      const claim = await claimAlertSlot(db, check, now);
      sendRecovery = (claim.meta.changes ?? 0) === 1;
    }

    // Ok-pulse log sampling (see shouldWriteOkLog): recovery transitions
    // (snapshot status was error/dead) always log; steady-state ok pulses
    // log once per hour boundary. The checks-row update above is the
    // detection write and is NOT sampled — fail-dead semantics untouched.
    if (shouldWriteOkLog(check, now)) {
      await writeLog();
    }

    if (sendRecovery || resolveEpisode) {
      await dispatchAlert(db, {
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
        emailWorthy: sendRecoveryEmail,
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

  // ===== Escalation: sustained errors reach the email channel =====
  // Sliding-window count from the logs (this pulse makes it sustainedCount).
  // Deliberately NOT gated on the silence period: interleaved ok pulses keep
  // resetting last_alert_at via recovery claims — exactly the incident shape
  // where a human still needs to be paged. Dedup: CAS on the escalated flag
  // → one escalation email per episode (no re-nag while the flag is set).
  let escalate = false;
  let sustainedCount = 0;
  if (newStatus === 'error' && !inMaintenance && check.escalated === 0) {
    sustainedCount = (await countRecentErrors(db, check.id, now)) + 1;
    if (sustainedCount >= ESCALATION_THRESHOLD) {
      const claim = await db
        .prepare('UPDATE checks SET escalated = 1 WHERE id = ? AND escalated = 0')
        .bind(check.id)
        .run();
      escalate = (claim.meta.changes ?? 0) === 1;
    }
  }

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
      const claim = await claimAlertSlot(db, check, now);
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

  // Escalation dispatches even when the silence period suppressed the plain
  // warning (see above) — that suppression is how a sustained incident could
  // previously page nobody.
  if (wantsAlert || escalate) {
    const title =
      newStatus === 'dead' ? 'Service DEAD' : escalate ? 'Service Warning — Sustained' : 'Service Warning';
    const level = newStatus === 'dead' ? 'critical' : 'warning';

    await dispatchAlert(db, {
      checkId: check.id,
      projectName: project.display_name,
      checkName: check.display_name || check.name,
      level,
      title,
      message: escalate
        ? `${message} (sustained: ${sustainedCount} errors in ${ESCALATION_WINDOW_SECONDS / 60}min — escalated to email)`
        : `${message} (Failures: ${projectedFailures})`,
      metadata: {
        Failures: projectedFailures,
        Threshold: check.threshold,
        Interval: `${check.interval}s`,
        Grace: `${check.grace}s`,
      },
      emailWorthy: escalate || newStatus === 'dead',
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
