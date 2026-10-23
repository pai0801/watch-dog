// tests/trigger.test.ts
// External engine trigger endpoint (rn1g second source, 2026-10-24):
// token auth, recency skip, engine actually runs, heartbeat tagged via='trigger'.

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { resetDb, seedCheck, seedProject, seedSchedule, setSlackSettings } from './utils';

const E = env as unknown as import('../src/types').AppBindings;
const DB = E.DB;
const BASE = 'https://watch-dog.test';
const TRIGGER_H = { Authorization: 'Bearer test-trigger-token', 'Content-Type': 'application/json' };
const OPS_URL = 'https://ops-ctl.test.local';

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
});

describe('POST /api/engine/trigger', () => {
  it('503 fail-closed when TRIGGER_TOKEN wiring is absent (route-level)', async () => {
    // Route-level unit: env WITHOUT TRIGGER_TOKEN must fail closed before any
    // DB/auth work. (The shared SELF worker always has the test binding, so we
    // drive the route module directly with a hand-built env.)
    const { default: triggerApp } = await import('../src/routes/trigger');
    const res = await triggerApp.request('https://watch-dog.test/api/engine/trigger', {
      method: 'POST',
      headers: { Authorization: 'Bearer anything' },
    }, { DB: E.DB } as unknown as import('../src/types').AppBindings);
    expect(res.status).toBe(503);
  });

  it('401 without / with wrong Bearer token', async () => {
    const noAuth = await SELF.fetch(`${BASE}/api/engine/trigger`, { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const badAuth = await SELF.fetch(`${BASE}/api/engine/trigger`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(badAuth.status).toBe(401);
  });

  it('runs the engine and tags the cross-monitor heartbeat via=trigger', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedSchedule('svc', { next_run_at: nowSec() + 3600 }); // keep engine quiet
    // Engine's self-pulse only UPDATEs an existing row — seed it (cron
    // deployed DB has it; resetDb wipes checks).
    await seedProject({ id: 'watch-dog', token: 'tok-selfhealth' });
    await seedCheck('watch-dog', { id: 'watch-dog:self-health', name: 'self-health', last_seen: nowSec() - 120 });

    const hbs: Array<Record<string, unknown>> = [];
    network.use(
      http.post(`${OPS_URL}/api/heartbeat`, async ({ request }) => {
        hbs.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      })
    );

    const res = await SELF.fetch(`${BASE}/api/engine/trigger`, {
      method: 'POST',
      headers: TRIGGER_H,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(false);

    // Engine ran: self-health check exists and is fresh
    const self = await DB.prepare("SELECT last_seen FROM checks WHERE id = 'watch-dog:self-health'").first<{ last_seen: number }>();
    expect(self).not.toBeNull();
    expect(nowSec() - self!.last_seen).toBeLessThan(10);

    // Heartbeat went out tagged as trigger-sourced
    expect(hbs.length).toBeGreaterThanOrEqual(1);
    expect(hbs[0]!.host).toBe('watch-dog');
    expect(hbs[0]!.via).toBe('trigger');
  });

  it('skips (no engine run) when a tick ran seconds ago — double-source dedup', async () => {
    // Self-health check already stamped "just now" (simulates CF cron tick)
    await seedProject({ id: 'watch-dog', token: 'tok-selfhealth' });
    await seedCheck('watch-dog', { id: 'watch-dog:self-health', name: 'self-health', last_seen: nowSec() });

    const res = await SELF.fetch(`${BASE}/api/engine/trigger`, {
      method: 'POST',
      headers: TRIGGER_H,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: boolean; lastTickAgoSec: number };
    expect(body.skipped).toBe(true);
    expect(body.lastTickAgoSec).toBeLessThan(30);
  });
});
