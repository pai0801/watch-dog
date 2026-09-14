// src/services/cfResources.ts
// On-demand per-resource usage detail (2026-09-12) — the homepage card's
// expand area and the usage API share this module.
//
// Contract pinned against the live GraphQL Analytics API 2026-09-11 (see
// docs/plans/2026-09-11-cf-resource-detail-api-design.md): six datasets,
// three filter forms, dimensions are selection fields. Workers, Pages and
// R2 dimension values ARE display names; D1 and KV ids resolve via REST
// lists into cf_resource_names (daily refresh, hook in cfUsage poller).
//
// Cost model (operator-approved on-demand + 5-min cache): at most ONE
// GraphQL query per account per 5 minutes per isolate — ≤288/account/day
// hard cap no matter how hard the fragment/API is hammered. Zero D1
// detail writes; name reads (~10 rows) only on cache miss. The window
// covers TWO UTC days (yesterday + today, operator ask 2026-09-14) so the
// detail can show both — one query still, only its row count doubles
// (limit raised 100→200 to match; ≤2 rows per resource per day per
// dataset at the date/datetimeHour granularity, live-verified 2026-09-14).
//
// Pages scriptName values are CF-internal deployment names of the form
// `pages-worker--<8-digit>-<env>`. Live-verified 2026-09-14 (paipeter
// account): `pages-worker` is CF's GENERIC internal Functions worker name —
// NOT the project name. The 8-digit number appears nowhere in the REST
// surface (pages/projects, per-project deployments, workers/scripts all
// grepped, zero hits), the dataset exposes no projectName dimension
// (schema-introspected: date/datetime*/scriptName/status/usageModel only),
// and Pages projects do NOT appear under their real names in
// workersInvocationsAdaptive. Per-row project attribution is therefore
// IMPOSSIBLE via API — rows render as `pages-worker #<digits>（<env>）`
// (the digits at least distinguish same-env rows) with NO link: any
// pages.dev URL would be fabricated.
//
// SECURITY: ResourceDetail intentionally has NO account id field — the
// fragment and API responses are assembled from labels only (source-level
// cutoff of the 32-hex account id, same invariant as the homepage pane).

import { D1Database } from '@cloudflare/workers-types';
import type { CfAccount } from './cfUsage';

export type ResourceGroupType = 'workers' | 'pages' | 'd1' | 'kv' | 'r2';
/** Resource types whose names come from the REST lists (cf_resource_names). */
export type NameResourceType = 'd1' | 'kv';

/** One resource row (a worker, a pages deployment, a database...). `id` is
 *  the GraphQL dimension value (normalized bare hex for KV) — internal only,
 *  NEVER rendered in HTML or serialized by the API; `name` is the display
 *  string (dimension value itself, resolved REST name, tagged Pages worker
 *  name, or 8-char short id). `metrics` = today (UTC), `metrics_prev` =
 *  yesterday (UTC). No URL field on purpose — see the Pages header note. */
export interface ResourceItem {
  id: string;
  name: string;
  metrics: Record<string, number>;
  metrics_prev: Record<string, number>;
}

/** One group (e.g. all D1 databases of the account). */
export interface ResourceGroup {
  type: ResourceGroupType;
  title: string;
  items: ResourceItem[];
}

/** What getResourceDetailByLabel returns. No account_id field BY DESIGN. */
export interface ResourceDetail {
  label: string;
  /** Unix seconds of the fetch behind this detail. */
  fetchedAt: number;
  groups: ResourceGroup[];
}

/** KV namespace ids appear in three formats across the API surface
 *  (kvOperationsAdaptiveGroups: bare hex, kvStorageAdaptiveGroups: hyphenated
 *  UUID, REST list: bare hex) — normalize before any id joins. */
export const normalizeNsId = (id: string): string => id.replace(/-/g, '').toLowerCase();

const GROUP_TITLES: Record<ResourceGroupType, string> = {
  workers: 'Workers',
  pages: 'Pages',
  d1: 'D1 Databases',
  kv: 'KV Namespaces',
  r2: 'R2 Buckets',
};

// limit:200 is a single-page assumption across the 2-day window — fleet
// scale is far below that (≤2 rows per resource per day per dataset); beyond
// it the list silently truncates.
interface ResourceDatasetDef {
  alias: string;
  dataset: string;
  agg: 'sum' | 'max';
  filterKind: 'date' | 'datetime' | 'datetimeHour';
  dimension: string;
  /** Time dimension selected alongside the resource dimension — the value
   *  decides which UTC-day bucket the row accumulates into (live-verified
   *  2026-09-14: `date` on wkr/pgs/d1/kvs/r2s, `datetimeHour` on kvo). */
  timeDimension: 'date' | 'datetimeHour';
  /** Internal accumulation bucket ('kvOps'/'kvStorage' merge later). */
  bucket: 'workers' | 'pages' | 'd1' | 'kvOps' | 'kvStorage' | 'r2';
  /** Normalize the dimension id (KV both datasets). */
  normalizeId: boolean;
  /** GraphQL field -> metric key (registry keys reused where they exist). */
  fields: Record<string, string>;
}

