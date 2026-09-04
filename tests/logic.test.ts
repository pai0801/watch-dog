// tests/logic.test.ts
// State-machine tests for processCheckResult + findDeadChecks.
//
// These cover the alerting invariants that keep the dead-man's-switch
// trustworthy: threshold, silence period, maintenance, recovery.

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { processCheckResult, findDeadChecks } from '../src/services/logic';
import type { Check, Project } from '../src/types';
import {
  DB,
  TEST_ENV,
  TEST_SLACK,
  getCheck,
  countLogs,
  resetDb,
  seedCheck,
  seedProject,
  setSlackSettings,
} from './utils';

const nowSec = () => Math.floor(Date.now() / 1000);

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'test-project',
  token: 'test-token-1234567890',
  display_name: 'Test Project',
  maintenance_until: 0,
  created_at: nowSec(),
  ...overrides,
});

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
  it('keeps a healthy check healthy and writes a log row', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse received');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(await countLogs(check.id)).toBe(1);
    expect(slackCalls.length).toBe(0); // no alert for a plain OK pulse
  });

  it('sends a recovery alert when a threshold-failed check goes ok', async () => {
    const project = await seedProject();
    // Previously failed past threshold (e.g. cron marked it dead)
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 3 });

    await processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse received');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(slackCalls.length).toBe(1);
  });

  it('does NOT send recovery when the check never crossed its threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'error', failure_count: 0, threshold: 3 });

    await processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse received');

    expect(slackCalls.length).toBe(0);
  });
});

describe('processCheckResult — failure transitions', () => {
  it('increments failure_count without alerting below the threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 3 });

    await processCheckResult(DB, TEST_ENV, check, project, 'error', 'db down');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('error');
    expect(updated?.failure_count).toBe(1);
    expect(slackCalls.length).toBe(0);
  });

  it('sends a warning alert when failure_count reaches the threshold', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 2, failure_count: 1 });

    await processCheckResult(DB, TEST_ENV, check, project, 'error', 'db down');

    const updated = await getCheck(check.id);
    expect(updated?.failure_count).toBe(2);
    expect(updated?.last_alert_at).toBeGreaterThan(0);
    expect(slackCalls.length).toBe(1);
  });

  it('sends a critical alert when the cron marks a check dead', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, {});

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead');
    expect(slackCalls.length).toBe(1);
  });

  it('suppresses alerts during maintenance mode', async () => {
    const project = await seedProject({ maintenance_until: nowSec() + 600 });
    const check = await seedCheck(project.id);

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead'); // state still recorded
    expect(slackCalls.length).toBe(0); // but no alert
  });

  it('respects the silence period for repeat failures', async () => {
    const project = await seedProject();
    // Alerted 100s ago; silence period is 3600s
    const check = await seedCheck(project.id, { last_alert_at: nowSec() - 100 });

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(0); // still silenced
    const updated = await getCheck(check.id);
    expect(updated?.failure_count).toBe(1); // counter still advances
  });

  it('alerts again once the silence period has elapsed', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_alert_at: nowSec() - 4000 });

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

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

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(1);
    expect((await getCheck(check.id))?.status).toBe('dead');
  });

  it('cooldown=0 falls back to the global silence period', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { cooldown: 0, last_alert_at: nowSec() - 100 });

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(0); // global 3600s still silences
  });
});

describe('alert channel routing', () => {
  const channelOf = (call: string) => (JSON.parse(call) as { channel: string }).channel;

  it('routes critical (dead) alerts to the critical channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id);

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    expect(slackCalls.length).toBe(1);
    expect(channelOf(slackCalls[0])).toBe(TEST_SLACK.channel_critical);
  });

  it('routes warning (error) alerts to the warning channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { threshold: 2, failure_count: 1 });

    await processCheckResult(DB, TEST_ENV, check, project, 'error', 'db down');

    expect(slackCalls.length).toBe(1);
    expect(channelOf(slackCalls[0])).toBe(TEST_SLACK.channel_warning);
  });

  it('routes recovery alerts to the success channel', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { status: 'dead', failure_count: 1 });

    await processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse received');

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

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

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

    await processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!');

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('dead');
    expect(updated?.last_seen).toBe(lastSeen); // not stamped with "now"
  });

  it('two overlapping dead-marks produce exactly one alert and one increment', async () => {
    const project = await seedProject();
    const check = await seedCheck(project.id, { last_seen: nowSec() - 3600 });

    // Same stale object, as two cron runs that fetched the row concurrently.
    await Promise.all([
      processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!'),
      processCheckResult(DB, TEST_ENV, check, project, 'dead', 'Heartbeat missed!'),
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
      processCheckResult(DB, TEST_ENV, check, project, 'error', 'db down #1'),
      processCheckResult(DB, TEST_ENV, check, project, 'error', 'db down #2'),
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
      processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse A'),
      processCheckResult(DB, TEST_ENV, check, project, 'ok', 'Pulse B'),
    ]);

    const updated = await getCheck(check.id);
    expect(updated?.status).toBe('ok');
    expect(updated?.failure_count).toBe(0);
    expect(slackCalls.length).toBe(1); // single recovery notification
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
