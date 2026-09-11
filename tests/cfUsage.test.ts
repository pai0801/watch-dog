// tests/cfUsage.test.ts
// CF usage quota monitor: GraphQL query builder shape, threshold/projection
// classifier boundaries, and the poller state machine (exactly-once alerts,
// day rollover, gauge carry-over, failure isolation, self-warning gating).

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { buildAccountQuery, classifyMetric, pollCfUsage } from '../src/services/cfUsage';
import { network } from './network';
import {
  CF_TEST_NOW,
  DB,
  getCfAccount,
  getUsageState,
  resetDb,
  seedCfAccount,
  setEmailSettings,
  setSlackSettings,
  TEST_CF,
  TEST_EMAIL,
} from './utils';

const DAY = '2026-09-11'; // utcDay(CF_TEST_NOW) — noon UTC, elapsedSec 43200
const NEXT_DAY = '2026-09-12';

const bearer = (token: string) => `Bearer ${token}`;

/** Build a GraphQL response fixture (missing/null datasets = zero usage). */
const usageFixture = (v: {
  d1Read?: number;
  d1Read2?: number; // second database → exercises client-side sum-of-sums
  d1Write?: number;
  wkrReq?: number;
  wkrErr?: number;
  kvOps?: number;
  kvBytes?: number;
  kvKeys?: number;
  r2Bytes?: number;
  r2Objs?: number;
} = {}) => ({
  data: {
    viewer: {
      accounts: [
        {
          d1: [
            { dimensions: { databaseId: 'db1' }, sum: { rowsRead: v.d1Read ?? 0, rowsWritten: v.d1Write ?? 0 } },
            ...(v.d1Read2 !== undefined
              ? [{ dimensions: { databaseId: 'db2' }, sum: { rowsRead: v.d1Read2, rowsWritten: 0 } }]
              : []),
          ],
          wkr: [{ sum: { requests: v.wkrReq ?? 0, errors: v.wkrErr ?? 0 } }],
          kvo: v.kvOps ? [{ sum: { requests: v.kvOps } }] : null,
          kvs: [{ max: { byteCount: v.kvBytes ?? 0, keyCount: v.kvKeys ?? 0 } }],
          r2s: v.r2Bytes || v.r2Objs ? [{ max: { payloadSize: v.r2Bytes ?? 0, objectCount: v.r2Objs ?? 0 } }] : null,
        },
      ],
    },
  },
});

/** Empty accounts node → "token not scoped" failure mode. */
const EMPTY_ACCOUNTS = { data: { viewer: { accounts: [] } } };

let gqlHits: string[] = [];
let slackPosts: Array<{ channel: string; body: string }> = [];
let emailPosts: Array<{ subject: string }> = [];

/** One-shot gql responder for the common single-account scenarios. */
function useGqlFixture(v: Parameters<typeof usageFixture>[0]): void {
  network.use(
    http.post(TEST_CF.gqlUrl, () => HttpResponse.json(usageFixture(v)))
  );
}

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
  await setEmailSettings();
  gqlHits = [];
  slackPosts = [];
  emailPosts = [];
  network.use(
    // Default catch-all: zero usage for any token. Tests override with
    // network.use (msw runtime handlers are LIFO).
    http.post(TEST_CF.gqlUrl, async ({ request }) => {
      gqlHits.push((request.headers.get('Authorization') ?? ''));
      return HttpResponse.json(usageFixture());
    }),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = JSON.parse(await request.text()) as { channel: string };
      slackPosts.push({ channel: body.channel, body: JSON.stringify(body) });
      return HttpResponse.json({ ok: true });
    }),
    http.post(TEST_EMAIL.email_gateway_url, async ({ request }) => {
      const body = JSON.parse(await request.text()) as { subject: string };
      emailPosts.push({ subject: body.subject });
      return HttpResponse.json({ ok: true });
    }),
  );
});

