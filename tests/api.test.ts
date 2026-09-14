// tests/api.test.ts
// Integration tests for the machine-facing API via SELF (real worker fetch).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { resetResourceCaches } from '../src/services/cfResources';
import {
  DB,
  cfD1ListUrl,
  cfKvListUrl,
  getCheck,
  getProject,
  resetDb,
  seedCheck,
  seedCfAccount,
  seedProject,
  seedResourceName,
  TEST_CF,
  TEST_USAGE_API_TOKEN,
} from './utils';

const TOKEN = 'test-token-1234567890';
// auth headers are inlined per-call below (put/post take a headers arg)

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

  it('returns 404 for an unknown project (closed registration, 2026-09-05)', async () => {
    const res = await put('/api/config', configBody, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);

    // nothing was created — no project, no checks
    expect(await getProject('new-service')).toBeNull();
    expect(await getCheck('new-service:health')).toBeNull();
  });

  it('updates config for an operator-created project', async () => {
    await seedProject({ id: 'new-service', token: TOKEN, display_name: 'Old Name' });

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
    await seedProject({ id: 'new-service', token: TOKEN, display_name: 'New Service' });

    const res = await put('/api/config', configBody, { Authorization: 'Bearer wrong-token-aaaaaaaa' });
    expect(res.status).toBe(403);
  });

  it('rejects the removed legacy X-Project-Token header (401)', async () => {
    const res = await put('/api/config', configBody, { 'X-Project-Token': TOKEN });
    expect(res.status).toBe(401);
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
    await seedProject({ id: 'charset-test', token: TOKEN });
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
    await seedProject({ id: 'clamp-test', token: TOKEN });
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

describe('PUT /api/config — WD-02 check management (replace-set + monitor)', () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const checkA = { name: 'a', display_name: 'A', type: 'heartbeat' as const, interval: 60, grace: 30 };
  const checkB = { name: 'b', display_name: 'B', type: 'heartbeat' as const, interval: 60, grace: 30 };

  beforeEach(async () => {
    await seedProject({ id: 'mgmt', token: TOKEN, display_name: 'Mgmt' });
    await seedProject({ id: 'other', token: 'other-token-1234567890', display_name: 'Other' });
    await seedCheck('other', { id: 'other:keep', name: 'keep' });
  });

  it('checks_replace: absent checks and their logs are removed, scoped to this project', async () => {
    await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [checkA, checkB] }, auth);
    await DB.prepare("INSERT INTO logs (check_id, status, created_at) VALUES ('mgmt:b', 'ok', 1)").run();

    const res = await put(
      '/api/config',
      { project_id: 'mgmt', display_name: 'Mgmt', checks: [checkA], checks_replace: true },
      auth,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ checks_deleted: number }>();
    expect(body.checks_deleted).toBe(1);

    expect(await getCheck('mgmt:a')).not.toBeNull();
    expect(await getCheck('mgmt:b')).toBeNull(); // absent → deleted
    const logB = await DB.prepare("SELECT COUNT(*) AS n FROM logs WHERE check_id = 'mgmt:b'").first<{ n: number }>();
    expect(logB?.n).toBe(0); // its logs went with it
    expect(await getCheck('other:keep')).not.toBeNull(); // no cross-project bleed
  });

  it('without checks_replace: absent checks are kept (upsert-only default unchanged)', async () => {
    await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [checkA, checkB] }, auth);

    const res = await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [checkA] }, auth);
    expect(res.status).toBe(200);
    const body = await res.json<{ checks_deleted: number }>();
    expect(body.checks_deleted).toBe(0);
    expect(await getCheck('mgmt:b')).not.toBeNull();
  });

  it('monitor field toggles monitoring via API; omitting it keeps the stored value', async () => {
    await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [{ ...checkA, monitor: 0 }] }, auth);
    expect((await getCheck('mgmt:a'))?.monitor).toBe(0);

    await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [checkA] }, auth);
    expect((await getCheck('mgmt:a'))?.monitor).toBe(0); // omitted → kept

    await put('/api/config', { project_id: 'mgmt', display_name: 'Mgmt', checks: [{ ...checkA, monitor: 1 }] }, auth);
    expect((await getCheck('mgmt:a'))?.monitor).toBe(1);
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

// ============================================================================
// GET /api/cf-usage (Task 8)
// ============================================================================

interface UsageMetricShape {
  metric: string;
  label: string;
  value: number;
  quota: number | null;
  pct: number | null;
  projected_eod: number | null;
}
interface UsageAccountShape {
  label: string;
  plan: string;
  last_polled_at: number;
  metrics: UsageMetricShape[];
  detail?: {
    groups: Array<{
      type: string;
      items: Array<{ name: string; url?: string; metrics: Record<string, number>; metrics_yesterday: Record<string, number> }>;
    }>;
  } | null;
  detail_error?: string;
}

/** cf_usage_state row for today (the API reads day_utc = now, like the pane). */
async function seedUsageRow(accountId: string, metric: string, value: number, projectedEod: number | null = null) {
  const today = new Date().toISOString().slice(0, 10);
  await DB.prepare(
    'INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level) VALUES (?, ?, ?, ?, ?, 0)'
  )
    .bind(today, accountId, metric, value, projectedEod)
    .run();
}

