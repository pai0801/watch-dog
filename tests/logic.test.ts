// tests/logic.test.ts
// State-machine tests for processCheckResult + findDeadChecks.
//
// These cover the alerting invariants that keep the dead-man's-switch
// trustworthy: threshold, silence period, maintenance, recovery.

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { processCheckResult, findDeadChecks } from '../src/services/logic';
import type { Check } from '../src/types';
import {
  DB,
  TEST_EMAIL,
  TEST_SLACK,
  getCheck,
  countLogs,
  resetDb,
  seedCheck,
  seedProject,
  setEmailSettings,
  setSlackSettings,
} from './utils';

const nowSec = () => Math.floor(Date.now() / 1000);

let slackCalls: string[] = [];

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
  slackCalls = [];
  network.use(
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      slackCalls.push(await request.text());
      return HttpResponse.json({ ok: true });
    })
  );
});

describe('processCheckResult — ok transitions', () => {
  it('keeps a healthy check healthy; same-hour ok pulse is log-sampled away (2026-11-03 quota slimming)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id); // last_seen = now (same hour)

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    // Detection write is unsampled — the heartbeat advanced...
    expect(updated?.last_seen).toBeGreaterThanOrEqual(check.last_seen);
    // ...but the ok log row is not written (same hour bucket as prev pulse).
    expect(await countLogs(check.id)).toBe(0);
    expect(slackCalls.length).toBe(0); // no alert for a plain OK pulse
  });

  it('writes an ok log row when the pulse crosses an hour boundary', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_seen: nowSec() - 3600 });

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    expect(await countLogs(check.id)).toBe(1);
  });

  it('writes the first pulse of a freshly registered check (last_seen=0 crosses the bucket)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_seen: 0 });

    await processCheckResult(DB, check, project, 'ok', 'first pulse');

    expect(await countLogs(check.id)).toBe(1);
  });

  it('always logs a recovery pulse regardless of hour bucket (transition evidence)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'error', failure_count: 3 });

    await processCheckResult(DB, check, project, 'ok', 'recovered');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(await countLogs(check.id)).toBe(1);
    expect(slackCalls.length).toBe(1); // recovery alert fires
  });

  it('sends a recovery alert when a threshold-failed check goes ok', async () => {
    const project = await seedProject();
    // Previously failed past threshold (e.g. cron marked it dead)
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 3 });

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(slackCalls.length).toBe(1);
  });

  it('does NOT send recovery when the check never crossed its threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'error', failure_count: 0, threshold: 3 });

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    expect(slackCalls.length).toBe(0);
  });
});

describe('processCheckResult — failure transitions', () => {
  it('increments failure_count without alerting below the threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 3 });

    await processCheckResult(DB, check, project, 'error', 'db down');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('error');
    expect(updated?.failure_count).toBe(1);
    expect(slackCalls.length).toBe(0);
  });

  it('sends a warning alert when failure_count reaches the threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 2, failure_count: 1 });

    await processCheckResult(DB, check, project, 'error', 'db down');

    const updated = await getCheck(check.id);
    expect(updated?.failure_count).toBe(2);
    expect(updated?.last_alert_at).toBeGreaterThan(0);
    expect(slackCalls.length).toBe(1);
  });

  it('sends a critical alert when the cron marks a check dead', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, {});

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead');
    expect(slackCalls.length).toBe(1);
  });

  it('suppresses alerts during maintenance mode', async () => {
    const project = await seedProject({ maintenance_until: nowSec() + 600 });
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead'); // state still recorded
    expect(slackCalls.length).toBe(0); // but no alert
  });

  it('respects the silence period for repeat failures', async () => {
    const project = await seedProject();
    // Alerted 100s ago; silence period is 3600s
    const check = await seedCheck(project.id, { last_alert_at: nowSec() - 100 });

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(0); // still silenced
    const updated = await getCheck(check.id);
    expect(updated?.failure_count).toBe(1); // counter still advances
  });

  it('alerts again once the silence period has elapsed', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_alert_at: nowSec() - 4000 });

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(1);
  });
});

describe('per-check cooldown overrides the global silence period', () => {
  it('a short cooldown lets an alert through while global silence would suppress it', async () => {
    const project = await seedProject();
    // Global silence is 3600s; this check wants a 60s cooldown and was
    // alerted 100s ago — under the old code (global only) it stayed muted
    // for an hour, which is the bug.
    const check = await seedCheck(project.id, { cooldown: 60, last_alert_at: nowSec() - 100 });

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(1);
    expect((await getCheck(check.id))?.status).toBe('dead');
  });

  it('cooldown=0 falls back to the global silence period', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { cooldown: 0, last_alert_at: nowSec() - 100 });

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(0); // global 3600s still silences
  });
});

