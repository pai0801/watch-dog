// tests/schedules.test.ts
// Scheduler hub: signature pure functions, due-fire engine, registration API,
// admin read-only view, cron wiring.

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { hmacSha256Hex, runDueSchedules, signScheduleHeader } from '../src/services/scheduler';
import { DB, getSchedule, resetDb, seedProject, seedSchedule, setSlackSettings } from './utils';

describe('signScheduleHeader (pure)', () => {
  it('produces t=...,v1=<64 lowercase hex> and is deterministic', async () => {
    const a = await signScheduleHeader('secret-a', 7, 1000, 2000);
    const b = await signScheduleHeader('secret-a', 7, 1000, 2000);
    expect(a).toMatch(/^t=2000,v1=[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs per secret / schedule / timestamp', async () => {
    const base = await signScheduleHeader('secret-a', 7, 1000, 2000);
    expect(await signScheduleHeader('secret-b', 7, 1000, 2000)).not.toBe(base);
    expect(await signScheduleHeader('secret-a', 8, 1000, 2000)).not.toBe(base);
    expect(await signScheduleHeader('secret-a', 7, 1000, 2001)).not.toBe(base);
  });

  it('hmacSha256Hex matches the documented recipe', async () => {
    // Same recipe the client-guide verification example implements.
    const hex = await hmacSha256Hex('k', '2000.7.1000');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // RFC 4231 Test Case 2 — pins the whole crypto path (algo + encoder).
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** Direct engine invocation (service-level; cron wiring covered in Task 6). */
async function runEngine(): Promise<void> {
  await runDueSchedules(DB, nowSec(), Date.now());
}

describe('runDueSchedules', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  let hits: Array<{ url: string; body: string; sig: string }>;

  beforeEach(() => {
    hits = [];
    network.use(
      http.post('https://cb.test.local/*', async ({ request }) => {
        hits.push({
          url: new URL(request.url).pathname,
          body: await request.text(),
          sig: request.headers.get('X-Schedule-Signature') ?? '',
        });
        return HttpResponse.json({ ok: true });
      })
    );
  });

  it('fires a due schedule with signed POST and advances next_run_at (AC2/AC3)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    const s = await seedSchedule('svc', { consecutive_failures: 3 }); // success resets the streak
    const before = nowSec();

    await runEngine();

    expect(hits).toHaveLength(1);
    expect(hits[0].sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const payload = JSON.parse(hits[0].body);
    expect(payload.schedule_id).toBe(s.id);
    expect(payload.scheduled_at).toBeGreaterThan(0);
    expect(payload.fired_at).toBeGreaterThanOrEqual(payload.scheduled_at);

    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('ok');
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.next_run_at).toBeGreaterThanOrEqual(before + 60 * 60);
    expect(row?.next_run_at).toBeLessThanOrEqual(nowSec() + 60 * 60);
  });

  it('skips not-due and paused schedules (AC2/AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedSchedule('svc', { id: 1, name: 'future', next_run_at: nowSec() + 3600 });
    await seedSchedule('svc', { id: 2, name: 'paused', paused: 1 });

    await runEngine();

    expect(hits).toHaveLength(0);
  });

  it('records failure, does NOT re-hammer on the next tick (AC3)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let calls = 0;
    network.use(
      http.post('https://cb.test.local/*', () => {
        calls++;
        return new HttpResponse('boom', { status: 500 });
      })
    );
    const s = await seedSchedule('svc');

    await runEngine();
    await runEngine(); // next minute — must not fire again

    expect(hits).toHaveLength(0); // 500 handler replaced the recorder above
    expect(calls).toBe(1); // retry_count=0 → exactly one attempt across both ticks
    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('fail');
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.next_run_at).toBeGreaterThan(nowSec());
  });

  it('retries once in-tick when retry_count=1 (AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let calls = 0;
    network.use(
      http.post('https://cb.test.local/*', () => {
        calls++;
        return calls === 1 ? new HttpResponse('boom', { status: 500 }) : HttpResponse.json({ ok: true });
      })
    );
    const s = await seedSchedule('svc', { retry_count: 1 });

    await runEngine();

    expect(calls).toBe(2);
    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('ok');
    expect(row?.consecutive_failures).toBe(0);
  });

  it('alerts on crossing alert_after_failures (AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    const slackBodies: string[] = [];
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 })),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        slackBodies.push(await request.text());
        return HttpResponse.json({ ok: true });
      })
    );
    await seedSchedule('svc', {
      alert_after_failures: 2,
      consecutive_failures: 1, // this failure crosses 2
    });

    await runEngine();

    expect(slackBodies).toHaveLength(1);
    expect(slackBodies[0]).toContain('C_WARNING');
    expect(slackBodies[0]).toContain('tick');
  });

  it('never alerts when alert_after_failures=0 (AC4 default)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let slackHits = 0;
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 })),
      http.post('https://slack.com/api/chat.postMessage', () => {
        slackHits++;
        return HttpResponse.json({ ok: true });
      })
    );
    await seedSchedule('svc', { consecutive_failures: 5 });

    await runEngine();

    expect(slackHits).toBe(0);
  });

  it('caps Slack alerts at 5 per tick (AC4/AC6)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let slackHits = 0;
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 })),
      http.post('https://slack.com/api/chat.postMessage', () => {
        slackHits++;
        return HttpResponse.json({ ok: true });
      })
    );
    for (let i = 1; i <= 6; i++) {
      await seedSchedule('svc', {
        id: i,
        name: `alert-${i}`,
        callback_url: `https://cb.test.local/alert-${i}`,
        alert_after_failures: 1, // every failure is a fresh crossing
      });
    }

    await runEngine();

    expect(slackHits).toBe(5); // ALERT_BATCH_LIMIT — the 6th is dropped this tick
  });

  it('caps fires at 20 per tick, most-overdue first (AC6)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    for (let i = 1; i <= 25; i++) {
      await seedSchedule('svc', {
        id: i,
        name: `job-${String(i).padStart(2, '0')}`,
        callback_url: `https://cb.test.local/job-${i}`,
        next_run_at: i, // ascending: job-1 most overdue
      });
    }

    await runEngine();

    expect(hits).toHaveLength(20);
    expect(hits.map((h) => h.url)).toContain('/job-1');
    expect(hits.map((h) => h.url)).not.toContain('/job-25');
    // leftovers stay due for the next tick
    expect((await getSchedule(25))?.next_run_at).toBe(25);
  });
});

