// src/services/cfUsage.ts
// CF account usage quota monitor (2026-09-11).
//
// Born from two shared-account D1 quota exhaustion incidents (2026-09-07 log
// cleanup ~4.1M rows/day, 2026-09-11 countRecentErrors ~7.3M rows/day) that
// were only discovered when services started returning HTTP 500. This module
// polls the Cloudflare GraphQL Analytics API for every onboarded account
// every 30 minutes (cron gate in cron.ts) and alerts at 60% / 80% of each
// free-tier daily quota, plus a burn-rate projection warning.
//
// Self-usage discipline — the monitor must not burn the very quota it
// watches (the operator's explicit constraint): per poll it costs
//   reads:  1× cf_accounts row per account + 9 state rows per account
//           (PK day_utc prefix scan) + ≤9 yesterday rows on day rollover
//           ≈ 80 rows fleet-wide (8 accounts)
//   writes: 9 upserts + ≤9 claims + 1 health update per account ≈ 80 rows
// At 48 polls/day that is ~3.8k rows read + ~3.8k rows written per day —
// 0.08% of the 5M read / 3.8% of the 100k written free quota. The poller's
// own usage shows up in the host account's d1_rows_read metric — the
// monitor watching itself is a feature, not a bug.
//
// Alert semantics differ from the service-check path deliberately:
// - No recovery alerts. A quota resetting at UTC midnight is a non-event;
//   cf_usage_state IS the record.
// - No logs-table writes. Synthetic rows in the pulse history would muddy
//   the fail-dead semantics (invariant ①: detection is "no pulse").
// - Dedup is the alerted_level state machine (monotonic within a UTC day,
//   CAS-claimed before dispatch), not the checks cooldown machinery.

import { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { dispatchAlert } from './alert';
import type { SlackAlertData } from './alert';
import { refreshResourceNamesIfNeeded } from './cfResources';

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** Warning threshold (Slack) — operator-approved 2026-09-11. */
const WARN_THRESHOLD = 0.6;
/** Critical threshold (Slack + email) — operator-approved 2026-09-11. */
const CRITICAL_THRESHOLD = 0.8;
/** Burn-rate projection needs ≥30 min of elapsed UTC day — below this the
 *  linear projection is meaningless (first-poll divide-by-nearly-zero). */
const PROJECTION_MIN_ELAPSED_SECONDS = 1800;

export type CfPlanId = 'free' | 'paid';
export type MetricKind = 'counter' | 'gauge';

/** Row of the cf_accounts table. api_token is an account-scoped
 *  Analytics-Read token stored in D1 (same model as the Slack/email tokens
 *  in settings — NOT a Worker secret; see SECRETS.md). */
export interface CfAccount {
  account_id: string;
  label: string;
  api_token: string;
  plan: CfPlanId;
  enabled: number;
  last_ok_at: number;
  last_error: string | null;
  created_at: number;
}

/** What pollCfUsage returns — the admin "run now" button renders it. */
export interface PollFailure {
  accountId: string;
  label: string;
  error: string;
}
export interface PollSummary {
  polled: number;
  recorded: number;
  alertsSent: number;
  failures: PollFailure[];
}

// ===== Dataset registry =====
// One batched GraphQL document per account (tokens are account-scoped, so
// per-account fetches are forced). Verified against the live API
// 2026-09-11: dimensions/sum/max are selection fields, never parenthesized
// args; the three filter forms per dataset are pinned below. A live-API
// mismatch during verification is a one-line fix here.

interface DatasetDef {
  /** Alias inside the accounts node (d1/wkr/kvo/kvs/r2s). */
  alias: string;
  dataset: string;
  agg: 'sum' | 'max';
  filterKind: 'date' | 'datetime' | 'datetimeHour';
  /** Dimension fields to select; empty = omit the dimensions selection. */
  dimensions: string[];
  /** GraphQL field -> metric registry key. */
  fields: Record<string, string>;
}

const DATASETS: readonly DatasetDef[] = [
  {
    alias: 'd1', dataset: 'd1AnalyticsAdaptiveGroups', agg: 'sum', filterKind: 'date',
    // Grouped per database — client-side sum-of-sums = account total.
    dimensions: ['databaseId'],
    fields: { rowsRead: 'd1_rows_read', rowsWritten: 'd1_rows_written' },
  },
  {
    alias: 'wkr', dataset: 'workersInvocationsAdaptive', agg: 'sum', filterKind: 'datetime',
    dimensions: [],
    fields: { requests: 'workers_requests', errors: 'workers_errors' },
  },
  {
    alias: 'kvo', dataset: 'kvOperationsAdaptiveGroups', agg: 'sum', filterKind: 'datetimeHour',
    // Read/write split via an actionID dimension is unverified — monitoring
    // the total against the 100k reads quota; writes are a ~1% slice.
    dimensions: [],
    fields: { requests: 'kv_ops' },
  },
  {
    alias: 'kvs', dataset: 'kvStorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimensions: [],
    fields: { byteCount: 'kv_storage_bytes', keyCount: 'kv_storage_keys' },
  },
  {
    alias: 'r2s', dataset: 'r2StorageAdaptiveGroups', agg: 'max', filterKind: 'date',
    dimensions: [],
    fields: { payloadSize: 'r2_storage_bytes', objectCount: 'r2_objects' },
  },
];

// ===== Metric registry =====
// quotas absent (or 0) for the account's plan = record-only: value stored
// and displayed, never alerts, never projects (workers_errors, key/object
// counts have no clean free-tier daily quota).

interface MetricDef {
  label: string;
  kind: MetricKind;
  quotas: Partial<Record<CfPlanId, number>>;
}

export const METRICS: Readonly<Record<string, MetricDef>> = {
  d1_rows_read: { label: 'D1 rows 讀取', kind: 'counter', quotas: { free: 5_000_000 } },
  d1_rows_written: { label: 'D1 rows 寫入', kind: 'counter', quotas: { free: 100_000 } },
  workers_requests: { label: 'Workers 請求', kind: 'counter', quotas: { free: 100_000 } },
  workers_errors: { label: 'Workers 錯誤', kind: 'counter', quotas: {} },
  kv_ops: { label: 'KV 操作', kind: 'counter', quotas: { free: 100_000 } },
  kv_storage_bytes: { label: 'KV 儲存量', kind: 'gauge', quotas: { free: 1_073_741_824 } },
  kv_storage_keys: { label: 'KV keys 數', kind: 'gauge', quotas: {} },
  r2_storage_bytes: { label: 'R2 儲存量', kind: 'gauge', quotas: { free: 10_737_418_240 } },
  r2_objects: { label: 'R2 物件數', kind: 'gauge', quotas: {} },
};

/** Quota for a metric on a plan — 0 = record-only (no quota). Single
 *  derivation shared by the poller thresholds, the admin snapshot table,
 *  and the homepage CF pane (one implementation rule). */
export function quotaFor(metric: string, plan: CfPlanId): number {
  const def = METRICS[metric];
  return def ? (def.quotas[plan] ?? 0) : 0;
}

// ===== Pure helpers (unit-tested directly) =====

/** UTC quota day 'YYYY-MM-DD' (quota resets UTC 00:00 = 08:00 Taipei). */
const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

const previousUtcDay = (dayUtc: string): string =>
  new Date(Date.parse(`${dayUtc}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Build the per-account batched GraphQL document — all five datasets in
 *  one request. Pure: every timestamp derives from nowMs (testable). */
export function buildAccountQuery(accountId: string, nowMs: number): string {
  const day = utcDay(nowMs);
  const datetime = `${day}T00:00:00Z`;
  const parts = DATASETS.map((ds) => {
    const filter =
      ds.filterKind === 'date'
        ? `date_geq: "${day}"`
        : ds.filterKind === 'datetime'
          ? `datetime_geq: "${datetime}"`
          : `datetimeHour_geq: "${datetime}"`;
    const dims = ds.dimensions.length > 0 ? `dimensions { ${ds.dimensions.join(' ')} } ` : '';
    const aggFields = Object.keys(ds.fields).join(' ');
    const agg = ds.agg === 'sum' ? `sum { ${aggFields} }` : `max { ${aggFields} }`;
    return `${ds.alias}: ${ds.dataset}(limit: 100, filter: { ${filter} }) { ${dims}${agg} }`;
  });
  return `query { viewer { accounts(filter: {accountTag: "${accountId}"}) { ${parts.join(' ')} } } }`;
}

/** Threshold + projection verdict for one metric. Pure. */
export interface Classification {
  /** Desired alert level: 0 none | 1 warning | 2 critical. */
  level: 0 | 1 | 2;
  pct: number | null;
  /** Linear burn-rate projection to end of UTC day (counters only). */
  projected: number | null;
  projectedPct: number | null;
  /** Seconds from now until the quota exhausts at the current rate; only
   *  set when the projection exceeds the quota. */
  etaSecondsFromNow: number | null;
}

export function classifyMetric(
  kind: MetricKind,
  value: number,
  quota: number,
  elapsedSeconds: number
): Classification {
  const none: Classification = { level: 0, pct: null, projected: null, projectedPct: null, etaSecondsFromNow: null };
  if (quota <= 0) return none; // record-only metric
  const pct = value / quota;
  const projected =
    kind === 'counter' && elapsedSeconds >= PROJECTION_MIN_ELAPSED_SECONDS && value > 0
      ? value / (elapsedSeconds / 86400)
      : null;
  const projectedPct = projected !== null ? projected / quota : null;
  let level: 0 | 1 | 2 = 0;
  if (pct >= CRITICAL_THRESHOLD) level = 2;
  else if (pct >= WARN_THRESHOLD) level = 1;
  else if (projected !== null && projected > quota) level = 1; // projection variant
  // Projection never reaches critical — a forecast must not page email;
  // only a measured ≥80% does.
  const etaSecondsFromNow =
    projected !== null && projected > quota && value > 0 && value < quota
      ? (quota - value) / (value / elapsedSeconds)
      : null;
  return { level, pct, projected, projectedPct, etaSecondsFromNow };
}

// ===== GraphQL fetch + parse =====

interface GqlGroup {
  dimensions?: Record<string, unknown> | null;
  sum?: Record<string, number | null> | null;
  max?: Record<string, number | null> | null;
}
interface GqlAccountNode {
  [alias: string]: GqlGroup[] | null | undefined;
}
interface GqlResponse {
  data?: { viewer?: { accounts?: GqlAccountNode[] | null } } | null;
  errors?: Array<{ message?: string } | string> | null;
}

/** Fetch one account's usage (all datasets in one request). Throws with a
 *  readable message on every failure mode — the caller records it in
 *  cf_accounts.last_error and the admin UI / self-warning surface it. */
async function fetchAccountUsage(account: CfAccount, nowMs: number): Promise<Map<string, number>> {
  const response = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.api_token}`,
    },
    body: JSON.stringify({ query: buildAccountQuery(account.account_id, nowMs) }),
    // Inline timeout per codebase idiom (no shared fetch helper).
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' — token invalid or lacks Analytics Read'
        : '';
    throw new Error(`HTTP ${response.status}${hint}`);
  }
  const body = (await response.json()) as GqlResponse;
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

  const values = new Map<string, number>();
  for (const ds of DATASETS) {
    // Missing dataset / null group list = zero usage, not an error.
    const groups = node[ds.alias] ?? [];
    for (const [field, metricKey] of Object.entries(ds.fields)) {
      let v = 0;
      for (const g of groups) {
        const raw = ds.agg === 'sum' ? g.sum?.[field] : g.max?.[field];
        const n = typeof raw === 'number' ? raw : 0;
        v = ds.agg === 'sum' ? v + n : Math.max(v, n);
      }
      values.set(metricKey, Math.round(v));
    }
  }
  return values;
}