describe('alert channel routing', () => {
  const channelOf = (call: string) => (JSON.parse(call) as { channel: string }).channel;

  it('routes critical (dead) alerts to the critical channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(1);
    expect(channelOf(slackCalls[0])).toBe(TEST_SLACK.channel_critical);
  });

  it('routes warning (error) alerts to the warning channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 2, failure_count: 1 });

    await processCheckResult(DB, check, project, 'error', 'db down');

    expect(slackCalls.length).toBe(1);
    expect(channelOf(slackCalls[0])).toBe(TEST_SLACK.channel_warning);
  });

  it('routes recovery alerts to the success channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 1 });

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    expect(slackCalls.length).toBe(1);
    expect(channelOf(slackCalls[0])).toBe(TEST_SLACK.channel_success);
  });
});

describe('concurrency invariants (D1 CAS)', () => {
  it('a dead-mark never clobbers a fresher pulse', async () => {
    const project = await seedProject();
    // The cron fetched this stale object...
    const check = await seedCheck(project.id, { last_seen: nowSec() - 3600 });
    // ...but the service pulsed a moment later, before the cron's UPDATE ran.
    const fresher = nowSec();
    await DB.prepare('UPDATE checks SET last_seen = ? WHERE id = ?').bind(fresher, check.id).run();

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok'); // pulse state preserved
    expect(updated?.last_seen).toBe(fresher);
    expect(updated?.failure_count).toBe(0); // dead-path increment never ran
    expect(await countLogs(check.id)).toBe(0); // no log for the aborted transition
    expect(slackCalls.length).toBe(0); // and certainly no alert
  });

  it('dead-marking preserves last_seen (when the service was actually heard from)', async () => {
    const project = await seedProject();
    const lastSeen = nowSec() - 3600;
    const check = await seedCheck(project.id, { last_seen: lastSeen });

    await processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead');
    expect(updated?.last_seen).toBe(lastSeen); // not stamped with "now"
  });

  it('two overlapping dead-marks produce exactly one alert and one increment', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_seen: nowSec() - 3600 });

    // Same stale object, as two cron runs that fetched the row concurrently.
    await Promise.all([
      processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!'),
      processCheckResult(DB, check, project, 'dead', 'Heartbeat missed!'),
    ]);

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead');
    expect(updated?.failure_count).toBe(1); // incremented once
    expect(slackCalls.length).toBe(1); // alerted once
  });

  it('concurrent error pulses count every failure but alert once', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 1 });

    await Promise.all([
      processCheckResult(DB, check, project, 'error', 'db down #1'),
      processCheckResult(DB, check, project, 'error', 'db down #2'),
    ]);

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('error');
    expect(updated?.failure_count).toBe(2); // both pulses counted (SQL-atomic)
    expect(slackCalls.length).toBe(1); // but the alert claim was won once
  });

  it('concurrent ok pulses after a failure yield exactly one recovery alert', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 1 });

    await Promise.all([
      processCheckResult(DB, check, project, 'ok', 'Pulse A'),
      processCheckResult(DB, check, project, 'ok', 'Pulse B'),
    ]);

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(slackCalls.length).toBe(1); // single recovery notification
  });

  it('a stale ok pulse never erases a fresher error (2026-09-10 incident race, TODO-REVIEW #19)', async () => {
    const project = await seedProject();
    // Pulse A (healthy job) fetched this snapshot...
    const check = await seedCheck(project.id, { threshold: 1 });
    // ...but an error pulse committed before A's UPDATE ran (the racing error
    // path's SQL-atomic increment), as observed live 04:15→04:16 on ek-gateway.
    await DB.prepare(
      "UPDATE checks SET status = 'error', failure_count = failure_count + 1, last_message = 'status_push: 500' WHERE id = ?"
    ).bind(check.id).run();

    await processCheckResult(DB, check, project, 'ok', 'tracking_pull');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('error'); // the failure state stands
    expect(updated?.failure_count).toBe(1); // not reset by the stale snapshot
    // The heartbeat is still recorded — fail-dead detection must never miss a pulse
    expect(updated?.last_seen).toBeGreaterThanOrEqual(check.last_seen);
    expect(await countLogs(check.id)).toBe(1); // the ok pulse is logged
    expect(slackCalls.length).toBe(0); // and no recovery off a stale snapshot
  });

  it('the next ok pulse that does not race a failure performs the recovery transition', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 1 });
    // Leave the check in an error state a stale ok could not clear (see test above)
    await DB.prepare(
      "UPDATE checks SET status = 'error', failure_count = failure_count + 1 WHERE id = ?"
    ).bind(check.id).run();

    // Next tick: no error interleaves — the ok pulse wins cleanly.
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'ok', 'tracking_pull');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(slackCalls.length).toBe(1); // recovery fires exactly once, deterministically
  });
});