describe('GET /api/cf-usage', () => {
  const auth = { Authorization: `Bearer ${TEST_USAGE_API_TOKEN}` };

  beforeEach(async () => {
    resetResourceCaches();
    network.use(
      http.post(TEST_CF.gqlUrl, () =>
        HttpResponse.json({
          data: {
            viewer: {
              accounts: [
                {
                  wkr: [{ dimensions: { scriptName: 'watch-dog' }, sum: { requests: 1500, errors: 2 } }],
                  d1: [{ dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } }],
                },
              ],
            },
          },
        })
      ),
      http.get(cfD1ListUrl(TEST_CF.accountId), () => HttpResponse.json({ success: true, result: [] })),
      http.get(cfKvListUrl(TEST_CF.accountId), () => HttpResponse.json({ success: true, result: [] }))
    );
  });

  it('rejects requests without a token (401, fail-closed)', async () => {
    const res = await SELF.fetch('http://localhost/api/cf-usage');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token (401)', async () => {
    const res = await SELF.fetch('http://localhost/api/cf-usage', {
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a multi-byte token with 401, not a 500 (TODO #20 regression)', async () => {
    // Same UTF-16 length as the secret (20 code units) but 'ê' is 2 UTF-8
    // bytes → buffers reach timingSafeEqual with unequal byteLength. The old
    // UTF-16 .length guard passed them through and crypto.subtle threw.
    const res = await SELF.fetch('http://localhost/api/cf-usage', {
      headers: { Authorization: 'Bearer têst-usage-api-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns per-account metrics with quota/pct and sorts by max ratio desc', async () => {
    await seedCfAccount({ label: 'Low Use' });
    await seedUsageRow(TEST_CF.accountId, 'd1_rows_read', 1_000_000); // 20%
    // record-only metric: value stored/displayed, quota and pct null
    await seedUsageRow(TEST_CF.accountId, 'workers_errors', 7);
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'High Use' });
    await seedUsageRow(TEST_CF.accountIdB, 'd1_rows_written', 90_000); // 90%

    const res = await SELF.fetch('http://localhost/api/cf-usage', { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json<{ generated_at: number; quota_reset: string; accounts: UsageAccountShape[] }>();
    expect(body.quota_reset).toContain('UTC 00:00');
    expect(body.accounts.map((a) => a.label)).toEqual(['High Use', 'Low Use']);

    const read = body.accounts[1].metrics.find((m) => m.metric === 'd1_rows_read');
    expect(read?.quota).toBe(5_000_000);
    expect(read?.pct).toBe(20);
    const errs = body.accounts[1].metrics.find((m) => m.metric === 'workers_errors');
    expect(errs?.quota).toBeNull(); // record-only metric
    expect(errs?.pct).toBeNull();
  });

  it('filters by account label and 404s unknown labels', async () => {
    await seedCfAccount();
    await seedUsageRow(TEST_CF.accountId, 'd1_rows_read', 1);
    const ok = await SELF.fetch('http://localhost/api/cf-usage?account=Test%20Account', { headers: auth });
    expect(ok.status).toBe(200);
    const body = await ok.json<{ accounts: UsageAccountShape[] }>();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].label).toBe('Test Account');

    const missing = await SELF.fetch('http://localhost/api/cf-usage?account=ghost', { headers: auth });
    expect(missing.status).toBe(404);
  });

  it('detail=1 carries named groups, strips ids, and degrades a failing account alone', async () => {
    await seedCfAccount({ label: 'Good' });
    await seedUsageRow(TEST_CF.accountId, 'd1_rows_read', 1);
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'Bad' });
    await seedUsageRow(TEST_CF.accountIdB, 'd1_rows_read', 1);
    await seedResourceName(TEST_CF.accountId, 'd1', '11111111-2222-3333-4444-555555555555', 'Production DB');
    network.use(
      http.post(TEST_CF.gqlUrl, ({ request }) =>
        request.headers.get('Authorization') === `Bearer ${TEST_CF.tokenB}`
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({
              data: {
                viewer: {
                  accounts: [
                    {
                      wkr: [{ dimensions: { scriptName: 'watch-dog' }, sum: { requests: 1500, errors: 2 } }],
                      pgs: [{ dimensions: { scriptName: 'pages-worker--13581012-production' }, sum: { requests: 300 } }],
                      d1: [
                        { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } },
                        { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555', date: '2026-09-10' }, sum: { rowsRead: 50, rowsWritten: 0 } },
                      ],
                    },
                  ],
                },
              },
            })
      )
    );

    const res = await SELF.fetch('http://localhost/api/cf-usage?detail=1', { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json<{ accounts: UsageAccountShape[] }>();
    const good = body.accounts.find((a) => a.label === 'Good');
    expect(good?.detail?.groups.length).toBeGreaterThan(0);
    expect(good?.detail?.groups[0].items[0].name).toBe('watch-dog');
    expect(good?.detail?.groups[0].items[0].metrics_yesterday).toEqual({});
    // d1: today 100 / yesterday 50 split by the row's date dimension
    const d1Item = good?.detail?.groups.find((g) => g.type === 'd1')?.items[0];
    expect(d1Item?.metrics.d1_rows_read).toBe(100);
    expect(d1Item?.metrics_yesterday.d1_rows_read).toBe(50);
    // pages: parsed name + production pages.dev URL, no internal deployment name
    const pagesItem = good?.detail?.groups.find((g) => g.type === 'pages')?.items[0];
    expect(pagesItem?.name).toBe('pages-worker（production）');
    expect(pagesItem?.url).toBe('https://pages-worker.pages.dev');
    expect(JSON.stringify(body)).not.toContain('--13581012');
    const bad = body.accounts.find((a) => a.label === 'Bad');
    expect(bad?.detail_error).toContain('HTTP 500');
    expect(bad?.detail).toBeNull();
    // security: no 32-hex run anywhere in the serialized response (resource
    // ids are stripped at the API boundary — names only)
    expect(JSON.stringify(body).match(/[0-9a-f]{32}/)).toBeNull();
  });
});