// ===== Alert payloads =====

const fmtTaipei = (ms: number): string =>
  new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));

interface LevelClaim {
  metric: string;
  fromLevel: number;
  cls: Classification;
  quota: number;
}

function buildUsageAlert(
  account: CfAccount,
  claim: LevelClaim,
  value: number,
  nowMs: number
): SlackAlertData {
  const def = METRICS[claim.metric];
  const cls = claim.cls;
  const pctText = cls.pct !== null ? `${Math.round(cls.pct * 100)}%` : '—';
  const used = `${value.toLocaleString()} / ${claim.quota.toLocaleString()}（${pctText}）`;
  // Projection variant: measured value still below the warning line but the
  // burn rate says the day will overshoot.
  const isProjection =
    cls.pct !== null && cls.pct < WARN_THRESHOLD && cls.projectedPct !== null && cls.projectedPct > 1;

  let title: string;
  let message: string;
  if (cls.level === 2) {
    title = `配額危險 — 已用 ${pctText}`;
    message = `已用 ${used}，已越 80% 危險線——額度耗盡時帳號內所有服務同時 500（9/7、9/11 事故模式）。`;
  } else if (isProjection) {
    const etaText = cls.etaSecondsFromNow !== null ? `約 ${fmtTaipei(nowMs + cls.etaSecondsFromNow * 1000)}` : '';
    title = '配額預警 — 預估今日超額';
    message = `已用 ${used}；依目前燃燒速率預估 UTC 日結達 ${Math.round((cls.projectedPct ?? 0) * 100)}%，${etaText}觸頂（額度 UTC 00:00＝台北 08:00 重置）。`;
  } else {
    title = `配額警告 — 已用 ${pctText}`;
    message = `已用 ${used}，已過 60% 警戒線。`;
  }

  return {
    checkId: `cf-usage:${account.account_id}:${claim.metric}`,
    projectName: 'CF 用量監控',
    checkName: `${account.label} / ${def.label}`,
    level: cls.level === 2 ? 'critical' : 'warning',
    title,
    message,
    metadata: {
      指標: def.label,
      帳號: account.label,
      已用: value.toLocaleString(),
      配額: claim.quota > 0 ? claim.quota.toLocaleString() : '—',
      已用百分比: pctText,
      預估EOD: cls.projectedPct !== null ? `${Math.round(cls.projectedPct * 100)}%` : '—',
      重置: 'UTC 00:00（台北 08:00）',
    },
    // Critical auto-emails via EMAIL_LEVELS; warnings stay Slack-only — a
    // forecast must not page the inbox.
  };
}

