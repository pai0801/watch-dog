// tests/cron.test.ts
// Cron (scheduled) handler: dead-check detection, self-monitoring pulse,
// and 7-day log cleanup.

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import worker from '../src/index';
import { network } from './network';
import { DB, getCheck, resetDb, seedCheck, seedProject, setSlackSettings, TEST_ENV } from './utils';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Dispatch the worker's scheduled handler the way the cron trigger would. */
async function runScheduled(scheduledTimeMs?: number): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve();
  await worker.scheduled(
    { scheduledTime: scheduledTimeMs ?? Date.now(), cron: '* * * * *', noRetry: () => undefined } as never,
    TEST_ENV,
    {
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
      passThroughOnException: () => undefined,
      props: {},
    } as never
  );
  await pending;
}

let slackBodies: string[] = [];

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
  slackBodies = [];
  network.use(
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      slackBodies.push(await request.text());
      return HttpResponse.json({ ok: true });
    })
  );
});

describe('scheduled handler', () => {
  it('marks stale heartbeat checks dead and sends a critical Slack alert', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', {
      id: 'svc:stale',
      name: 'stale',
      last_seen: nowSec() - 3600,
      interval: 300,
      grace: 60,
    });
    await seedCheck('svc', {
      id: 'svc:fresh',
      name: 'fresh',
      last_seen: nowSec(),
      interval: 300,
      grace: 60,
    });

    await runScheduled();

    const stale = await getCheck('svc:stale');
    expect(stale?.status).toBe('dead');
    expect(stale?.last_message).toContain('Heartbeat missed');

    const fresh = await getCheck('svc:fresh');
    expect(fresh?.status).toBe('ok');

    expect(slackBodies.length).toBe(1);
    expect(slackBodies[0]).toContain('C_CRITICAL');
    expect(slackBodies[0]).toContain('Service DEAD');
  });

  it('keeps the self-health check alive on every cron run', async () => {
    await seedProject({ id: 'watch-dog', token: '', display_name: 'Watch-Dog Sentinel' });
    await seedCheck('watch-dog', {
      id: 'watch-dog:self-health',
      name: 'self-health',
      last_seen: nowSec() - 7200,
      status: 'error',
      failure_count: 5,
    });

    await runScheduled();

    const self = await getCheck('watch-dog:self-health');
    expect(self?.status).toBe('ok');
    expect(self?.failure_count).toBe(0);
    expect(self?.last_seen).toBeGreaterThanOrEqual(nowSec() - 5);
  });

  it('deletes logs older than 7 days (hourly gate: top-of-hour firing)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });

    await DB.prepare('INSERT INTO logs (check_id, status, created_at) VALUES (?, ?, ?)')
      .bind('svc:health', 'ok', nowSec() - 800000)
      .run();
    await DB.prepare('INSERT INTO logs (check_id, status, created_at) VALUES (?, ?, ?)')
      .bind('svc:health', 'ok', nowSec() - 100)
      .run();

    // Cleanup only runs on the top-of-hour cron firing (scheduledTime % 3600s === 0).
    const topOfHour = Math.floor(Date.now() / 3600000) * 3600000;
    await runScheduled(topOfHour);

    const remaining = await DB.prepare('SELECT COUNT(*) AS n FROM logs').first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  it('skips log cleanup on non-top-of-hour firings (D1 quota discipline)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });

    await DB.prepare('INSERT INTO logs (check_id, status, created_at) VALUES (?, ?, ?)')
      .bind('svc:health', 'ok', nowSec() - 800000)
      .run();

    const notTopOfHour = Math.floor(Date.now() / 3600000) * 3600000 + 1800000; // :30
    await runScheduled(notTopOfHour);

    const remaining = await DB.prepare('SELECT COUNT(*) AS n FROM logs').first<{ n: number }>();
    expect(remaining?.n).toBe(1); // old log survives — cleanup gated off
  });
});
