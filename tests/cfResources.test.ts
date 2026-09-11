// tests/cfResources.test.ts
// Per-resource detail: pure query/parser tests + the on-demand fetch layer
// (Task 3) — 5-min cache behavior, error mapping, name joins.

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  buildResourceQuery,
  getResourceDetailByLabel,
  normalizeNsId,
  parseResourceDetail,
  resetResourceCaches,
} from '../src/services/cfResources';
import { network } from './network';
import {
  CF_TEST_NOW,
  DB,
  cfD1ListUrl,
  cfKvListUrl,
  resetDb,
  seedCfAccount,
  seedResourceName,
  TEST_CF,
} from './utils';

describe('normalizeNsId', () => {
  it('strips hyphens and lowercases (three observed formats → one canonical)', () => {
    expect(normalizeNsId('ABCDEF01-2345-6789-abcd-ef0123456789')).toBe('abcdef0123456789abcdef0123456789');
    expect(normalizeNsId('abcdef0123456789abcdef0123456789')).toBe('abcdef0123456789abcdef0123456789');
  });
});

describe('buildResourceQuery', () => {
  it('merges six datasets with dimension selections and the three verified filter forms', () => {
    const q = buildResourceQuery(TEST_CF.accountId, CF_TEST_NOW);
    expect(q).toContain(`accountTag: "${TEST_CF.accountId}"`);
    expect(q).toContain('workersInvocationsAdaptive');
    expect(q).toContain('pagesFunctionsInvocationsAdaptiveGroups');
    expect(q).toContain('d1AnalyticsAdaptiveGroups');
    expect(q).toContain('kvOperationsAdaptiveGroups');
    expect(q).toContain('kvStorageAdaptiveGroups');
    expect(q).toContain('r2StorageAdaptiveGroups');
    expect(q).toContain('dimensions { scriptName }');
    expect(q).toContain('dimensions { databaseId }');
    expect(q).toContain('dimensions { namespaceId }');
    expect(q).toContain('dimensions { bucketName }');
    // three verified filter forms pinned (CF_TEST_NOW = 2026-09-11T12:00Z)
    expect(q).toContain('date_geq: "2026-09-11"');
    expect(q).toContain('datetime_geq: "2026-09-11T00:00:00Z"');
    expect(q).toContain('datetimeHour_geq: "2026-09-11T00:00:00Z"');
    expect(q).toContain('limit: 100');
    // dimensions/sum/max are selection fields, never call args (live-API verified)
    expect(q).not.toContain('sum(');
    expect(q).not.toContain('max(');
    expect(q).not.toContain('dimensions(');
  });
});

/** viewer.accounts[0] fixture: adaptive multi-row, hyphenated-vs-bare KV ids. */
const detailNode = {
  wkr: [
    { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 1000, errors: 2 } },
    { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 500, errors: 0 } },
    { dimensions: { scriptName: 'zzz-worker' }, sum: { requests: 10, errors: 0 } },
  ],
  pgs: [{ dimensions: { scriptName: 'pages-worker--13581012-production' }, sum: { requests: 300 } }],
  d1: [
    { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 4_000_000, rowsWritten: 10_000 } },
    { dimensions: { databaseId: '99999999-8888-7777-6666-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } },
  ],
  kvo: [{ dimensions: { namespaceId: 'abcdef0123456789abcdef0123456789' }, sum: { requests: 42 } }],
  kvs: [{ dimensions: { namespaceId: 'ABCDEF01-2345-6789-ABCD-EF0123456789' }, max: { byteCount: 1024, keyCount: 7 } }],
  r2s: [{ dimensions: { bucketName: 'media-bucket' }, max: { payloadSize: 2_000_000_000, objectCount: 120 } }],
};

const detailNames = {
  d1: new Map([['11111111-2222-3333-4444-555555555555', 'Production DB']]),
  kv: new Map([['abcdef0123456789abcdef0123456789', 'site-cache']]),
};

