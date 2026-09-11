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
// detail writes; name reads (~10 rows) only on cache miss.
//
// SECURITY: ResourceDetail intentionally has NO account id field — the
// fragment and API responses are assembled from labels only (source-level
// cutoff of the 32-hex account id, same invariant as the homepage pane).

export type ResourceGroupType = 'workers' | 'pages' | 'd1' | 'kv' | 'r2';
/** Resource types whose names come from the REST lists (cf_resource_names). */
export type NameResourceType = 'd1' | 'kv';

/** One resource row (a worker, a pages deployment, a database...). `id` is
 *  the GraphQL dimension value (normalized bare hex for KV) — internal only,
 *  NEVER rendered in HTML or serialized by the API; `name` is the display
 *  string (dimension value itself, resolved REST name, or 8-char short id). */
export interface ResourceItem {
  id: string;
  name: string;
  metrics: Record<string, number>;
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

// limit:100 is a single-page assumption — fleet scale is far below 100
// resources per type per account; beyond that the list silently truncates.
interface ResourceDatasetDef {
  alias: string;
  dataset: string;
  agg: 'sum' | 'max';
  filterKind: 'date' | 'datetime' | 'datetimeHour';
  dimension: string;
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
    dimension: 'scriptName', bucket: 'workers', normalizeId: false,
    fields: { requests: 'workers_requests', errors: 'workers_errors' },
  },
  {
    alias: 'pgs', dataset: 'pagesFunctionsInvocationsAdaptiveGroups', agg: 'sum', filterKind: 'datetime',
    dimension: 'scriptName', bucket: 'pages', normalizeId: false,
    fields: { requests: 'pages_requests' },
  },
  {
    alias: 'd1', dataset: 'd1AnalyticsAdaptiveGroups', agg: 'sum', filterKind: 'date',
    dimension: 'databaseId', bucket: 'd1', normalizeId: false,
    fields: { rowsRead: 'd1_rows_read', rowsWritten: 'd1_rows_written' },
  },
  {
    alias: 'kvo', dataset: 'kvOperationsAdaptiveGroups', agg: 'sum', filterKind: 'datetimeHour',
    dimension: 'namespaceId', bucket: 'kvOps', normalizeId: true,
    fields: { requests: 'kv_ops' },
  },
  {
    alias: 'kvs', dataset: 'kvStorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimension: 'namespaceId', bucket: 'kvStorage', normalizeId: true,
    fields: { byteCount: 'kv_storage_bytes', keyCount: 'kv_storage_keys' },
  },
  {
    alias: 'r2s', dataset: 'r2StorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimension: 'bucketName', bucket: 'r2', normalizeId: false,
    fields: { payloadSize: 'r2_storage_bytes', objectCount: 'r2_objects' },
  },
];

/** Build the per-account six-dataset dimension query. Pure — every
 *  timestamp derives from nowMs (testable). */
export function buildResourceQuery(accountId: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const datetime = `${day}T00:00:00Z`;
  const parts = RESOURCE_DATASETS.map((ds) => {
    const filter =
      ds.filterKind === 'date'
        ? `date_geq: "${day}"`
        : ds.filterKind === 'datetime'
          ? `datetime_geq: "${datetime}"`
          : `datetimeHour_geq: "${datetime}"`;
    const aggFields = Object.keys(ds.fields).join(' ');
    const agg = ds.agg === 'sum' ? `sum { ${aggFields} }` : `max { ${aggFields} }`;
    return `${ds.alias}: ${ds.dataset}(limit: 100, filter: { ${filter} }) { dimensions { ${ds.dimension} } ${agg} }`;
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

/** Parse viewer.accounts[0] of the detail query into grouped, named, sorted
 *  items. Adaptive datasets may return several rows per dimension (sampled
 *  windows) — sum-agg fields accumulate, max-agg fields take the max. Pure. */
export function parseResourceDetail(
  label: string,
  node: RgAccountNode,
  names: Partial<Record<NameResourceType, Map<string, string>>>,
  nowSec: number
): ResourceDetail {
  const buckets: Record<string, Map<string, ResourceItem>> = {
    workers: new Map(), pages: new Map(), d1: new Map(),
    kvOps: new Map(), kvStorage: new Map(), r2: new Map(),
  };
  const ensure = (map: Map<string, ResourceItem>, id: string): ResourceItem => {
    let item = map.get(id);
    if (!item) {
      item = { id, name: id, metrics: {} };
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
      for (const [field, metricKey] of Object.entries(ds.fields)) {
        const raw = ds.agg === 'sum' ? g.sum?.[field] : g.max?.[field];
        const n = typeof raw === 'number' ? raw : 0;
        const prev = item.metrics[metricKey] ?? 0;
        item.metrics[metricKey] = ds.agg === 'sum' ? prev + n : Math.max(prev, n);
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
    });
  }

  const named = (bucket: Map<string, ResourceItem>, name: (item: ResourceItem) => string): ResourceItem[] =>
    [...bucket.values()].map((item) => ({ ...item, name: name(item) }));

  const itemsByType: Record<ResourceGroupType, ResourceItem[]> = {
    workers: named(buckets.workers, (i) => i.id),
    pages: named(buckets.pages, (i) => i.id),
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