describe('buildAccountQuery', () => {
  it('merges all five datasets with verified filter forms and no parenthesized selection fields', () => {
    const q = buildAccountQuery(TEST_CF.accountId, CF_TEST_NOW);
    expect(q).toContain(`accountTag: "${TEST_CF.accountId}"`);
    expect(q).toContain('d1AnalyticsAdaptiveGroups');
    expect(q).toContain('workersInvocationsAdaptive');
    expect(q).toContain('kvOperationsAdaptiveGroups');
    expect(q).toContain('kvStorageAdaptiveGroups');
    expect(q).toContain('r2StorageAdaptiveGroups');
    expect(q).toContain(`date_geq: "${DAY}"`);
    expect(q).toContain(`datetime_geq: "${DAY}T00:00:00Z"`);
    expect(q).toContain(`datetimeHour_geq: "${DAY}T00:00:00Z"`);
    expect(q).toMatch(/sum \{ rowsRead rowsWritten \}/);
    expect(q).toMatch(/max \{ byteCount keyCount \}/);
    // dimensions/sum/max are selection fields, never call args (live-API verified)
    expect(q).not.toContain('sum(');
    expect(q).not.toContain('max(');
    expect(q).not.toContain('dimensions(');
    // only D1 groups per-database; the other four select no dimensions at all
    expect(q).toContain('dimensions { databaseId }');
    expect((q.match(/dimensions \{/g) ?? []).length).toBe(1);
  });
});

describe('classifyMetric', () => {
  it('returns all-null for record-only metrics (quota <= 0)', () => {
    expect(classifyMetric('counter', 1_000_000, 0, 43_200)).toEqual({
      level: 0, pct: null, projected: null, projectedPct: null, etaSecondsFromNow: null,
    });
  });

  it('warns at 60% and pages at 80%, nothing at 59.9%', () => {
    // Late-day elapsed so the projection ≈ measured value and cannot cross
    // the quota — isolating the threshold boundaries from the projection variant.
    const lateDay = 86_399;
    expect(classifyMetric('counter', 2_995_000, 5_000_000, lateDay).level).toBe(0);
    expect(classifyMetric('counter', 3_000_000, 5_000_000, lateDay).level).toBe(1);
    expect(classifyMetric('counter', 3_995_000, 5_000_000, lateDay).level).toBe(1);
    expect(classifyMetric('counter', 4_000_000, 5_000_000, lateDay).level).toBe(2);
  });

  it('gauges never project regardless of elapsed time', () => {
    const cls = classifyMetric('gauge', 600_000_000, 1_073_741_824, 86_000);
    expect(cls.projected).toBeNull();
    expect(cls.projectedPct).toBeNull();
    expect(cls.etaSecondsFromNow).toBeNull();
  });

  it('counters project only after 30 min of elapsed day', () => {
    expect(classifyMetric('counter', 2_600_000, 5_000_000, 0).projected).toBeNull();
    expect(classifyMetric('counter', 2_600_000, 5_000_000, 1_799).projected).toBeNull();
    // noon = half the day burned → projection doubles the measured value
    expect(classifyMetric('counter', 2_600_000, 5_000_000, 43_200).projected).toBe(5_200_000);
  });

  it('projection overshoot is warning-level only — a forecast never pages', () => {
    const cls = classifyMetric('counter', 2_600_000, 5_000_000, 43_200);
    expect(cls.pct).toBeCloseTo(0.52);
    expect(cls.projectedPct).toBeCloseTo(1.04);
    expect(cls.level).toBe(1); // projected 104% of quota, but measured 52% → warning
    expect(cls.etaSecondsFromNow).toBeGreaterThan(0);
    // even a 160% EOD forecast stays level 1 while measured sits under 60%
    const big = classifyMetric('counter', 20_000_000, 50_000_000, 21_600); // 40% / projected 160%
    expect(big.pct).toBeCloseTo(0.4);
    expect(big.projectedPct).toBeCloseTo(1.6);
    expect(big.level).toBe(1);
  });

  it('no ETA once the quota is already exhausted', () => {
    const over = classifyMetric('counter', 5_000_000, 5_000_000, 43_200);
    expect(over.level).toBe(2);
    expect(over.etaSecondsFromNow).toBeNull();
  });

  it('zero usage never projects (divide-by-zero guard)', () => {
    expect(classifyMetric('counter', 0, 5_000_000, 43_200).projected).toBeNull();
  });
});

describe('pollCfUsage — integration', () => {
  it('is a no-op with zero accounts (dormant until onboarding, zero fetches)', async () => {
    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary).toEqual({ polled: 0, recorded: 0, alertsSent: 0, failures: [] });
    expect(gqlHits.length).toBe(0);
  });

  it('skips disabled accounts entirely (no fetch, no state rows)', async () => {
    await seedCfAccount({ enabled: 0 });
    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary.polled).toBe(0);
    expect(gqlHits.length).toBe(0);
    expect(await getUsageState(DAY, TEST_CF.accountId)).toHaveLength(0);
  });

  it('records all 9 metrics with values, projections for counters only, no alerts', async () => {
    await seedCfAccount();
    useGqlFixture({
      d1Read: 1_000_000, d1Write: 10_000, wkrReq: 10_000, wkrErr: 3,
      kvOps: 5_000, kvBytes: 100_000_000, kvKeys: 120, r2Bytes: 1_000_000_000, r2Objs: 50,
    });

    const summary = await pollCfUsage(DB, CF_TEST_NOW);

    expect(summary).toEqual({ polled: 1, recorded: 9, alertsSent: 0, failures: [] });
    const rows = await getUsageState(DAY, TEST_CF.accountId);
    expect(rows).toHaveLength(9);
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
    expect(byMetric.d1_rows_read.value).toBe(1_000_000);
    expect(byMetric.d1_rows_read.projected_eod).toBe(2_000_000); // noon → ×2
    expect(byMetric.workers_errors.value).toBe(3);
    expect(byMetric.workers_errors.projected_eod).toBeNull(); // record-only: quota 0 → no projection
    expect(byMetric.kv_storage_bytes.value).toBe(100_000_000);
    expect(byMetric.kv_storage_bytes.projected_eod).toBeNull(); // gauges never project
    expect(byMetric.r2_objects.value).toBe(50);
    rows.forEach((r) => expect(r.alerted_level).toBe(0));

    const account = await getCfAccount(TEST_CF.accountId);
    expect(account?.last_ok_at).toBeGreaterThan(0);
    expect(account?.last_error).toBeNull();
    expect(slackPosts).toHaveLength(0);
    expect(emailPosts).toHaveLength(0);
  });

  it('sums D1 groups across databases client-side (sum-of-sums)', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 1_000_000, d1Read2: 1_500_000 });
    await pollCfUsage(DB, CF_TEST_NOW);
    const rows = await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read');
    expect(rows[0]?.value).toBe(2_500_000);
  });

  it('60% dispatches exactly one warning; an identical re-poll stays silent', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 3_000_000 });

    const first = await pollCfUsage(DB, CF_TEST_NOW);
    expect(first.alertsSent).toBe(1);
    expect(slackPosts.filter((p) => p.channel === 'C_WARNING')).toHaveLength(1);
    const warned = slackPosts.find((p) => p.channel === 'C_WARNING');
    expect(warned?.body).toContain('配額警告');
    expect(emailPosts).toHaveLength(0); // warnings never page the inbox
    expect((await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read'))[0]?.alerted_level).toBe(1);

    const second = await pollCfUsage(DB, CF_TEST_NOW + 60_000);
    expect(second.alertsSent).toBe(0);
    expect(slackPosts).toHaveLength(1);
  });

  it('escalates warning → critical at 80% (Slack critical + email); never downgrades after', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 3_000_000 });
    await pollCfUsage(DB, CF_TEST_NOW);

    useGqlFixture({ d1Read: 4_000_000 });
    const escalated = await pollCfUsage(DB, CF_TEST_NOW + 60_000);
    expect(escalated.alertsSent).toBe(1);
    const critical = slackPosts.find((p) => p.channel === 'C_CRITICAL');
    expect(critical?.body).toContain('配額危險');
    expect(critical?.body).toContain('80%');
    expect(emailPosts).toHaveLength(1); // critical auto-emails (EMAIL_LEVELS)
    expect((await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read'))[0]?.alerted_level).toBe(2);

    // usage drops back to 70% → level stays 2, no further alert, no recovery
    useGqlFixture({ d1Read: 3_500_000 });
    const cooled = await pollCfUsage(DB, CF_TEST_NOW + 120_000);
    expect(cooled.alertsSent).toBe(0);
    expect((await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read'))[0]?.alerted_level).toBe(2);
    expect(slackPosts).toHaveLength(2); // 1 warning + 1 critical, nothing more
  });

  it('first poll already ≥80% goes straight to critical (post-outage catch-up)', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 4_500_000 });
    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary.alertsSent).toBe(1);
    expect(emailPosts).toHaveLength(1);
  });

  it('projection variant warns below the threshold with EOD% in the message', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 2_600_000 }); // 52% measured, 104% projected at noon

    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary.alertsSent).toBe(1);
    const warned = slackPosts.find((p) => p.channel === 'C_WARNING');
    expect(warned?.body).toContain('預估今日超額');
    expect(warned?.body).toContain('104%');
    expect(emailPosts).toHaveLength(0);
    const row = (await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read'))[0];
    expect(row?.projected_eod).toBe(5_200_000);
    expect(row?.alerted_level).toBe(1);
  });

  it('no projection alert in the first 30 minutes of the UTC day', async () => {
    await seedCfAccount();
    useGqlFixture({ d1Read: 2_600_000 });
    const quarterPast = Date.UTC(2026, 8, 11, 0, 15, 0); // elapsed 900s

    const summary = await pollCfUsage(DB, quarterPast);
    expect(summary.alertsSent).toBe(0);
    const row = (await getUsageState(DAY, TEST_CF.accountId, 'd1_rows_read'))[0];
    expect(row?.projected_eod).toBeNull();
  });

  it('counter crossing UTC midnight re-warns on the fresh quota day', async () => {
    await seedCfAccount();
    // yesterday's row already critical — dedup must not leak across days
    await DB.prepare(
      `INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level)
       VALUES (?, ?, 'd1_rows_read', 4_000_000, NULL, 2)`
    ).bind(DAY, TEST_CF.accountId).run();

    useGqlFixture({ d1Read: 3_200_000 });
    const summary = await pollCfUsage(DB, CF_TEST_NOW + 86_400_000);
    expect(summary.alertsSent).toBe(1); // fresh day, level 0 → 1 again
    expect((await getUsageState(NEXT_DAY, TEST_CF.accountId, 'd1_rows_read'))[0]?.alerted_level).toBe(1);
  });

  it('gauges carry yesterday’s alerted_level: steady 55% stays silent, growth to 82% pages', async () => {
    await seedCfAccount();
    await DB.prepare(
      `INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level)
       VALUES (?, ?, 'kv_storage_bytes', 644_245_094, NULL, 1)`
    ).bind(DAY, TEST_CF.accountId).run();

    // next day: 55% — carried level 1 suppresses the morning re-nag
    useGqlFixture({ kvBytes: 590_558_003 });
    const steady = await pollCfUsage(DB, CF_TEST_NOW + 86_400_000);
    expect(steady.alertsSent).toBe(0);
    expect((await getUsageState(NEXT_DAY, TEST_CF.accountId, 'kv_storage_bytes'))[0]?.alerted_level).toBe(1);

    // grows to 82% overnight → 2 > carried 1 → critical
    useGqlFixture({ kvBytes: 880_468_296 });
    const grown = await pollCfUsage(DB, CF_TEST_NOW + 86_400_000 + 60_000);
    expect(grown.alertsSent).toBe(1);
    expect(emailPosts).toHaveLength(1);
    expect((await getUsageState(NEXT_DAY, TEST_CF.accountId, 'kv_storage_bytes'))[0]?.alerted_level).toBe(2);
  });
});