describe('parseResourceDetail', () => {
  it('groups in fixed order, accumulates adaptive multi-rows, resolves names, merges KV, sorts by primary usage', () => {
    const detail = parseResourceDetail('Test Account', detailNode, detailNames, 1_000);
    expect(detail.label).toBe('Test Account');
    expect(detail.fetchedAt).toBe(1000);
    expect(detail.groups.map((g) => g.type)).toEqual(['workers', 'pages', 'd1', 'kv', 'r2']);

    const workers = detail.groups[0];
    // adaptive multi-row accumulation: 1000 + 500, sorted by requests desc
    expect(workers.items[0].name).toBe('watch-dog');
    expect(workers.items[0].metrics.workers_requests).toBe(1500);
    expect(workers.items[0].metrics.workers_errors).toBe(2);
    expect(workers.items[1].name).toBe('zzz-worker');

    // d1: resolved name wins, unresolved falls back to 8-char short id
    const d1 = detail.groups[2];
    expect(d1.items[0].name).toBe('Production DB');
    expect(d1.items[1].name).toBe('99999999…');

    // kv: ops (bare hex) + storage (hyphenated uuid) merge into ONE row
    const kv = detail.groups[3];
    expect(kv.items).toHaveLength(1);
    expect(kv.items[0].name).toBe('site-cache');
    expect(kv.items[0].metrics).toEqual({ kv_ops: 42, kv_storage_bytes: 1024, kv_storage_keys: 7 });

    // r2: dimension value IS the name
    expect(detail.groups[4].items[0].name).toBe('media-bucket');
  });

  it('omits empty groups entirely', () => {
    const node = { d1: detailNode.d1 }; // only d1 has data
    const detail = parseResourceDetail('X', node, {}, 1_000);
    expect(detail.groups.map((g) => g.type)).toEqual(['d1']);
  });

  it('sorts tie-break by id ascending (deterministic order)', () => {
    const node = {
      d1: [
        { dimensions: { databaseId: 'b-row' }, sum: { rowsRead: 5, rowsWritten: 0 } },
        { dimensions: { databaseId: 'a-row' }, sum: { rowsRead: 5, rowsWritten: 0 } },
      ],
    };
    const detail = parseResourceDetail('X', node, {}, 1_000);
    expect(detail.groups[0].items.map((i) => i.id)).toEqual(['a-row', 'b-row']);
  });

  it('max-agg datasets take the max across adaptive multi-rows (storage gauges never sum)', () => {
    const node = {
      kvs: [
        { dimensions: { namespaceId: 'abcdef0123456789abcdef0123456789' }, max: { byteCount: 1024, keyCount: 7 } },
        { dimensions: { namespaceId: 'abcdef0123456789abcdef0123456789' }, max: { byteCount: 2048, keyCount: 3 } },
      ],
    };
    const detail = parseResourceDetail('X', node, {}, 1_000);
    expect(detail.groups[0].items[0].metrics).toEqual({ kv_storage_bytes: 2048, kv_storage_keys: 7 });
  });
});

// ---- fetch layer (Task 3) ----

const REST_EMPTY = { success: true, result: [] };

const detailFixture = () => ({
  data: { viewer: { accounts: [detailNode] } },
});

let gqlHits = 0;

beforeEach(async () => {
  await resetDb();
  resetResourceCaches(); // module-level caches survive across tests (shared worker)
  gqlHits = 0;
  network.use(
    http.post(TEST_CF.gqlUrl, () => {
      gqlHits++;
      return HttpResponse.json(detailFixture());
    }),
    http.get(cfD1ListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
    http.get(cfKvListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
  );
});

describe('getResourceDetailByLabel', () => {
  it('returns null for an unknown label without any GraphQL call (null cached)', async () => {
    expect(await getResourceDetailByLabel(DB, 'nope', CF_TEST_NOW)).toBeNull();
    expect(gqlHits).toBe(0);
  });

  it('returns null for a disabled account', async () => {
    await seedCfAccount({ enabled: 0 });
    expect(await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW)).toBeNull();
    expect(gqlHits).toBe(0);
  });

  it('caches per account for 5 minutes — one GraphQL hit within TTL, refetch after', async () => {
    await seedCfAccount();
    await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW);
    await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW + 60_000);
    expect(gqlHits).toBe(1);
    await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW + 301_000);
    expect(gqlHits).toBe(2);
  });

  it('serves the requested label even when the cached detail was fetched under another label', async () => {
    await seedCfAccount();
    await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW);
    // rename the account — next request comes under the new label
    await DB.prepare("UPDATE cf_accounts SET label = 'Renamed' WHERE account_id = ?").bind(TEST_CF.accountId).run();
    // 'Renamed' misses the label cache → D1 resolves the same account → detail cache hit → re-stamp:
    const detail = await getResourceDetailByLabel(DB, 'Renamed', CF_TEST_NOW + 60_000);
    expect(detail?.label).toBe('Renamed');
    expect(gqlHits).toBe(1);
  });

  it('resolves stored names into the detail (d1 + kv, kv keyed normalized)', async () => {
    await seedCfAccount();
    await seedResourceName(TEST_CF.accountId, 'd1', '11111111-2222-3333-4444-555555555555', 'Production DB');
    await seedResourceName(TEST_CF.accountId, 'kv', 'abcdef0123456789abcdef0123456789', 'site-cache');
    const detail = await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW);
    expect(detail?.groups.find((g) => g.type === 'd1')?.items[0].name).toBe('Production DB');
    expect(detail?.groups.find((g) => g.type === 'kv')?.items[0].name).toBe('site-cache');
  });

  it('maps upstream failures to readable errors (HTTP 401 hint, GraphQL errors)', async () => {
    await seedCfAccount();
    network.use(http.post(TEST_CF.gqlUrl, () => new HttpResponse(null, { status: 401 })));
    await expect(getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW)).rejects.toThrow(
      /HTTP 401 — token invalid or lacks Analytics Read/
    );
  });

  it('a failed fetch is not cached — the next call retries and can succeed', async () => {
    await seedCfAccount();
    let fail = true;
    network.use(
      http.post(TEST_CF.gqlUrl, () => (fail ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(detailFixture())))
    );
    await expect(getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW)).rejects.toThrow('HTTP 500');
    fail = false;
    const detail = await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW);
    expect(detail?.groups.length).toBeGreaterThan(0);
  });
});