// ===== Poller =====

/** Poll one account end-to-end: fetch → classify → batched upsert + CAS
 *  claims → dispatch claimed alerts → update account health. Throws only
 *  on fetch/parse/DB failure — the caller isolates it via allSettled. */
async function pollAccount(
  db: D1Database,
  account: CfAccount,
  nowMs: number,
  dayUtc: string,
  elapsedSec: number
): Promise<{ recorded: number; alertsSent: number }> {
  const values = await fetchAccountUsage(account, nowMs);
  const nowSec = Math.floor(nowMs / 1000);

  // Today's stored levels — PK (day_utc, account_id, metric) prefix scan.
  const todayRows = await db
    .prepare('SELECT metric, alerted_level FROM cf_usage_state WHERE day_utc = ? AND account_id = ?')
    .bind(dayUtc, account.account_id)
    .all<{ metric: string; alerted_level: number }>();
  const storedLevels = new Map((todayRows.results ?? []).map((r) => [r.metric, r.alerted_level]));

  // Gauge carry-over: storage quotas do not reset at UTC midnight — on the
  // first poll of a new day, inherit yesterday's alerted_level so a
  // steady-state 70% does not re-nag every morning while 60%→80% growth
  // overnight still alerts. Counters start each day at 0 naturally.
  const missingGauges = Object.keys(METRICS).filter(
    (m) => !storedLevels.has(m) && METRICS[m].kind === 'gauge'
  );
  if (missingGauges.length > 0) {
    const yRows = await db
      .prepare('SELECT metric, alerted_level FROM cf_usage_state WHERE day_utc = ? AND account_id = ?')
      .bind(previousUtcDay(dayUtc), account.account_id)
      .all<{ metric: string; alerted_level: number }>();
    for (const row of yRows.results ?? []) {
      if (missingGauges.includes(row.metric)) storedLevels.set(row.metric, row.alerted_level);
    }
  }

  // One batch per account: an upsert per metric (preserves alerted_level on
  // conflict, seeds gauge carry-over on first insert) + a CAS claim per
  // level upgrade (changes === 1 required before dispatch — retried cron
  // firings / racing run-button yields exactly one alert; claimAlertSlot
  // idiom from logic.ts).
  const statements: D1PreparedStatement[] = [];
  const claims: LevelClaim[] = [];
  const claimResultIdx: number[] = [];
  for (const [metricKey, def] of Object.entries(METRICS)) {
    const value = values.get(metricKey) ?? 0;
    const quota = quotaFor(metricKey, account.plan);
    const cls = classifyMetric(def.kind, value, quota, elapsedSec);
    const currentLevel = storedLevels.get(metricKey) ?? 0;

    statements.push(
      db
        .prepare(
          `INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (day_utc, account_id, metric) DO UPDATE SET
             value = excluded.value,
             projected_eod = excluded.projected_eod,
             updated_at = excluded.updated_at`
        )
        .bind(
          dayUtc,
          account.account_id,
          metricKey,
          value,
          cls.projected !== null ? Math.round(cls.projected) : null,
          currentLevel,
          nowSec
        )
    );

    if (cls.level > currentLevel) {
      claims.push({ metric: metricKey, fromLevel: currentLevel, cls, quota });
      claimResultIdx.push(statements.length);
      statements.push(
        db
          .prepare(
            `UPDATE cf_usage_state SET alerted_level = ?, updated_at = ?
             WHERE day_utc = ? AND account_id = ? AND metric = ? AND alerted_level = ?`
          )
          .bind(cls.level, nowSec, dayUtc, account.account_id, metricKey, currentLevel)
      );
    }
  }

  const results = await db.batch(statements);
  let alertsSent = 0;
  for (let i = 0; i < claims.length; i++) {
    if ((results[claimResultIdx[i]]?.meta?.changes ?? 0) !== 1) continue; // lost the race
    await dispatchAlert(db, buildUsageAlert(account, claims[i], values.get(claims[i].metric) ?? 0, nowMs));
    alertsSent++;
  }

  await db
    .prepare('UPDATE cf_accounts SET last_ok_at = ?, last_error = NULL WHERE account_id = ?')
    .bind(nowSec, account.account_id)
    .run();

  return { recorded: values.size, alertsSent };
}

