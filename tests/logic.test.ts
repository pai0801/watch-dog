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