describe('findDeadChecks', () => {
  it('returns only stale, monitored heartbeat checks', async () => {
    const project = await seedProject();
    const now = nowSec();

    await seedCheck(project.id, { name: 'stale', id: `${project.id}:stale`, last_seen: now - 3600, interval: 300, grace: 60 });
    await seedCheck(project.id, { name: 'fresh', id: `${project.id}:fresh`, last_seen: now, interval: 300, grace: 60 });
    await seedCheck(project.id, { name: 'disabled', id: `${project.id}:disabled`, last_seen: now - 3600, monitor: 0 });
    await seedCheck(project.id, { name: 'already-dead', id: `${project.id}:already-dead`, last_seen: now - 3600, status: 'dead' });
    await seedCheck(project.id, { name: 'event-check', id: `${project.id}:event-check`, last_seen: now - 3600, type: 'event' });

    const dead = await findDeadChecks(DB, now);
    expect(dead.map((c: Check) => c.id)).toEqual([`${project.id}:stale`]);
  });
});

describe('dispatchAlert — dual channel (Slack + email-king gateway)', () => {
  let ekCalls: string[];
  let slackBodies: string[];

  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
    await setEmailSettings();
    ekCalls = [];
    slackBodies = [];
    network.use(
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        slackBodies.push(await request.text());
        return HttpResponse.json({ ok: true });
      }),
      http.post(TEST_EMAIL.email_gateway_url, async ({ request }) => {
        ekCalls.push(await request.text());
        return HttpResponse.json({ status: 'sent', message_id: 'm1' });
      }),
    );
  });

  it('critical (dead) alerts hit BOTH channels — email carries recipient + subject', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'dead', 'no pulse received');

    expect(slackBodies).toHaveLength(1);
    expect(ekCalls).toHaveLength(1);
    expect(ekCalls[0]).toContain(TEST_EMAIL.email_recipient);
    expect(ekCalls[0]).toContain('watch-dog');
  });

  it('warning alerts stay Slack-only (inbox reserved for real outages)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'error', 'boom');

    expect(slackBodies).toHaveLength(1);
    expect(ekCalls).toHaveLength(0);
  });

  it('email gateway failure never blocks the Slack path', async () => {
    network.use(http.post(TEST_EMAIL.email_gateway_url, () => HttpResponse.json({}, { status: 500 })));
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'dead', 'no pulse received'); // must not throw

    expect(slackBodies).toHaveLength(1);
    expect(ekCalls).toHaveLength(0);
  });
});

describe('email escalation — sustained failures reach the inbox', () => {
  let ekCalls: string[];
  let slackBodies: string[];

  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
    await setEmailSettings();
    ekCalls = [];
    slackBodies = [];
    network.use(
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        slackBodies.push(await request.text());
        return HttpResponse.json({ ok: true });
      }),
      http.post(TEST_EMAIL.email_gateway_url, async ({ request }) => {
        ekCalls.push(await request.text());
        return HttpResponse.json({ status: 'sent', message_id: 'm1' });
      }),
    );
  });

  /** Seed a raw error log row with a controlled timestamp (window tests). */
  const seedErrorLog = (checkId: string, createdAt: number) =>
    DB.prepare("INSERT INTO logs (check_id, status, latency, message, created_at) VALUES (?, 'error', 0, 'seeded error', ?)")
      .bind(checkId, createdAt)
      .run();

  it('escalates to email on the 3rd error within the window — even while ok pulses keep resetting failure_count and the silence clock (2026-09-10 ek-gateway incident regression)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id); // threshold=1, cooldown=900

    // Error #1 → plain warning (Slack only)
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'error', 'status_push: 500');
    expect(ekCalls).toHaveLength(0);

    // Healthy job's ok pulse 2 minutes later — resets failure_count to 0 and
    // (today's bug) would fire an orphan recovery email
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'ok', 'tracking_pull');
    expect(ekCalls).toHaveLength(0); // orphan recovery email is GONE

    // Error #2 → warning silenced (recovery claim reset last_alert_at)
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'error', 'status_push: 500');
    expect(ekCalls).toHaveLength(0);

    // Another interleaved ok pulse
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'ok', 'tracking_pull');
    expect(ekCalls).toHaveLength(0);

    // Error #3 → 3rd error in the sliding window → ESCALATION EMAIL
    await processCheckResult(DB, (await getCheck(check.id))!, project, 'error', 'status_push: 500');

    expect(ekCalls).toHaveLength(1);
    expect(ekCalls[0]).toContain('Sustained'); // subject: "Service Warning — Sustained"
    const updated = await getCheck(check.id);
    expect(updated?.escalated).toBe(1); // episode flagged as email-worthy
  });

  it('a single transient error never reaches the inbox (warning stays Slack-only)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, check, project, 'error', 'one-off blip');
    expect(slackBodies).toHaveLength(1); // warning to Slack
    expect(ekCalls).toHaveLength(0); // but not email

    await processCheckResult(DB, (await getCheck(check.id))!, project, 'ok', 'Pulse received');
    expect(ekCalls).toHaveLength(0); // and its recovery is Slack-only too (fix A)
    expect((await getCheck(check.id))?.escalated).toBe(0);
  });

  it('does not count errors older than the 15-minute window (window slides)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);
    // Three errors, but all outside the window
    for (let i = 0; i < 3; i++) await seedErrorLog(check.id, nowSec() - 901 - i);

    await processCheckResult(DB, check, project, 'error', 'fresh failure');

    expect(ekCalls).toHaveLength(0); // 0 prior + 1 current = 1 < 3 → no escalation
    expect((await getCheck(check.id))?.escalated).toBe(0);
  });

  it('concurrent error pulses at the escalation threshold produce exactly one escalation email (CAS)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);
    // Two errors already in the window; two more pulses race to be the 3rd/4th
    await seedErrorLog(check.id, nowSec() - 60);
    await seedErrorLog(check.id, nowSec() - 30);

    await Promise.all([
      processCheckResult(DB, check, project, 'error', 'race A'),
      processCheckResult(DB, check, project, 'error', 'race B'),
    ]);

    expect(ekCalls).toHaveLength(1); // escalation claimed exactly once
    expect((await getCheck(check.id))?.escalated).toBe(1);
  });

  it('suppresses escalation during maintenance mode (like every other alert)', async () => {
    const project = await seedProject({ maintenance_until: nowSec() + 600 });
    const check = await seedCheck(project.id);
    await seedErrorLog(check.id, nowSec() - 60);
    await seedErrorLog(check.id, nowSec() - 30);

    await processCheckResult(DB, check, project, 'error', 'maintained failure');

    expect(ekCalls).toHaveLength(0);
    expect((await getCheck(check.id))?.escalated).toBe(0);
  });
});