const RESOURCE_DATASETS: readonly ResourceDatasetDef[] = [
  {
    alias: 'wkr', dataset: 'workersInvocationsAdaptive', agg: 'sum', filterKind: 'datetime',
    dimension: 'scriptName', timeDimension: 'date', bucket: 'workers', normalizeId: false,
    fields: { requests: 'workers_requests', errors: 'workers_errors' },
  },
  {
    alias: 'pgs', dataset: 'pagesFunctionsInvocationsAdaptiveGroups', agg: 'sum', filterKind: 'datetime',
    dimension: 'scriptName', timeDimension: 'date', bucket: 'pages', normalizeId: false,
    fields: { requests: 'pages_requests' },
  },
  {
    alias: 'd1', dataset: 'd1AnalyticsAdaptiveGroups', agg: 'sum', filterKind: 'date',
    dimension: 'databaseId', timeDimension: 'date', bucket: 'd1', normalizeId: false,
    fields: { rowsRead: 'd1_rows_read', rowsWritten: 'd1_rows_written' },
  },
  {
    alias: 'kvo', dataset: 'kvOperationsAdaptiveGroups', agg: 'sum', filterKind: 'datetimeHour',
    dimension: 'namespaceId', timeDimension: 'datetimeHour', bucket: 'kvOps', normalizeId: true,
    fields: { requests: 'kv_ops' },
  },
  {
    alias: 'kvs', dataset: 'kvStorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimension: 'namespaceId', timeDimension: 'date', bucket: 'kvStorage', normalizeId: true,
    fields: { byteCount: 'kv_storage_bytes', keyCount: 'kv_storage_keys' },
  },
  {
    alias: 'r2s', dataset: 'r2StorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimension: 'bucketName', timeDimension: 'date', bucket: 'r2', normalizeId: false,
    fields: { payloadSize: 'r2_storage_bytes', objectCount: 'r2_objects' },
  },
];

/** Build the per-account six-dataset dimension query. The filter anchors at
 *  yesterday 00:00 UTC so ONE query carries both days (cost model header);
 *  rows split into today/yesterday buckets by the time dimension. Pure —
 *  every timestamp derives from nowMs (testable). */
export function buildResourceQuery(accountId: string, nowMs: number): string {
  const prevDay = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  const datetime = `${prevDay}T00:00:00Z`;
  const parts = RESOURCE_DATASETS.map((ds) => {
    const filter =
      ds.filterKind === 'date'
        ? `date_geq: "${prevDay}"`
        : ds.filterKind === 'datetime'
          ? `datetime_geq: "${datetime}"`
          : `datetimeHour_geq: "${datetime}"`;
    const aggFields = Object.keys(ds.fields).join(' ');
    const agg = ds.agg === 'sum' ? `sum { ${aggFields} }` : `max { ${aggFields} }`;
    return `${ds.alias}: ${ds.dataset}(limit: 200, filter: { ${filter} }) { dimensions { ${ds.dimension} ${ds.timeDimension} } ${agg} }`;
  });
  return `query { viewer { accounts(filter: {accountTag: "${accountId}"}) { ${parts.join(' ')} } } }`;
}

interface RgGroup {
  dimensions?: Record<string, unknown> | null;
  sum?: Record<string, number | null> | null;
  max?: Record<string, number | null> | null;
}
interface RgAccountNode {
  [alias: string]: RgGroup[] | null | undefined;
}

/** Sort keys per group: primary desc, secondary desc, id asc (deterministic). */
const SORT_KEYS: Record<ResourceGroupType, readonly [string, string | null]> = {
  workers: ['workers_requests', 'workers_errors'],
  pages: ['pages_requests', null],
  d1: ['d1_rows_read', 'd1_rows_written'],
  kv: ['kv_ops', 'kv_storage_bytes'],
  r2: ['r2_storage_bytes', 'r2_objects'],
};

/** Unresolved ids show as an 8-char prefix + '…' (never the full id — the
 *  32-hex leak guard must stay clean on every public surface). */
const shortId = (id: string): string => `${id.slice(0, 8)}…`;