/** Poll every enabled account, record usage, dispatch threshold alerts, and
 *  self-report poller failures. Never throws — cron must stay alive; the
 *  summary carries the outcome (admin run button renders it). */
export async function pollCfUsage(db: D1Database, nowMs: number = Date.now()): Promise<PollSummary> {
  const accountsResult = await db
    .prepare('SELECT * FROM cf_accounts WHERE enabled = 1')
    .all<CfAccount>();
  const accounts = accountsResult.results ?? [];
  const summary: PollSummary = { polled: 0, recorded: 0, alertsSent: 0, failures: [] };
  // Dormant until the operator onboards accounts — also keeps the existing
  // cron tests deterministic (zero outbound fetches with no rows seeded).
  if (accounts.length === 0) return summary;

  const dayUtc = utcDay(nowMs);
  const elapsedSec = Math.floor(nowMs / 1000) % 86400;
  // Previously-failing accounts drive the self-warning transition gate.
  const previouslyFailed = new Set(
    accounts.filter((a) => a.last_error !== null).map((a) => a.account_id)
  );

  const settled = await Promise.allSettled(
    accounts.map((account) => pollAccount(db, account, nowMs, dayUtc, elapsedSec))
  );

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    summary.polled++;
    const r = settled[i];
    if (r.status === 'fulfilled') {
      summary.recorded += r.value.recorded;
      summary.alertsSent += r.value.alertsSent;
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      summary.failures.push({ accountId: account.account_id, label: account.label, error: reason });
      // last_ok_at deliberately untouched — it still says when data was last good.
      await db
        .prepare('UPDATE cf_accounts SET last_error = ? WHERE account_id = ?')
        .bind(reason.slice(0, 500), account.account_id)
        .run();
    }
  }

  // Daily per-type name refresh for the detail fragment (cfResources.ts).
  // Best-effort by design: a name-refresh failure never alters the poll
  // summary or the alert paths — unresolved names degrade to short ids.
  for (const account of accounts) {
    try {
      await refreshResourceNamesIfNeeded(db, account, nowMs);
    } catch (error) {
      console.error(`[cf-usage] name refresh failed for ${account.label}:`, error);
    }
  }

  // Self-warning, transition-gated: page only on ok→fail changes so a dead
  // token costs one Slack message, not 48/day. All enabled accounts failing
  // (the poller is blind) escalates to email.
  const newlyFailed = summary.failures.filter((f) => !previouslyFailed.has(f.accountId));
  if (newlyFailed.length > 0) {
    await dispatchAlert(db, {
      checkId: 'cf-usage:poller',
      projectName: 'CF 用量監控',
      checkName: 'Poller 自我監控',
      level: 'warning',
      title: `CF 用量輪詢失敗（${summary.failures.length}/${accounts.length} 帳號）`,
      message: newlyFailed
        .map((f) => `• ${f.label}（${f.accountId.slice(0, 8)}…）: ${f.error}`)
        .join('\n'),
      emailWorthy: summary.failures.length === accounts.length,
    });
  }

  return summary;
}