const TOKEN = 'tok-1234567890';
const auth = { Authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { 'Content-Type': 'application/json' };

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'POST',
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });
const get = (url: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, { headers });
const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'PUT',
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });
const del = (url: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, { method: 'DELETE', headers });

describe('POST /api/schedules (AC1)', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  it('rejects missing token (401), bad token (403), unknown project (404)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const body = { project_id: 'svc', name: 'tick', callback_url: 'https://cb.test.local/x' };
    expect((await post('/api/schedules', body)).status).toBe(401);
    expect((await post('/api/schedules', body, { Authorization: 'Bearer wrong' })).status).toBe(403);
    expect(
      (await post('/api/schedules', { ...body, project_id: 'nope' }, auth)).status
    ).toBe(404);
  });

  it('validates name, url, interval (400)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const base = { project_id: 'svc', callback_url: 'https://cb.test.local/x' };
    expect((await post('/api/schedules', { ...base, name: '' }, auth)).status).toBe(400);
    expect((await post('/api/schedules', { ...base, name: 'ok', callback_url: 'http://insecure' }, auth)).status).toBe(400);
    expect((await post('/api/schedules', { ...base, name: 'ok', interval_minutes: 'abc' }, auth)).status).toBe(400);
  });

  it('creates a schedule, returns the secret exactly once, first fire one interval out (AC2)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const before = nowSec();

    const res = await post(
      '/api/schedules',
      { project_id: 'svc', name: 'hourly', callback_url: 'https://cb.test.local/x', interval_minutes: 60 },
      auth
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ schedule: { id: number; secret: string; next_run_at: number } }>();
    expect(data.schedule.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(data.schedule.next_run_at).toBeGreaterThanOrEqual(before + 3600);

    const row = await getSchedule(data.schedule.id);
    expect(row?.name).toBe('hourly');
    // list view NEVER carries the secret
    const listRes = await get('/api/schedules?project_id=svc', auth);
    const list = await listRes.json<{ schedules: Array<{ secret?: string }> }>();
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0].secret).toBeUndefined();
  });

  it('rejects duplicate name within a project (409)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { name: 'hourly' });
    const res = await post(
      '/api/schedules',
      { project_id: 'svc', name: 'hourly', callback_url: 'https://cb.test.local/x' },
      auth
    );
    expect(res.status).toBe(409);
  });
});

describe('ownership (AC1: no cross-project oracle)', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  it('hides another project schedule behind 404 and lists only own rows', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedProject({ id: 'other', token: 'other-token-1234567890' });
    const s = await seedSchedule('other');

    expect((await get(`/api/schedules/${s.id}?project_id=svc`, auth)).status).toBe(404);
    expect((await put(`/api/schedules/${s.id}?project_id=svc`, { interval_minutes: 5 }, auth)).status).toBe(404);
    expect((await del(`/api/schedules/${s.id}?project_id=svc`, auth)).status).toBe(404);

    const list = await (await get('/api/schedules?project_id=svc', auth)).json<{ schedules: unknown[] }>();
    expect(list.schedules).toHaveLength(0);
  });
});

describe('PUT /api/schedules/:id (AC1/AC4)', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  it('updates fields; interval change does NOT recompute next_run_at', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { next_run_at: 12345 });

    const res = await put('/api/schedules/101?project_id=svc', { interval_minutes: 5, paused: 1 }, auth);
    expect(res.status).toBe(200);
    const row = await getSchedule(101);
    expect(row?.interval_minutes).toBe(5);
    expect(row?.paused).toBe(1);
    expect(row?.next_run_at).toBe(12345); // untouched by design
  });

  it('rejects invalid name (400) and rename collisions (409)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { id: 101, name: 'a' });
    await seedSchedule('svc', { id: 102, name: 'b' });

    expect((await put('/api/schedules/101?project_id=svc', { name: 'bad name!' }, auth)).status).toBe(400);
    expect((await put('/api/schedules/101?project_id=svc', { name: 'b' }, auth)).status).toBe(409);
  });
});

describe('DELETE /api/schedules/:id (AC1)', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  it('removes the schedule', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc');
    expect((await del('/api/schedules/101?project_id=svc', auth)).status).toBe(200);
    expect(await getSchedule(101)).toBeNull();
  });
});