describe('recovery email gating — no orphan recovery (fix A)', () => {
  let ekCalls: string[];
  let slackBodies: string[];

  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
    await setEmailSettings();
    ekCalls = [];
    slackBodies = [];
    network.use(
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        slackBodies.push(await request.text());
        return HttpResponse.json({ ok: true });
      }),
      http.post(TEST_EMAIL.email_gateway_url, async ({ request }) => {
        ekCalls.push(await request.text());
        return HttpResponse.json({ status: 'sent', message_id: 'm1' });
      }),
    );
  });

  it('recovery from a dead check still emails (email-worthy episode, unchanged)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 3 });

    await processCheckResult(DB, check, project, 'ok', 'Pulse received');

    expect(ekCalls).toHaveLength(1);
    expect(ekCalls[0]).toContain('Recovered');
    expect(slackBodies).toHaveLength(1);
  });

  it('escalated episode: interleaved ok pulses while the error window is still hot send NO email', async () => {
    const project = await seedProject();
    // Episode already escalated, still erroring
    const check = await seedCheck(project.id, { status: 'error', failure_count: 1, escalated: 1 });
    // Error still inside the window → episode unresolved
    await DB.prepare("INSERT INTO logs (check_id, status, latency, message, created_at) VALUES (?, 'error', 0, 'still failing', ?)")
      .bind(check.id, nowSec() - 60)
      .run();

    await processCheckResult(DB, check, project, 'ok', 'tracking_pull');

    expect(ekCalls).toHaveLength(0); // no email for an unresolved episode
    expect((await getCheck(check.id))?.escalated).toBe(1); // flag survives
    expect(slackBodies).toHaveLength(1); // Slack still gets the flap detail
  });

  it('escalated episode resolves when the error window drains: exactly ONE recovery email, flag cleared', async () => {
    const project = await seedProject();
    // Escalated episode; last error is now outside the window (episode over)
    const check = await seedCheck(project.id, { escalated: 1 });
    await DB.prepare("INSERT INTO logs (check_id, status, latency, message, created_at) VALUES (?, 'error', 0, 'old failure', ?)")
      .bind(check.id, nowSec() - 901)
      .run();

    await processCheckResult(DB, check, project, 'ok', 'tracking_pull');

    expect(ekCalls).toHaveLength(1);
    expect(ekCalls[0]).toContain('Recovered');
    expect((await getCheck(check.id))?.escalated).toBe(0);
  });

  it('resolution fires once even under concurrent ok pulses (CAS on the flag)', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { escalated: 1 });
    // window empty

    await Promise.all([
      processCheckResult(DB, check, project, 'ok', 'Pulse A'),
      processCheckResult(DB, check, project, 'ok', 'Pulse B'),
    ]);

    expect(ekCalls).toHaveLength(1);
    expect((await getCheck(check.id))?.escalated).toBe(0);
  });
});
