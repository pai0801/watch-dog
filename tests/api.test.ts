// tests/api.test.ts
// Integration tests for the machine-facing API via SELF (real worker fetch).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  getCheck,
  getProject,
  resetDb,
  seedCheck,
  seedProject,
} from './utils';

const TOKEN = 'test-token-1234567890';
const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  await resetDb();
});

describe('PUT /api/config', () => {
  const configBody = {
    project_id: 'new-service',
    display_name: 'New Service',
    checks: [
      { name: 'health', display_name: 'Health', type: 'heartbeat', interval: 60, grace: 30, threshold: 2, cooldown: 600 },
      // invalid entries are skipped, not fatal
      { name: '', type: 'heartbeat' },
      { name: 'bad-type', type: 'weird' },
    ],
  };

  it('rejects requests without a token (401)', async () => {
    const res = await put('/api/config', configBody);
    expect(res.status).toBe(401);
  });

  it('rejects a payload missing project_id / display_name (400)', async () => {
    const res = await put('/api/config', { checks: configBody.checks }, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
  });

  it('registers a project and its checks', async () => {
    const res = await put('/api/config', configBody, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);

    const body = await res.json<{ success: boolean; checks_registered: number }>();
    expect(body.success).toBe(true);

    const project = await getProject('new-service');
    expect(project?.display_name).toBe('New Service');

    const check = await getCheck('new-service:health');
    expect(check?.interval).toBe(60);
    expect(check?.threshold).toBe(2);

    // invalid check configs were skipped
    expect(await getCheck('new-service:bad-type')).toBeNull();
  });

  it('rejects a mismatched token for an existing project (403)', async () => {
    await put('/api/config', configBody, { Authorization: `Bearer ${TOKEN}` });

    const res = await put('/api/config', configBody, { Authorization: 'Bearer wrong-token-aaaaaaaa' });
    expect(res.status).toBe(403);
  });

  it('supports the legacy X-Project-Token header', async () => {
    const res = await put('/api/config', configBody, { 'X-Project-Token': TOKEN });
    expect(res.status).toBe(200);
  });

  it('rejects a project_id outside the safe charset (stored-XSS hardening)', async () => {
    const res = await put(
      '/api/config',
      {
        project_id: "a' || alert(1) || '",
        display_name: 'Evil',
        checks: [{ name: 'health', type: 'heartbeat' }],
      },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(400);

    expect(await getProject("a' || alert(1) || '")).toBeNull();
  });

  it('skips checks whose names fall outside the safe charset', async () => {
    const res = await put(
      '/api/config',
      {
        project_id: 'charset-test',
        display_name: 'Charset Test',
        checks: [
          { name: 'x"><script>alert(1)</script>', type: 'heartbeat' },
          { name: 'also bad', type: 'heartbeat' }, // space is not allowed
          { name: 'legit_name-1', type: 'heartbeat' },
        ],
      },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);

    expect(await getCheck('charset-test:legit_name-1')).not.toBeNull();
    expect(await getCheck('charset-test:x"><script>alert(1)</script>')).toBeNull();
  });

  it('clamps nonsensical numeric config to sane bounds', async () => {
    const res = await put(
      '/api/config',
      {
        project_id: 'clamp-test',
        display_name: 'Clamp Test',
        checks: [{ name: 'health', type: 'heartbeat', interval: -5, grace: -100, threshold: 0, cooldown: 'soon' }],
      },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);

    const check = await getCheck('clamp-test:health');
    expect(check?.interval).toBe(10); // min interval
    expect(check?.grace).toBe(0); // min grace
    expect(check?.threshold).toBe(1); // min threshold
    expect(check?.cooldown).toBe(900); // non-numeric → default
  });
});

describe('POST /api/pulse', () => {
  beforeEach(async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
  });

  it('rejects requests without a token (401)', async () => {
    const res = await post('/api/pulse', { check_name: 'health' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown token (403)', async () => {
    const res = await post('/api/pulse', { check_name: 'health' }, { Authorization: 'Bearer nope-1234567890' });
    expect(res.status).toBe(403);
  });

  it('rejects a token for a different project (403)', async () => {
    await seedProject({ id: 'other', token: 'other-token-1234567890' });
    const res = await post(
      '/api/pulse',
      { project_id: 'other', check_name: 'health' },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unregistered check', async () => {
    const res = await post('/api/pulse', { check_name: 'ghost' }, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
  });

  it('accepts a heartbeat and records ok status', async () => {
    const res = await post('/api/pulse', { check_name: 'health', latency: 42 }, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);

    const body = await res.json<{ success: boolean; status: string }>();
    expect(body.success).toBe(true);
    expect(body.status).toBe('ok');

    const check = await getCheck('svc:health');
    expect(check?.status).toBe('ok');
    expect(check?.last_seen).toBeGreaterThan(0);
  });

  it('records error pulses and increments failure_count', async () => {
    const res = await post(
      '/api/pulse',
      { check_name: 'health', status: 'error', message: 'db unreachable' },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);

    const check = await getCheck('svc:health');
    expect(check?.status).toBe('error');
    expect(check?.failure_count).toBe(1);
    expect(check?.last_message).toBe('db unreachable');
  });

  it('accepts project_id + matching token explicitly', async () => {
    const res = await post(
      '/api/pulse',
      { project_id: 'svc', check_name: 'health' },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);
  });

  it('coerces an unknown status to ok (no arbitrary state injection)', async () => {
    const res = await post(
      '/api/pulse',
      { check_name: 'health', status: 'weird<script>' },
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);

    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('ok');

    const check = await getCheck('svc:health');
    expect(check?.status).toBe('ok');
  });
});

describe('POST /api/maintenance/:projectId', () => {
  beforeEach(async () => {
    await seedProject({ id: 'svc', token: TOKEN });
  });

  it('requires the project token (was previously unauthenticated!)', async () => {
    const res = await post('/api/maintenance/svc', { enabled: true });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token (403)', async () => {
    const res = await post('/api/maintenance/svc', { enabled: true }, { Authorization: 'Bearer wrong-1234567890' });
    expect(res.status).toBe(403);
  });

  it('mutes and unmutes with a valid token', async () => {
    const on = await post('/api/maintenance/svc', { enabled: true, duration: 600 }, { Authorization: `Bearer ${TOKEN}` });
    expect(on.status).toBe(200);
    expect((await on.json<{ maintenance_mode: boolean }>()).maintenance_mode).toBe(true);

    const off = await post('/api/maintenance/svc', { enabled: false }, { Authorization: `Bearer ${TOKEN}` });
    expect((await off.json<{ maintenance_mode: boolean }>()).maintenance_mode).toBe(false);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await post('/api/maintenance/ghost', { enabled: true }, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/status', () => {
  it('lists projects with their checks (public read-only feed)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });

    const all = await SELF.fetch('http://localhost/api/status');
    expect(all.status).toBe(200);
    const allText = await all.text();
    // Public feed must never leak project tokens
    expect(allText).not.toContain(TOKEN);
    expect(allText).not.toContain('"token"');
    const body = JSON.parse(allText) as { projects: Array<{ id: string; checks: unknown[] }> };
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(['svc']);
    expect(body.projects[0].checks.length).toBe(1);

    const one = await SELF.fetch('http://localhost/api/status/svc');
    expect(one.status).toBe(200);
    const oneText = await one.text();
    expect(oneText).not.toContain(TOKEN);
    const oneBody = JSON.parse(oneText) as { project: { id: string } };
    expect(oneBody.project.id).toBe('svc');
  });

  it('returns 404 for an unknown project', async () => {
    const res = await SELF.fetch('http://localhost/api/status/ghost');
    expect(res.status).toBe(404);
  });
});