describe('pollCfUsage — failure handling', () => {
  it('isolates a failing account and records its error without blocking the rest', async () => {
    await seedCfAccount({ label: 'Broken', api_token: TEST_CF.token });
    await seedCfAccount({
      account_id: TEST_CF.accountIdB, label: 'Healthy', api_token: TEST_CF.tokenB,
    });
    network.use(
      http.post(TEST_CF.gqlUrl, async ({ request }) => {
        const auth = request.headers.get('Authorization') ?? '';
        if (auth === bearer(TEST_CF.token)) return new HttpResponse(null, { status: 500 });
        return HttpResponse.json(usageFixture({ wkrReq: 1_000 }));
      })
    );

    const summary = await pollCfUsage(DB, CF_TEST_NOW);

    expect(summary.polled).toBe(2);
    expect(summary.recorded).toBe(9); // healthy account only
    expect(summary.alertsSent).toBe(0);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ label: 'Broken', error: 'HTTP 500' });

    const broken = await getCfAccount(TEST_CF.accountId);
    expect(broken?.last_error).toContain('HTTP 500');
    expect(broken?.last_ok_at).toBe(0); // untouched — still "never succeeded"
    const healthy = await getCfAccount(TEST_CF.accountIdB);
    expect(healthy?.last_error).toBeNull();
    expect(healthy?.last_ok_at).toBeGreaterThan(0);

    // ok→fail transition = one self-warning Slack message (not email: not all failed)
    expect(slackPosts.filter((p) => p.channel === 'C_WARNING')).toHaveLength(1);
    expect(emailPosts).toHaveLength(0);
  });

  it('escalates the self-warning to email only when every enabled account fails', async () => {
    await seedCfAccount();
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB });
    network.use(http.post(TEST_CF.gqlUrl, () => new HttpResponse(null, { status: 503 })));

    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary.failures).toHaveLength(2);
    expect(slackPosts.filter((p) => p.channel === 'C_WARNING')).toHaveLength(1);
    expect(emailPosts).toHaveLength(1); // poller is blind → emailWorthy
  });

  it('stays silent on repeat failures (transition-gated, one page per incident)', async () => {
    await seedCfAccount();
    network.use(http.post(TEST_CF.gqlUrl, () => new HttpResponse(null, { status: 401 })));

    await pollCfUsage(DB, CF_TEST_NOW);
    await pollCfUsage(DB, CF_TEST_NOW + 60_000);

    expect(slackPosts).toHaveLength(1); // second identical failure → no re-warn
    const broken = await getCfAccount(TEST_CF.accountId);
    expect(broken?.last_error).toContain('token invalid or lacks Analytics Read');
  });

  it('maps GraphQL body errors and empty accounts to readable failures', async () => {
    await seedCfAccount();
    network.use(
      http.post(TEST_CF.gqlUrl, () =>
        HttpResponse.json({ errors: [{ message: 'could not resolve dataset' }] })
      )
    );
    const withErrors = await pollCfUsage(DB, CF_TEST_NOW);
    expect(withErrors.failures[0]?.error).toContain('GraphQL errors');

    await resetDb();
    await setSlackSettings();
    await seedCfAccount();
    network.use(http.post(TEST_CF.gqlUrl, () => HttpResponse.json(EMPTY_ACCOUNTS)));
    const withEmpty = await pollCfUsage(DB, CF_TEST_NOW);
    expect(withEmpty.failures[0]?.error).toContain('empty viewer.accounts');
  });
});