/** Pages scriptName format: `pages-worker--<digits>-<env>` — the digits are
 *  CF-internal (see header). Parse to `pages-worker #<digits>（<env>）` so
 *  same-env rows stay distinguishable; anything else renders verbatim. */
const PAGES_TAG_RE = /^pages-worker--(\d+)-(production|preview)$/;
const parsePagesTag = (raw: string): string => {
  const m = PAGES_TAG_RE.exec(raw);
  return m ? `pages-worker #${m[1]}（${m[2]}）` : raw;
};

/** Parse viewer.accounts[0] of the detail query into grouped, named, sorted
 *  items. Each row carries a time dimension (date / datetimeHour) — rows on
 *  today's UTC day accumulate into `metrics`, everything else (yesterday,
 *  within the 2-day window) into `metrics_prev`. Adaptive datasets may return
 *  several rows per dimension (sampled windows) — sum-agg fields accumulate,
 *  max-agg fields take the max, per day bucket. Pure. */
export function parseResourceDetail(
  label: string,
  node: RgAccountNode,
  names: Partial<Record<NameResourceType, Map<string, string>>>,
  nowSec: number
): ResourceDetail {
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const buckets: Record<string, Map<string, ResourceItem>> = {
    workers: new Map(), pages: new Map(), d1: new Map(),
    kvOps: new Map(), kvStorage: new Map(), r2: new Map(),
  };
  const ensure = (map: Map<string, ResourceItem>, id: string): ResourceItem => {
    let item = map.get(id);
    if (!item) {
      item = { id, name: id, metrics: {}, metrics_prev: {} };
      map.set(id, item);
    }
    return item;
  };

  for (const ds of RESOURCE_DATASETS) {
    const rows = node[ds.alias] ?? []; // missing dataset = zero usage, not an error
    for (const g of rows) {
      const rawId = g.dimensions?.[ds.dimension];
      if (typeof rawId !== 'string' || rawId === '') continue;
      const id = ds.normalizeId ? normalizeNsId(rawId) : rawId;
      const item = ensure(buckets[ds.bucket], id);
      // Row's UTC day: a missing/garbage time dimension counts as today —
      // the value must never silently vanish from the visible column.
      const rawTime = g.dimensions?.[ds.timeDimension];
      const day = typeof rawTime === 'string' ? rawTime.slice(0, 10) : today;
      const target = day === today ? item.metrics : item.metrics_prev;
      for (const [field, metricKey] of Object.entries(ds.fields)) {
        const raw = ds.agg === 'sum' ? g.sum?.[field] : g.max?.[field];
        const n = typeof raw === 'number' ? raw : 0;
        const prev = target[metricKey] ?? 0;
        target[metricKey] = ds.agg === 'sum' ? prev + n : Math.max(prev, n);
      }
    }
  }

  // KV: ops and storage rows merge on the normalized id — one row per ns.
  const kvItems: ResourceItem[] = [];
  for (const id of new Set([...buckets.kvOps.keys(), ...buckets.kvStorage.keys()])) {
    kvItems.push({
      id,
      name: names.kv?.get(id) ?? shortId(id),
      metrics: {
        ...(buckets.kvOps.get(id)?.metrics ?? {}),
        ...(buckets.kvStorage.get(id)?.metrics ?? {}),
      },
      metrics_prev: {
        ...(buckets.kvOps.get(id)?.metrics_prev ?? {}),
        ...(buckets.kvStorage.get(id)?.metrics_prev ?? {}),
      },
    });
  }

  const named = (bucket: Map<string, ResourceItem>, name: (item: ResourceItem) => string): ResourceItem[] =>
    [...bucket.values()].map((item) => ({ ...item, name: name(item) }));

  const itemsByType: Record<ResourceGroupType, ResourceItem[]> = {
    workers: named(buckets.workers, (i) => i.id),
    pages: named(buckets.pages, (i) => parsePagesTag(i.id)),
    d1: named(buckets.d1, (i) => names.d1?.get(i.id) ?? shortId(i.id)),
    kv: kvItems,
    r2: named(buckets.r2, (i) => i.id),
  };

  const detail: ResourceDetail = { label, fetchedAt: nowSec, groups: [] };
  for (const type of ['workers', 'pages', 'd1', 'kv', 'r2'] as const) {
    const items = itemsByType[type];
    if (items.length === 0) continue;
    const [primary, secondary] = SORT_KEYS[type];
    items.sort((a, b) => {
      const d = (b.metrics[primary] ?? 0) - (a.metrics[primary] ?? 0);
      if (d !== 0) return d;
      if (secondary !== null) {
        const d2 = (b.metrics[secondary] ?? 0) - (a.metrics[secondary] ?? 0);
        if (d2 !== 0) return d2;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    detail.groups.push({ type, title: GROUP_TITLES[type], items });
  }
  return detail;
}

// ===== on-demand fetch + per-isolate caches =====

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** Per-isolate detail cache TTL — the load-bearing rate limiter (≤288
 *  upstream calls/account/day no matter what). */
export const CACHE_TTL_MS = 300_000;

/** Name refresh gate: per (account, resource_type) at most daily. */
export const NAME_REFRESH_INTERVAL_SEC = 86_400;

/** account label -> CfAccount | null. Null (unknown/disabled) is cached too:
 *  repeated lookups of a bad label must not hit D1 every request. */
const accountByLabelCache = new Map<string, { at: number; account: CfAccount | null }>();
/** account_id -> { at, detail } — only successful fetches are cached. */
const detailCache = new Map<string, { at: number; detail: ResourceDetail }>();

/** Test hook: module-level caches survive across tests in the shared
 *  worker — every touching suite must reset them in beforeEach. */
export function resetResourceCaches(): void {
  accountByLabelCache.clear();
  detailCache.clear();
}

async function findEnabledAccountByLabel(db: D1Database, label: string): Promise<CfAccount | null> {
  const row = await db
    .prepare('SELECT * FROM cf_accounts WHERE label = ? AND enabled = 1 ORDER BY created_at LIMIT 1')
    .bind(label)
    .first<CfAccount>();
  return row ?? null;
}

/** All stored names for an account, split by type (KV ids normalized bare
 *  hex; D1 uuids kept verbatim — both sides of that join are hyphenated). */
async function loadNames(
  db: D1Database,
  accountId: string
): Promise<Partial<Record<NameResourceType, Map<string, string>>>> {
  const rows = await db
    .prepare('SELECT resource_type, resource_id, name FROM cf_resource_names WHERE account_id = ?')
    .bind(accountId)
    .all<{ resource_type: string; resource_id: string; name: string }>();
  const names: Partial<Record<NameResourceType, Map<string, string>>> = {};
  for (const row of rows.results ?? []) {
    if (row.resource_type !== 'd1' && row.resource_type !== 'kv') continue;
    const map = names[row.resource_type] ?? new Map<string, string>();
    map.set(row.resource_type === 'kv' ? normalizeNsId(row.resource_id) : row.resource_id, row.name);
    names[row.resource_type] = map;
  }
  return names;
}

interface GqlDetailResponse {
  data?: { viewer?: { accounts?: RgAccountNode[] | null } } | null;
  errors?: Array<{ message?: string } | string> | null;
}

/** Fetch + parse one account's per-resource detail, behind the two caches.
 *  Returns null for unknown/disabled label; throws on upstream failure (the
 *  fragment route turns the throw into an inline error panel, the API into
 *  a per-account detail_error — never a page-level failure). */
export async function getResourceDetailByLabel(
  db: D1Database,
  label: string,
  nowMs: number = Date.now()
): Promise<ResourceDetail | null> {
  let cachedAccount = accountByLabelCache.get(label);
  if (!cachedAccount || nowMs - cachedAccount.at > CACHE_TTL_MS) {
    cachedAccount = { at: nowMs, account: await findEnabledAccountByLabel(db, label) };
    accountByLabelCache.set(label, cachedAccount);
  }
  if (!cachedAccount.account) return null;
  const account = cachedAccount.account;

  const cached = detailCache.get(account.account_id);
  if (cached && nowMs - cached.at <= CACHE_TTL_MS) {
    // re-stamp the requested label — a rename must not leak the old one
    return { ...cached.detail, label };
  }

  // Error mapping mirrors fetchAccountUsage in cfUsage.ts on purpose: both
  // surfaces (admin last_error vs fragment/API) speak the same vocabulary.
  const response = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.api_token}`,
    },
    body: JSON.stringify({ query: buildResourceQuery(account.account_id, nowMs) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' — token invalid or lacks Analytics Read'
        : '';
    throw new Error(`HTTP ${response.status}${hint}`);
  }
  const body = (await response.json()) as GqlDetailResponse;
  if (body.errors && body.errors.length > 0) {
    const msgs = body.errors
      .map((e) => (typeof e === 'string' ? e : e.message ?? 'unknown'))
      .join('; ');
    throw new Error(`GraphQL errors: ${msgs.slice(0, 300)}`);
  }
  const node = body.data?.viewer?.accounts?.[0];
  if (!node) {
    throw new Error('empty viewer.accounts — token not scoped to this account');
  }

  const names = await loadNames(db, account.account_id);
  const detail = parseResourceDetail(label, node, names, Math.floor(nowMs / 1000));
  detailCache.set(account.account_id, { at: nowMs, detail });
  return detail;
}

// ===== daily name refresh (REST lists → cf_resource_names) =====

/** Verified 2026-09-11 with the existing Analytics-scoped tokens on both
 *  probed accounts — no re-mint needed. A 403 here only means unresolved
 *  names degrade to short ids, never a poll failure. */
const CF_REST_BASE = 'https://api.cloudflare.com/client/v4';

interface RestListEnvelope {
  success?: boolean;
  result?: Array<Record<string, unknown>> | null;
  errors?: unknown;
}

async function fetchRestList(account: CfAccount, path: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${CF_REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${account.api_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' — token invalid or lacks list permission'
        : '';
    throw new Error(`HTTP ${response.status}${hint}`);
  }
  const body = (await response.json()) as RestListEnvelope;
  if (body.success !== true || !Array.isArray(body.result)) {
    const errs = Array.isArray(body.errors) ? body.errors : body.errors ? [body.errors] : [];
    const detail = errs.length > 0 ? `: ${JSON.stringify(errs).slice(0, 200)}` : '';
    throw new Error(`unexpected REST list envelope${detail}`);
  }
  return body.result;
}

async function fetchD1Names(account: CfAccount): Promise<Array<{ id: string; name: string }>> {
  // per_page=100 single page: >100 databases and the replace-set DELETE
  // actively removes page-2+ stored names (worse than GraphQL limit:100
  // truncation — names vanish, not just stay unresolved). Fleet << 100.
  const result = await fetchRestList(account, `/accounts/${account.account_id}/d1/database?per_page=100`);
  return result
    .map((r) => ({ id: String(r.uuid ?? ''), name: String(r.name ?? '') }))
    .filter((r) => r.id !== '' && r.name !== '');
}

async function fetchKvNames(account: CfAccount): Promise<Array<{ id: string; name: string }>> {
  // per_page=100 single page — same replace-set DELETE risk as fetchD1Names.
  const result = await fetchRestList(account, `/accounts/${account.account_id}/storage/kv/namespaces?per_page=100`);
  return result
    .map((r) => ({ id: normalizeNsId(String(r.id ?? '')), name: String(r.title ?? '') }))
    .filter((r) => r.id !== '' && r.name !== '');
}

/** Refresh cf_resource_names for one account — at most daily per type,
 *  per-type independent (a 403 on one endpoint never skips the other).
 *  Throws when a due side fails (the poller hook logs it); an account with
 *  zero resources of a type re-queries that list every poll — the gate
 *  never satisfies with no rows — costing 2 free read-only calls, accepted.
 *  Replace-set: rows absent from the list are removed via a static
 *  timestamp DELETE (§B guard forbids dynamic IN lists). */
export async function refreshResourceNamesIfNeeded(
  db: D1Database,
  account: CfAccount,
  nowMs: number
): Promise<void> {
  const nowSec = Math.floor(nowMs / 1000);
  const rows = await db
    .prepare(
      'SELECT resource_type, MAX(updated_at) AS m FROM cf_resource_names WHERE account_id = ? GROUP BY resource_type'
    )
    .bind(account.account_id)
    .all<{ resource_type: string; m: number }>();
  const lastByType = new Map((rows.results ?? []).map((r) => [r.resource_type, r.m]));

  const errors: string[] = [];
  const sides: Array<{ type: NameResourceType; fetch: () => Promise<Array<{ id: string; name: string }>> }> = [
    { type: 'd1', fetch: () => fetchD1Names(account) },
    { type: 'kv', fetch: () => fetchKvNames(account) },
  ];
  for (const side of sides) {
    if ((lastByType.get(side.type) ?? 0) > nowSec - NAME_REFRESH_INTERVAL_SEC) continue;
    try {
      const list = await side.fetch();
      const statements = list.map((r) =>
        db
          .prepare(
            `INSERT INTO cf_resource_names (account_id, resource_type, resource_id, name, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (account_id, resource_type, resource_id) DO UPDATE SET
               name = excluded.name, updated_at = excluded.updated_at`
          )
          .bind(account.account_id, side.type, r.id, r.name, nowSec)
      );
      // every upsert above stamps nowSec, so only stale rows predate it
      statements.push(
        db
          .prepare('DELETE FROM cf_resource_names WHERE account_id = ? AND resource_type = ? AND updated_at < ?')
          .bind(account.account_id, side.type, nowSec)
      );
      await db.batch(statements);
    } catch (error) {
      errors.push(`${side.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`name refresh failed (${errors.join('; ')})`);
  }
}
