# CF 資源明細＋對外用量 API 實作計畫（2026-09-12）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首頁 CF 帳號卡依配額緊張度排序＋折疊面顯示最緊指標＋native `<details>` 展開逐資源明細（Workers/Pages/D1/KV/R2 名稱與用量），並新增 token 保護的唯讀對外 API `GET /api/cf-usage` 供其它專案的 Claude Code 取用量做分析。

**Architecture:** 新 service `cfResources.ts` 擁有「逐資源 Analytics 合約」（六 dataset 維度查詢＋解析分組＋名稱解析＋on-demand 5 分鐘快取，零 D1 明細寫入）；D1/KV id → 名稱經 REST list 進新表 `cf_resource_names`（poller 每日刷一次）；首頁 fragment route（htmx toggle 觸發）與 API route 共用該 service；`getTodayCfUsage` 自 dashboard route 抽入 `cfUsage.ts`（route＋API 第二呼叫點）並推導 topMetric/maxRatio/warnCount 供排序與折疊面。新 Worker secret `CF_USAGE_API_TOKEN`（fail-closed `timingSafeEqual` 比對）。

**Tech Stack:** Hono 4（html tagged template）、D1 原生 prepared statements（無 ORM——專案不變式 ③，覆蓋框架 02-BUILD-SPEC §8）、htmx 1.9.10（CDN）、hyperscript（`no` operator 條件 reload）、`@cloudflare/vitest-plugin` + msw `@msw/cloudflare`（`network.use` LIFO）。

**設計文件：** `docs/plans/2026-09-11-cf-resource-detail-api-design.md`（commit `28dbd48`——目標／大綱／核定決策／實測釘死的 API 合約／負載分析／安全不變式）。本計畫完全遵守 `02-BUILD-SPEC.md`。

---

## 0. 前置合規（02-BUILD-SPEC tier major gates）

### tier 判定

**major**——新建 3 檔＋修改 ~17 檔（>5）；碰 critical-path：D1 schema（新表）、secrets（新 Worker secret 三方鏈）、新公開端點（fragment＋API）。

### getkm（規劃階段已跑，2026-09-12）

- 查詢「Cloudflare Workers vitest module-level Map cache test isolation msw」→ 三條命中，採納：
  1. **模組級狀態跨測試存活**（fileParallelism:false 每檔共用 worker；storage 非 per-test rollback）→ 本計畫的 detailCache/accountByLabelCache 必須附 `resetResourceCaches()` 測試鉤子，每個觸及的 describe `beforeEach` 呼叫。
  2. **msw `network.use` LIFO**（後註冊者勝）→ 錯誤路徑測試以計數/旗標 handler 覆蓋預設 handler，不依賴「移除」handler。
  3. fetchMock 已移除 → 一切對外 fetch 攔截走 `network.use(http.post/http.get(...))`（既有模式）。
- 既有教訓沿用：fail-closed secret 比對（缺 secret 一律 401）；introspect-before-guess（GraphQL 合約 2026-09-11 已逐 dataset 真實 token 釘死，見設計文件）。

### THINK（7 欄位）

| 欄位 | 內容 |
|------|------|
| **ROOT CAUSE** | 非修復——功能新增。根因：帳號級 DATASETS 為了 9 指標彙總把資源身分丟掉了（`dimensions: []`）——但其實 Analytics 的 dimension 值本身**就是**名稱（Workers/Pages scriptName、R2 bucketName），唯 D1 databaseId/KV namespaceId 是 opaque id 需 REST list 解析。 |
| **CORRECT LAYER** | 新 service `cfResources.ts`（逐資源合約＋快取）＋新 D1 names 表＋既有 view/route 層接線。不動 cron trigger（不變式：單一 `* * * * *`）、不動 fail-dead 路徑（不變式 ①）。 |
| **AFFECTED FILES** | 新建：`src/services/cfResources.ts`、`src/views/cfDetail.ts`、`tests/cfResources.test.ts`。修改：`src/db.sql`、`src/services/cfUsage.ts`、`src/routes/dashboard.ts`、`src/views/dashboard.ts`、`src/views/layout.ts`、`src/routes/api.ts`、`src/types.ts`、`src/lib/bindings.ts`、`wrangler.jsonc`、`.portability.toml`、`vitest.config.ts`、`.dev.vars.example`、`tests/utils.ts`、`tests/dashboard.test.ts`、`tests/api.test.ts`、`tests/cfUsage.test.ts`、`README.md`、`docs/api.md`、`docs/usage.md`、`secrets-archive/SECRETS.md`。 |
| **ASSUMPTIONS** | ①釘死的 GraphQL 合約持續有效（probe 已驗證）；②`limit:100` 單頁足夠（艦隊規模遠小於 100，超過即截斷——註解記載）；③htmx `toggle from:closest details` 對非氣泡事件有效（htmx `from:` 直接在目標掛 listener；ship-check 手動瀏覽器驗證）；④hyperscript `no` operator 語法正確（ship-check 手動驗證，測試僅鎖字串）。 |
| **SIMPLER PATH（已否決）** | 明細入 D1（每 30 分鐘輪詢寫入）→ 否決：多 ~40 寫/poll 且 poller 複雜化，on-demand＋快取已上限 288 次/日且零寫入。逐資源輪詢進告警 → YAGNI（操作者要的是「看」，告警在帳號級已足）。 |
| **RISK** | ①**部署順序**（schema → secret put → deploy；顛倒會讓 assertBindings 在 secret 就位前殺死全站——Task 10 runbook 鎖死）；②htmx/hyperscript CDN 行為（手動 ship 驗證補）；③label 變更後 detail.label 最多 5 分鐘陳舊（快取命中時以 `{ ...cached.detail, label }` 重貼請求 label，已消）。 |
| **VERDICT** | **PROCEED**——合約已實測釘死、負載經操作者核定、安全不變式有編譯期＋測試雙護欄。 |

### D33 使用者故事與驗收

> **As a** watch-dog 操作者（及跨專案 Claude Code 消費者）, **I want** 帳號卡依配額緊張度排序、折疊面顯示最緊指標、展開看到逐資源名稱用量，並有一個 token 保護的唯讀用量 API 詳載於 README, **so that** 我能在 5 秒內看出哪個帳號哪項資源最接近額度，且其它專案能自動化配額分析，不必開 CF dashboard。

驗收條件（全數通過才算完成）：

1. 帳號卡依 maxRatio 降序（同值 label 升序）；折疊面 = topMetric 線 ＋（有超標時）`N 項 ≥60%` 琥珀 chip。
2. 展開（native `<details>`）顯示全部指標 ＋ htmx 拉取 `/cf-usage/detail?label=…` fragment：Workers/Pages/R2 名稱 = dimension 值；D1/KV 名稱經 `cf_resource_names` 解析，未解析 → 8 碼短 id＋`…`。
3. 明細即時查詢 ≤1 次 GraphQL/帳號/5 分鐘（per-isolate 快取，測試鎖 TTL 行為）；**零 D1 明細寫入**；名稱刷新 ≤1 次/帳號/型別/日且 poller 掛鉤失敗不影響輪詢摘要。
4. 32-hex account id 永不出現於首頁 HTML／fragment／API 回應（特定 seed id `not.toContain` ＋泛型 `/[0-9a-f]{32}/` regex 雙護欄）。
5. `GET /api/cf-usage`：無/錯 token → 401（fail-closed、`timingSafeEqual`）；`?account=` 未知 label → 404；`?detail=1` 逐資源明細（單帳號上游失敗 → 該帳號 `detail_error`，回應仍 200）；回應零 id 零 token。
6. `make ci` 全綠＋README/api.md/usage.md/SECRETS.md 四文件同步＋部署後線上驗證矩陣通過。

### §2.3 模組塑形（14-DESIGN-PRINCIPLES §0 兩問＋§2 四條）

**cfResources.ts 兩問：**
- *這模組做什麼？*——擁有「逐資源 Analytics 合約」：六 dataset 查詢建構、維度解析分組、KV id 正規化、名稱 join、on-demand 快取、REST 名稱刷新。**不**擁有帳號級輪詢/告警（cfUsage 職責不動）。
- *誰用？*——三個消費者：首頁 fragment route、對外 API route、cfUsage poller（只叫 `refreshResourceNamesIfNeeded`）。一個真相源，零複製。

**四條檢核：**
1. `getTodayCfUsage` 抽取 = **第二呼叫點觸發**（route＋API）——分組/排序/折疊面推導單一真相源，非預先抽象。
2. 既有共用件複用不新寫：`timingSafeEqual`（lib/auth）、`quotaFor`/`METRICS`（cfUsage）、`fmtMetricValue`（lib/format）。
3. `ResourceDetail` 型別**收縮**（無 account_id 欄位——編譯期保證）：深模組＝窄介面（label＋groups）背後藏六 dataset 合約＋正規化＋快取。
4. routes 只做 auth＋組裝：fragment route 錯誤软化為 200＋面板；API route 401/404 判定＋JSON 組裝；零業務邏輯。

**循環依賴防護**：cfResources→cfUsage 是 `import type`（runtime 抹除）；cfUsage→cfResources 是 runtime import（poller hook）——runtime 無環。

---

## Task 0: market-ops 開工推卡

**Files:** 無 repo 檔（外部看板 API）。

- [ ] **Step 0.1: 推卡**

```bash
curl -s -X POST http://127.0.0.1:4420/api/boards/watch-dog/cards \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "CF 資源明細展開＋對外用量 API",
    "content": "【背景】首頁 CF 用量卡已上線（帳號級 9 指標），操作者要求：卡依最緊指標排序＋折疊＋展開看逐資源明細；並提供 API 供其它專案 Claude Code 取用量。\n【要做】cfResources service（六 dataset 維度查詢＋5min 快取）、cf_resource_names 表＋REST 名稱解析、首頁卡排序/折疊/htmx fragment、GET /api/cf-usage（Bearer CF_USAGE_API_TOKEN）、README/API 文件。\n【現況】設計文件 28dbd48 已 commit，實作計畫 docs/plans/2026-09-12-cf-resource-detail-api-plan.md。\n【驗收】make ci 全綠、部署後線上驗證矩陣（401/200/404/detail/零 32-hex）通過。",
    "stage": "implementing",
    "agent": "claude",
    "resources": ["/home/peter/Code/watch-dog/docs/plans/2026-09-12-cf-resource-detail-api-plan.md"]
  }'
```

（板已存在——前功能已建；404 時先 `POST /api/boards`。）完成後到 `~/Code/market-ops` commit＋push `tools/kanban/boards/`。

---

## Task 1: schema（cf_resource_names）＋測試 fixtures

**Files:**
- Modify: `src/db.sql`（CF 區塊尾端，`idx_cf_accounts_enabled` 之後）
- Modify: `tests/utils.ts`

- [ ] **Step 1.1: db.sql 追加表**（**註解內 [NEVER] 出現任何分號**——db.sql 被 bootstrap/tests `split(';')`）

```sql
-- Per-resource display names for the on-demand detail fragment (2026-09-12).
-- GraphQL analytics dimensions give Workers, Pages and R2 real names for
-- free (scriptName, bucketName) but D1 databaseId and KV namespaceId are
-- opaque ids — this table maps them to the names the REST list endpoints
-- return. Refreshed at most daily per (account, resource_type) by the
-- 30-min poller (refreshResourceNamesIfNeeded in cfResources ts) and read
-- by the detail fragment and the usage API. No extra index needed: every
-- read is a full scan of one account's few dozen rows and the PK prefix
-- (account_id, resource_type) already covers the refresh gate query
CREATE TABLE IF NOT EXISTS cf_resource_names (
    -- CF account tag (32 hex) — joins cf_accounts
    account_id TEXT NOT NULL,
    -- Which REST list the row came from: 'd1' or 'kv'
    resource_type TEXT NOT NULL,
    -- database uuid (D1, hyphenated) or namespace id normalized to bare hex (KV)
    resource_id TEXT NOT NULL,
    -- Display name from the REST list (database name or namespace title)
    name TEXT NOT NULL,
    -- Unix ts of the refresh that wrote this row (replace-set bookkeeping)
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, resource_type, resource_id)
);
```

- [ ] **Step 1.2: tests/utils.ts**——`resetDb` 的 batch 加一列；檔尾加 fixtures

resetDb 變更（加入 `cf_resource_names`）：

```ts
    DB.prepare('DELETE FROM cf_usage_state'),
    DB.prepare('DELETE FROM cf_resource_names'),
```

檔尾新增：

```ts
export async function seedResourceName(
  accountId: string,
  resourceType: string,
  resourceId: string,
  name: string,
  updatedAt?: number
): Promise<void> {
  await DB.prepare(
    'INSERT INTO cf_resource_names (account_id, resource_type, resource_id, name, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, resource_type, resource_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at'
  )
    .bind(accountId, resourceType, resourceId, name, updatedAt ?? nowSec())
    .run();
}

/** REST list endpoints for name resolution (msw ignores query strings —
 *  handlers match on these paths, the ?per_page=100 is appended by prod code). */
export const CF_REST_BASE = 'https://api.cloudflare.com/client/v4';
export const cfD1ListUrl = (accountId: string): string => `${CF_REST_BASE}/accounts/${accountId}/d1/database`;
export const cfKvListUrl = (accountId: string): string => `${CF_REST_BASE}/accounts/${accountId}/storage/kv/namespaces`;

/** Bearer token for GET /api/cf-usage — value MUST equal the binding in
 *  vitest.config.ts miniflare bindings (same literal-sync pattern as the
 *  ADMIN_* test pair). */
export const TEST_USAGE_API_TOKEN = 'test-usage-api-token';
```

- [ ] **Step 1.3: 跑既有測試確認 schema 無破壞**

Run: `npm run test:app` — Expected: 全綠（schema 冪等新增、resetDb 擴充不影響既有）。

- [ ] **Step 1.4: Commit**

```bash
git add src/db.sql tests/utils.ts
git commit -m "feat(cf-detail): cf_resource_names 表＋測試 fixtures（schema/seed/REST URL 常數）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: cfResources 純層（查詢建構＋解析分組）

**Files:**
- Create: `src/services/cfResources.ts`
- Create: `tests/cfResources.test.ts`

- [ ] **Step 2.1: 失敗測試先行**（tests/cfResources.test.ts——本 task 只寫純函式部分，fetch 測試 Task 3 補）

```ts
// tests/cfResources.test.ts
// Per-resource detail: pure query/parser tests + the on-demand fetch layer
// (Task 3) — 5-min cache behavior, error mapping, name joins.

import { describe, expect, it } from 'vitest';
import {
  buildResourceQuery,
  normalizeNsId,
  parseResourceDetail,
} from '../src/services/cfResources';
import { CF_TEST_NOW, TEST_CF } from './utils';

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
});
```

- [ ] **Step 2.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/cfResources.test.ts`
Expected: FAIL——`Cannot find module '../src/services/cfResources'`。

- [ ] **Step 2.3: 實作純層**（src/services/cfResources.ts——本 task 建檔，Task 3/4 追加 fetch/refresh 區塊）

```ts
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
```

- [ ] **Step 2.4: 跑測試確認通過**

Run: `npm run test:app -- tests/cfResources.test.ts` — Expected: PASS（純函式 6 案）。

- [ ] **Step 2.5: Commit**

```bash
git add src/services/cfResources.ts tests/cfResources.test.ts
git commit -m "feat(cf-detail): cfResources 純層——六 dataset 維度查詢建構＋解析分組（KV 正規化合併/短id 退化）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: on-demand 抓取層（5 分鐘快取＋label 解析）

**Files:**
- Modify: `src/services/cfResources.ts`（追加 fetch 區塊）
- Modify: `tests/cfResources.test.ts`（追加 fetch describe）

- [ ] **Step 3.1: 失敗測試先行**（tests/cfResources.test.ts 追加——import 區補 `beforeEach`、`http/HttpResponse`、`network`、`DB/resetDb/seedCfAccount/seedResourceName/cfD1ListUrl/cfKvListUrl`、`getResourceDetailByLabel/resetResourceCaches`）

```ts
// ---- fetch layer (Task 3) ----

import { beforeEach } from 'vitest'; // 併入既有 import
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { DB, resetDb, seedCfAccount, seedResourceName, cfD1ListUrl, cfKvListUrl } from './utils'; // 併入
import { getResourceDetailByLabel, resetResourceCaches } from '../src/services/cfResources'; // 併入

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
    // rename the account — label cache misses, detail cache hits
    await DB.prepare("UPDATE cf_accounts SET label = 'Renamed' WHERE account_id = ?").bind(TEST_CF.accountId).run();
    // label cache still holds 'Test Account' → account row (5 min) → detail cache hit:
    const detail = await getResourceDetailByLabel(DB, 'Test Account', CF_TEST_NOW + 60_000);
    expect(detail?.label).toBe('Test Account');
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
```

- [ ] **Step 3.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/cfResources.test.ts`
Expected: FAIL——`getResourceDetailByLabel` / `resetResourceCaches` 未匯出。

- [ ] **Step 3.3: 實作 fetch 區塊**（cfResources.ts 檔頭 import 區補 `import { D1Database } from '@cloudflare/workers-types';` + `import type { CfAccount } from './cfUsage';`——**type-only，runtime 無環**；檔尾追加）

```ts
// ===== on-demand fetch + per-isolate caches =====

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** Per-isolate detail cache TTL — the load-bearing rate limiter (≤288
 *  upstream calls/account/day no matter what). */
export const CACHE_TTL_MS = 300_000;

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
```

- [ ] **Step 3.4: 跑測試確認通過**

Run: `npm run test:app -- tests/cfResources.test.ts` — Expected: PASS（純層 6 ＋fetch 7 案）。

- [ ] **Step 3.5: Commit**

```bash
git add src/services/cfResources.ts tests/cfResources.test.ts
git commit -m "feat(cf-detail): on-demand 明細抓取層——5 分鐘 per-isolate 雙快取＋label 解析＋同款錯誤映射

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 名稱每日刷新（REST list）＋poller 掛鉤

**Files:**
- Modify: `src/services/cfResources.ts`（追加 refresh 區塊）
- Modify: `src/services/cfUsage.ts`（pollCfUsage 尾端掛鉤＋import）
- Modify: `tests/cfUsage.test.ts`（beforeEach 4 個 REST 預設 handler＋新 describe）

- [ ] **Step 4.1: 失敗測試先行**（tests/cfUsage.test.ts——import 區補 `cfD1ListUrl, cfKvListUrl, seedResourceName` from './utils'）

beforeEach 的 `network.use(...)` 既有三個 handler 前**加入**四個 REST 預設 handler（空結果——既有輪詢測試種的每個帳號都會被掛鉤碰到 REST，未攔截會打真網路）：

```ts
  const REST_EMPTY = { success: true, result: [] };
  network.use(
    http.get(cfD1ListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
    http.get(cfKvListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
    http.get(cfD1ListUrl(TEST_CF.accountIdB), () => HttpResponse.json(REST_EMPTY)),
    http.get(cfKvListUrl(TEST_CF.accountIdB), () => HttpResponse.json(REST_EMPTY)),
    // ...既有三個 handler 原封接續...
```

檔尾新 describe：

```ts
describe('resource name refresh (poller hook)', () => {
  it('refreshes d1 names once per day: poll → rows written → second poll no re-fetch', async () => {
    await seedCfAccount();
    let d1Hits = 0;
    network.use(
      http.get(cfD1ListUrl(TEST_CF.accountId), () => {
        d1Hits++;
        return HttpResponse.json({
          success: true,
          result: [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'Production DB' }],
        });
      })
    );
    await pollCfUsage(DB, CF_TEST_NOW);
    expect(d1Hits).toBe(1);
    const rows = await DB.prepare(
      "SELECT resource_id, name FROM cf_resource_names WHERE account_id = ? AND resource_type = 'd1'"
    ).bind(TEST_CF.accountId).all<{ resource_id: string; name: string }>();
    expect(rows.results).toEqual([{ resource_id: '11111111-2222-3333-4444-555555555555', name: 'Production DB' }]);
    await pollCfUsage(DB, CF_TEST_NOW + 60_000);
    expect(d1Hits).toBe(1); // gate satisfied — no re-fetch within the day
  });

  it('replace-set: a resource absent from the list is deleted (static DELETE, §B-safe)', async () => {
    await seedCfAccount();
    // stale row older than the refresh gate (CF_TEST_NOW-anchored)
    await seedResourceName(TEST_CF.accountId, 'd1', 'old-uuid', 'Old DB', Math.floor(CF_TEST_NOW / 1000) - 2 * 86_400);
    network.use(
      http.get(cfD1ListUrl(TEST_CF.accountId), () =>
        HttpResponse.json({ success: true, result: [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'Production DB' }] })
      )
    );
    await pollCfUsage(DB, CF_TEST_NOW);
    const rows = await DB.prepare(
      "SELECT resource_id FROM cf_resource_names WHERE account_id = ? AND resource_type = 'd1'"
    ).bind(TEST_CF.accountId).all<{ resource_id: string }>();
    expect(rows.results.map((r) => r.resource_id)).toEqual(['11111111-2222-3333-4444-555555555555']);
  });

  it('kv names are stored with normalized bare-hex ids', async () => {
    await seedCfAccount();
    network.use(
      http.get(cfKvListUrl(TEST_CF.accountId), () =>
        HttpResponse.json({ success: true, result: [{ id: 'ABCDEF01-2345-6789-abcd-ef0123456789', title: 'site-cache' }] })
      )
    );
    await pollCfUsage(DB, CF_TEST_NOW);
    const rows = await DB.prepare(
      "SELECT resource_id FROM cf_resource_names WHERE account_id = ? AND resource_type = 'kv'"
    ).bind(TEST_CF.accountId).all<{ resource_id: string }>();
    expect(rows.results.map((r) => r.resource_id)).toEqual(['abcdef0123456789abcdef0123456789']);
  });

  it('a 403 on one REST list degrades alone: poll summary unaffected, no failure entry', async () => {
    await seedCfAccount();
    network.use(http.get(cfD1ListUrl(TEST_CF.accountId), () => new HttpResponse(null, { status: 403 })));
    const summary = await pollCfUsage(DB, CF_TEST_NOW);
    expect(summary.polled).toBe(1);
    expect(summary.failures).toHaveLength(0); // usage poll itself succeeded
  });

  it('skips refresh entirely while the daily gate holds (no REST traffic)', async () => {
    await seedCfAccount();
    // fresh row written "now-anchored at CF_TEST_NOW" → gate satisfied for both types
    await seedResourceName(TEST_CF.accountId, 'd1', 'x', 'x', Math.floor(CF_TEST_NOW / 1000));
    await seedResourceName(TEST_CF.accountId, 'kv', 'y', 'y', Math.floor(CF_TEST_NOW / 1000));
    let restHits = 0;
    network.use(
      http.get(cfD1ListUrl(TEST_CF.accountId), () => { restHits++; return HttpResponse.json({ success: true, result: [] }); }),
      http.get(cfKvListUrl(TEST_CF.accountId), () => { restHits++; return HttpResponse.json({ success: true, result: [] }); })
    );
    await pollCfUsage(DB, CF_TEST_NOW + 60_000);
    expect(restHits).toBe(0);
  });
});
```

- [ ] **Step 4.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/cfUsage.test.ts`
Expected: 新 describe FAIL（表無列被寫入／REST 未被攔截的行為不存在）；既有測試可能因 REST 未攔截而 FAIL——兩者皆由 Step 4.3 修復。

- [ ] **Step 4.3: 實作**——cfResources.ts 追加 refresh 區塊（`NAME_REFRESH_INTERVAL_SEC` 常數放檔頭常數區）：

```ts
/** Name refresh gate: per (account, resource_type) at most daily. */
export const NAME_REFRESH_INTERVAL_SEC = 86_400;
```

檔尾追加：

```ts
// ===== daily name refresh (REST lists → cf_resource_names) =====

/** Verified 2026-09-11 with the existing Analytics-scoped tokens on both
 *  probed accounts — no re-mint needed. A 403 here only means unresolved
 *  names degrade to short ids, never a poll failure. */
const CF_REST_BASE = 'https://api.cloudflare.com/client/v4';

interface RestListEnvelope {
  success?: boolean;
  result?: Array<Record<string, unknown>> | null;
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
    throw new Error('unexpected REST list envelope');
  }
  return body.result;
}

async function fetchD1Names(account: CfAccount): Promise<Array<{ id: string; name: string }>> {
  const result = await fetchRestList(account, `/accounts/${account.account_id}/d1/database?per_page=100`);
  return result
    .map((r) => ({ id: String(r.uuid ?? ''), name: String(r.name ?? '') }))
    .filter((r) => r.id !== '' && r.name !== '');
}

async function fetchKvNames(account: CfAccount): Promise<Array<{ id: string; name: string }>> {
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
```

cfUsage.ts：import 區加 `import { refreshResourceNamesIfNeeded } from './cfResources';`（runtime import；反向 cfResources→cfUsage 為 type-only——無 runtime 環）。`pollCfUsage` 的 allSettled 迴圈之後、self-warning 之前插入：

```ts
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
```

- [ ] **Step 4.4: 跑測試確認通過**

Run: `npm run test:app -- tests/cfUsage.test.ts tests/cfResources.test.ts` — Expected: PASS（含既有 33 案——REST 預設 handler 吸收掛鉤流量）。

- [ ] **Step 4.5: Commit**

```bash
git add src/services/cfResources.ts src/services/cfUsage.ts tests/cfUsage.test.ts
git commit -m "feat(cf-detail): 名稱每日刷新（REST list → replace-set 靜態刪除）掛 30 分鐘 poller——失敗只降級不影響輪詢

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: getTodayCfUsage 抽入 service（純重構＋排序推導）

**Files:**
- Modify: `src/services/cfUsage.ts`（型別搬入＋getTodayCfUsage）
- Modify: `src/routes/dashboard.ts`（刪 groupCfUsage＋SQL，改呼叫）
- Modify: `src/views/dashboard.ts`（型別改 import 自 service，不再定義/匯出）

本 task **渲染零變動**（既有 dashboard 測試必須原封全綠）——排序發生在資料層但卡 rendering 順序自然跟著 `data.accounts` 走，畫面順序改變由 Task 7 的測試鎖定。

- [ ] **Step 5.1: 實作**（先做純重構——無新測試，靠既有 7 案鎖行為）

cfUsage.ts：`WARN_THRESHOLD` 已在（60%）。檔尾（pollCfUsage 之前或之後皆可——放 classifyMetric 區塊後、Alert payloads 前）加入：

```ts
// ===== Homepage CF pane data (moved from routes/dashboard.ts 2026-09-12;
// second caller = the usage API — grouping/derivation lives in one place) =====

/** One metric line of the homepage CF pane (cf_usage_state columns minus the
 *  account identity — account_id is intentionally absent end to end). */
export interface CfMetricRowData {
  metric: string;
  value: number;
  projected_eod: number | null;
  alerted_level: number;
}

/** Per-account card: label + plan + today's metric rows, plus the collapsed
 *  face derivations. */
export interface CfAccountCardData {
  label: string;
  plan: CfPlanId;
  last_ok_at: number;
  metrics: CfMetricRowData[];
  /** Metric row with the highest value/quota ratio (quota-less rows rank 0);
   *  undefined when no metric has a quota (or metrics is empty) — the view
   *  falls back to the first row. */
  topMetric?: CfMetricRowData;
  /** Highest ratio across the account's metrics (0 when none have quotas). */
  maxRatio: number;
  /** Metrics at or above WARN_THRESHOLD (the amber chip count). */
  warnCount: number;
}

/** Everything the CF pane renders — accounts sorted by maxRatio desc
 *  (label asc tiebreak). */
export interface CfUsageData {
  accounts: CfAccountCardData[];
  lastPolledAt: number;
}

/** Flat JOIN row. The SELECT list omits account_id on purpose — the homepage
 *  must never render it (see tests/dashboard.test.ts). */
export interface CfUsageRow {
  metric: string;
  value: number;
  projected_eod: number | null;
  alerted_level: number;
  updated_at: number;
  label: string;
  plan: CfPlanId;
  last_ok_at: number;
}

/** Today's per-account usage: query, group flat rows into cards, derive the
 *  collapsed-face fields (topMetric/maxRatio/warnCount), sort by maxRatio
 *  desc (label asc). account_id never selected — public surface. */
export async function getTodayCfUsage(db: D1Database): Promise<CfUsageData> {
  const usage = await db
    .prepare(
      `SELECT s.metric, s.value, s.projected_eod, s.alerted_level, s.updated_at,
              a.label, a.plan, a.last_ok_at
       FROM cf_usage_state s JOIN cf_accounts a ON a.account_id = s.account_id
       WHERE s.day_utc = date('now') AND a.enabled = 1
       ORDER BY a.label, s.metric`
    )
    .all<CfUsageRow>();

  const order = Object.keys(METRICS);
  const accounts: CfAccountCardData[] = [];
  for (const row of usage.results) {
    let card = accounts[accounts.length - 1];
    if (!card || card.label !== row.label) {
      card = { label: row.label, plan: row.plan, last_ok_at: row.last_ok_at, metrics: [], maxRatio: 0, warnCount: 0 };
      accounts.push(card);
    }
    card.metrics.push({
      metric: row.metric,
      value: row.value,
      projected_eod: row.projected_eod,
      alerted_level: row.alerted_level,
    });
  }
  for (const card of accounts) {
    card.metrics.sort((a, b) => order.indexOf(a.metric) - order.indexOf(b.metric));
    for (const row of card.metrics) {
      const quota = quotaFor(row.metric, card.plan);
      if (quota <= 0) continue;
      const ratio = row.value / quota;
      if (ratio >= WARN_THRESHOLD) card.warnCount++;
      if (ratio > card.maxRatio) {
        card.maxRatio = ratio;
        card.topMetric = row;
      }
    }
  }
  accounts.sort((a, b) => b.maxRatio - a.maxRatio || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return {
    accounts,
    lastPolledAt: accounts.reduce((max, a) => Math.max(max, a.last_ok_at), 0),
  };
}
```

routes/dashboard.ts：刪除 `groupCfUsage` 函式與 `CfUsageRow` 等 type import；import 區改：

```ts
import { getTodayCfUsage } from '../services/cfUsage';
import {
  CfUsagePane,
  DashboardContent,
  ErrorState,
  ProjectGrid,
} from '../views/dashboard';
```

（`METRICS` import 與 `CfAccountCardData/CfUsageData/CfUsageRow` type import 自 view 移除。）GET `/` 的 CF try 區塊改：

```ts
  let cfPane: ReturnType<typeof CfUsagePane>;
  try {
    cfPane = CfUsagePane(await getTodayCfUsage(db));
  } catch (error) {
    console.error('CF usage pane error:', error);
    cfPane = ErrorState('Error loading CF usage', 'Unable to fetch CF usage data. Please try again.');
  }
```

（註解保留——安全不變式註解隨 SQL 搬進 service。）

views/dashboard.ts：刪除四個 interface 定義（CfMetricRowData/CfAccountCardData/CfUsageData/CfUsageRow），import 區改：

```ts
import { METRICS, quotaFor } from '../services/cfUsage';
import type { CfAccountCardData, CfMetricRowData, CfPlanId, CfUsageData } from '../services/cfUsage';
```

- [ ] **Step 5.2: 跑測試＋typecheck 確認零行為變動**

Run: `./node_modules/.bin/tsc --noEmit && npm run test:app -- tests/dashboard.test.ts`
Expected: tsc 0 error；dashboard 7 案 PASS 原封。

- [ ] **Step 5.3: Commit**

```bash
git add src/services/cfUsage.ts src/routes/dashboard.ts src/views/dashboard.ts
git commit -m "refactor(cf-usage): getTodayCfUsage 抽入 service——topMetric/maxRatio/warnCount 推導＋maxRatio 降序（API 共用前奏）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: 明細 fragment 視圖＋route＋CSS

**Files:**
- Create: `src/views/cfDetail.ts`
- Modify: `src/routes/dashboard.ts`（新端點）
- Modify: `src/views/layout.ts`（CSS 兩處）
- Modify: `tests/dashboard.test.ts`（新 describe）

- [ ] **Step 6.1: 失敗測試先行**（tests/dashboard.test.ts——import 區補 `http, HttpResponse` from 'msw'、`network` from './network'、`resetResourceCaches` from '../src/services/cfResources'、`seedResourceName, cfD1ListUrl, cfKvListUrl` from './utils'；檔尾新 describe）

```ts
// ---- resource detail fragment (Task 6) ----

const detailFixture = () => ({
  data: {
    viewer: {
      accounts: [
        {
          wkr: [
            { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 1000, errors: 2 } },
            { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 500, errors: 0 } },
          ],
          pgs: [{ dimensions: { scriptName: 'pages-worker--13581012-production' }, sum: { requests: 300 } }],
          d1: [
            { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 4_000_000, rowsWritten: 10_000 } },
            { dimensions: { databaseId: '99999999-8888-7777-6666-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } },
          ],
          kvo: [{ dimensions: { namespaceId: 'abcdef0123456789abcdef0123456789' }, sum: { requests: 42 } }],
          kvs: [{ dimensions: { namespaceId: 'ABCDEF01-2345-6789-ABCD-EF0123456789' }, max: { byteCount: 1024, keyCount: 7 } }],
          r2s: [{ dimensions: { bucketName: 'media-bucket' }, max: { payloadSize: 2_000_000_000, objectCount: 120 } }],
        },
      ],
    },
  },
});
const REST_EMPTY = { success: true, result: [] };

describe('GET /cf-usage/detail — resource detail fragment', () => {
  beforeEach(async () => {
    await resetDb();
    resetResourceCaches();
    network.use(
      http.post(TEST_CF.gqlUrl, () => HttpResponse.json(detailFixture())),
      http.get(cfD1ListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
      http.get(cfKvListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY))
    );
  });

  it('renders named groups per resource type with resolved names and usage', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedResourceName(TEST_CF.accountId, 'd1', '11111111-2222-3333-4444-555555555555', 'Production DB');
    await seedResourceName(TEST_CF.accountId, 'kv', 'abcdef0123456789abcdef0123456789', 'site-cache');

    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const title of ['Workers', 'Pages', 'D1 Databases', 'KV Namespaces', 'R2 Buckets']) {
      expect(html).toContain(title);
    }
    // workers: dimension value is the name; adaptive rows accumulated
    expect(html).toContain('watch-dog');
    expect(html).toContain('1,500');
    // pages: CF internal deployment name shown as-is (documented trade-off)
    expect(html).toContain('pages-worker--13581012-production');
    // resolved names win
    expect(html).toContain('Production DB');
    expect(html).toContain('site-cache');
    // r2 bucket name
    expect(html).toContain('media-bucket');
  });

  it('merges KV ops + storage into one row (single site-cache occurrence, KiB formatting)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedResourceName(TEST_CF.accountId, 'kv', 'abcdef0123456789abcdef0123456789', 'site-cache');
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    const html = await res.text();
    expect((html.match(/site-cache/g) ?? []).length).toBe(1);
    expect(html).toContain('KiB'); // 1024 bytes → human-readable
    expect(html).toContain('42');  // kv_ops
  });

  it('NEVER leaks 32-hex ids (unresolved resources degrade to 8-char short ids)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    const html = await res.text();
    expect(html).toContain('99999999…'); // unresolved d1 → short id
    expect(html).toContain('abcdef01…'); // unresolved kv → short id
    expect(html).not.toContain(TEST_CF.accountId);
    expect(html.match(/[0-9a-f]{32}/)).toBeNull();
  });

  it('returns 200 + a friendly panel for an unknown label (htmx never swaps non-2xx)', async () => {
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=ghost');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('找不到啟用中的帳號');
  });

  it('returns 200 + an error panel when the upstream fetch fails (degrades alone)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    network.use(http.post(TEST_CF.gqlUrl, () => new HttpResponse(null, { status: 500 })));
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('資源明細載入失敗');
    expect(html).toContain('HTTP 500');
  });
});
```

- [ ] **Step 6.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/dashboard.test.ts`
Expected: 新 5 案 FAIL（route 404——Hono 無此路徑）；既有 7 案 PASS。

- [ ] **Step 6.3: 實作**——src/views/cfDetail.ts（新建）：

```ts
// src/views/cfDetail.ts
// Server-rendered fragment for the homepage card's expand area (htmx,
// toggle-triggered) — per-resource usage tables. Public like the CF pane:
// labels, names and numbers only, never any id (ResourceItem.id is internal;
// unresolved resources arrive here already degraded to short-id names).

import { html } from 'hono/html';
import type { ResourceDetail, ResourceGroup, ResourceGroupType } from '../services/cfResources';
import { fmtMetricValue } from '../lib/format';

const GROUP_COLUMNS: Record<ResourceGroupType, string[]> = {
  workers: ['workers_requests', 'workers_errors'],
  pages: ['pages_requests'],
  d1: ['d1_rows_read', 'd1_rows_written'],
  kv: ['kv_ops', 'kv_storage_bytes', 'kv_storage_keys'],
  r2: ['r2_storage_bytes', 'r2_objects'],
};

const COLUMN_LABELS: Record<string, string> = {
  workers_requests: '請求',
  workers_errors: '錯誤',
  pages_requests: '請求',
  d1_rows_read: 'Rows 讀',
  d1_rows_written: 'Rows 寫',
  kv_ops: '操作',
  kv_storage_bytes: '儲存量',
  kv_storage_keys: 'Keys',
  r2_storage_bytes: '儲存量',
  r2_objects: '物件數',
};

const taipeiTime = (unixSec: number): string =>
  new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSec * 1000));

const GroupTable = (group: ResourceGroup) => html`
<div class="cf-res-group">
  <h4 class="cf-res-title">${group.title}</h4>
  <table class="cf-res-table">
    <thead>
      <tr>
        <th>資源</th>
        ${GROUP_COLUMNS[group.type].map((m) => html`<th>${COLUMN_LABELS[m] ?? m}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${group.items.map(
        (item) => html`
        <tr>
          <td class="cf-res-name">${item.name}</td>
          ${GROUP_COLUMNS[group.type].map((m) => html`<td>${fmtMetricValue(m, item.metrics[m] ?? 0)}</td>`)}
        </tr>
        `
      )}
    </tbody>
  </table>
</div>`;

/** The expand-area fragment: one table per resource group. */
export const CfResourceDetailFragment = (detail: ResourceDetail) => html`
<div class="cf-detail">
  <p class="cf-detail-meta">逐資源明細（今日 UTC 起）· 查詢時間 ${taipeiTime(detail.fetchedAt)}</p>
  ${detail.groups.map((g) => GroupTable(g))}
  ${detail.groups.length === 0 ? html`<p class="cf-detail-meta">今日無任何資源用量。</p>` : ''}
</div>`;

/** 200-status error panel — htmx does not swap non-2xx responses, so the
 *  fragment route ALWAYS answers 200 and degrades visually (design §安全
 *  不變式 5). */
export const CfDetailError = (message: string) => html`
<div class="cf-detail cf-detail-error">
  <p>資源明細載入失敗：${message}</p>
  <p class="cf-detail-meta">稍後再收合重新展開即可重試（成功後 5 分鐘快取生效）。</p>
</div>`;
```

routes/dashboard.ts：import 區補 `getResourceDetailByLabel` from '../services/cfResources'、`CfDetailError, CfResourceDetailFragment` from '../views/cfDetail'；`GET /` 之前加：

```ts
/**
 * GET /cf-usage/detail?label=…
 * Public HTML fragment for the card expand area (htmx toggle-triggered).
 * Always 200 — errors become an inline panel because htmx never swaps
 * non-2xx responses (a 500 would strand the placeholder text forever).
 * Label-gated and id-free by construction (ResourceDetail has no id field).
 */
dashboard.get('/cf-usage/detail', async (c) => {
  const label = c.req.query('label') ?? '';
  if (!label) return c.html(CfDetailError('缺少 label 參數'));
  try {
    const detail = await getResourceDetailByLabel(c.env.DB, label);
    if (!detail) return c.html(CfDetailError(`找不到啟用中的帳號「${label}」`));
    return c.html(CfResourceDetailFragment(detail));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CF detail fragment error (${label}):`, error);
    return c.html(CfDetailError(message.slice(0, 200)));
  }
});
```

src/views/layout.ts——`.cf-proj-flag` 區塊後、`[x-cloak]` 前插入：

```css
    .cf-account-header-right {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .cf-warn-chip {
      display: inline-flex;
      align-items: center;
      padding: 0.1rem 0.55rem;
      background: rgba(243, 156, 18, 0.15);
      color: #f39c12;
      border-radius: 1rem;
      font-size: 0.7rem;
      white-space: nowrap;
    }
    .cf-expand {
      margin-top: 0.75rem;
      border-top: 1px solid #2e2e2e;
      padding-top: 0.5rem;
    }
    .cf-expand summary {
      cursor: pointer;
      font-size: 0.8rem;
      color: #3498db;
      user-select: none;
    }
    .cf-detail {
      margin-top: 0.5rem;
    }
    .cf-detail-meta {
      font-size: 0.75rem;
      color: #888;
      margin: 0.25rem 0 0.5rem;
    }
    .cf-detail-error {
      color: #e74c3c;
      font-size: 0.85rem;
    }
    .cf-res-group {
      margin-bottom: 0.9rem;
    }
    .cf-res-title {
      font-size: 0.8rem;
      color: #bbb;
      margin: 0 0 0.3rem;
    }
    .cf-res-table {
      width: 100%;
      font-size: 0.78rem;
      border-collapse: collapse;
    }
    .cf-res-table th,
    .cf-res-table td {
      padding: 0.25rem 0.4rem;
      text-align: right;
      border-bottom: 1px solid #2a2a2a;
      font-variant-numeric: tabular-nums;
    }
    .cf-res-table th {
      color: #888;
      font-weight: 500;
    }
    .cf-res-table th:first-child,
    .cf-res-table td:first-child {
      text-align: left;
    }
    .cf-res-name {
      max-width: 14rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
```

既有第一個 `@media (max-width: 639px)` 區塊（`.cf-grid` 單欄之後）加：

```css
      /* CF detail tables: narrower name column on phones */
      .cf-res-name {
        max-width: 10rem;
      }
```

- [ ] **Step 6.4: 跑測試確認通過**

Run: `npm run test:app -- tests/dashboard.test.ts` — Expected: PASS（既有 7＋新 5）。

- [ ] **Step 6.5: Commit**

```bash
git add src/views/cfDetail.ts src/routes/dashboard.ts src/views/layout.ts tests/dashboard.test.ts
git commit -m "feat(cf-detail): 明細 fragment 視圖＋GET /cf-usage/detail——200+錯誤面板語義（htmx 不 swap 非 2xx）、零 id 渲染

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: 帳號卡折疊面＋排序渲染＋展開暫停 reload

**Files:**
- Modify: `src/views/dashboard.ts`（CfAccountCard＋DashboardContent）
- Modify: `tests/dashboard.test.ts`（既有斷言更新＋新 3 案）

- [ ] **Step 7.1: 失敗測試先行**

既有第 3 案（threshold colors）的斷言更新——**topMetric（workers_requests 90% danger）同時渲染於折疊面與 details，其餘指標只在 details**：

```ts
    // face renders the top (danger) metric; details re-renders all three —
    // the danger line therefore appears TWICE, warn/plain once (details only)
    expect((html.match(/cf-bar-fill"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-warn"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-danger"/g) ?? []).length).toBe(2);
```

檔尾新 describe：

```ts
describe('homepage card sorting + collapsed face (Task 7)', () => {
  it('sorts cards by max quota ratio desc (High Use 90% before Low Use 20%)', async () => {
    await seedCfAccount({ label: 'Low Use' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000); // 20%
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'High Use' });
    await seedUsage(TEST_CF.accountIdB, 'd1_rows_written', 90_000); // 90%
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html.indexOf('High Use')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('High Use')).toBeLessThan(html.indexOf('Low Use'));
  });

  it('face shows the warn chip and the details/fragment wiring', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 65_000); // 65% → 1 項 ≥60%
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('1 項 ≥60%');
    expect(html).toContain('cf-warn-chip');
    expect(html).toContain('全部指標與資源明細');
    expect(html).toContain('hx-get="/cf-usage/detail?label=Test%20Account"');
    expect(html).toContain('hx-trigger="toggle from:closest details once"');
  });

  it('pauses the 30s auto-reload while a detail is open (hyperscript guard)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1);
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain(
      "if no document.querySelector('details.cf-expand[open]') then location.reload()"
    );
  });
});
```

- [ ] **Step 7.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/dashboard.test.ts`
Expected: 新 3 案 FAIL；threshold 案 FAIL（cf-danger" 現為 1）。

- [ ] **Step 7.3: 實作**——views/dashboard.ts：

CfAccountCard 整體替換為：

```ts
/** Account card: collapsed face = header + topMetric (the highest quota
 *  ratio line) + amber chip (N 項 ≥60%); native <details> expands to all
 *  metric lines + the htmx on-demand resource detail fragment. The face
 *  metric duplicates inside <details> on purpose — the face never moves,
 *  the details section is the complete registry view. */
const CfAccountCard = (card: CfAccountCardData) => html`
<div class="cf-account-card">
  <div class="cf-account-header">
    <h3>${card.label}</h3>
    <div class="cf-account-header-right">
      ${card.warnCount > 0 ? html`<span class="cf-warn-chip">${card.warnCount} 項 ≥60%</span>` : ''}
      <span class="cf-plan-badge">${card.plan}</span>
    </div>
  </div>
  ${CfMetricLine(card.topMetric ?? card.metrics[0], card.plan)}
  <details class="cf-expand">
    <summary>全部指標與資源明細</summary>
    ${card.metrics.map((row) => CfMetricLine(row, card.plan))}
    <div
      class="cf-detail"
      hx-get="/cf-usage/detail?label=${encodeURIComponent(card.label)}"
      hx-trigger="toggle from:closest details once"
      hx-swap="innerHTML"
    >
      展開後載入資源明細…
    </div>
  </details>
</div>
`;
```

（註：`toggle` 不氣泡——htmx `from:closest details` 直接在該 `<details>` 掛 listener，事件不必冒泡；`once` = 每次展開只抓一次，5 分鐘快取吸收重複展開。）

DashboardContent 的 status tab 輪詢 div 改（CF pane 的 reload 暫停語義——此 div 的 afterRequest 觸發整頁 reload）：

```ts
    <div
      id="dashboard"
      hx-get="/"
      hx-trigger="every 30s"
      hx-swap="none"
      _="on htmx:afterRequest if no document.querySelector('details.cf-expand[open]') then location.reload()"
    >
      ${projectGrid}
    </div>
```

（hyperscript `no` operator = 邏輯非；details 開啟時跳過 reload——讀明細不被打斷，收合後下個 tick 恢復。）

- [ ] **Step 7.4: 跑測試確認通過**

Run: `npm run test:app -- tests/dashboard.test.ts` — Expected: PASS（既有 7＋threshold 更新＋新 3 = 11 案）。逐一複核既有案：案 1 單指標 → face=該指標 ✓；案 5 無配額指標 → topMetric undefined → fallback metrics[0]、value-only 無 bar ✓；案 2/6 無新增 id 面 ✓。

- [ ] **Step 7.5: Commit**

```bash
git add src/views/dashboard.ts tests/dashboard.test.ts
git commit -m "feat(cf-usage): 帳號卡折疊面——最緊指標＋N 項 ≥60% chip＋details 展開 htmx 明細；展開時暫停 30s 自動 reload

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: 對外 API＋secret 三方鏈

**Files:**
- Modify: `src/routes/api.ts`（新端點）
- Modify: `src/types.ts`、`src/lib/bindings.ts`、`wrangler.jsonc`、`.portability.toml`、`vitest.config.ts`、`.dev.vars.example`（六檔同步）
- Modify: `tests/api.test.ts`（新 describe）

- [ ] **Step 8.1: 失敗測試先行**（tests/api.test.ts——import 區補 `http, HttpResponse` from 'msw'、`network` from './network'、`resetResourceCaches` from '../src/services/cfResources'、`seedCfAccount, seedResourceName, TEST_CF, TEST_USAGE_API_TOKEN, cfD1ListUrl, cfKvListUrl` from './utils'；檔尾新 describe）

```ts
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
  detail?: { groups: Array<{ type: string; items: Array<{ name: string; metrics: Record<string, number> }> }> } | null;
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

  it('returns per-account metrics with quota/pct and sorts by max ratio desc', async () => {
    await seedCfAccount({ label: 'Low Use' });
    await seedUsageRow(TEST_CF.accountId, 'd1_rows_read', 1_000_000); // 20%
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
                      d1: [{ dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } }],
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
    const bad = body.accounts.find((a) => a.label === 'Bad');
    expect(bad?.detail_error).toContain('HTTP 500');
    expect(bad?.detail).toBeNull();
    // security: no 32-hex run anywhere in the serialized response (resource
    // ids are stripped at the API boundary — names only)
    expect(JSON.stringify(body).match(/[0-9a-f]{32}/)).toBeNull();
  });
});
```

- [ ] **Step 8.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/api.test.ts`
Expected: 新 5 案 FAIL（404——route 不存在）。

- [ ] **Step 8.3: 實作 API route**——src/routes/api.ts import 區補：

```ts
import { getTodayCfUsage, METRICS, quotaFor } from '../services/cfUsage';
import type { CfUsageData } from '../services/cfUsage';
import { getResourceDetailByLabel } from '../services/cfResources';
import type { ResourceDetail, ResourceGroupType } from '../services/cfResources';
```

（`timingSafeEqual`/`extractProjectToken` 既有 import 沿用。）檔尾（maintenance 端點後）加：

```ts
// ============================================================================
// GET /api/cf-usage — read-only usage feed for cross-project consumers
// (other repos' Claude Code / automation; see README). Static Bearer token
// (CF_USAGE_API_TOKEN), fail-closed constant-time compare. The response
// NEVER carries account ids, api tokens, or any resource ids — labels and
// names only (same source-level cutoff as the homepage pane).
// ============================================================================

interface ApiUsageMetric {
  metric: string;
  label: string;
  value: number;
  quota: number | null;
  pct: number | null;
  projected_eod: number | null;
}

/** Detail groups with resource ids stripped — ids (esp. KV namespace ids,
 *  32 bare hex) must never reach the response; names suffice. */
interface ApiResourceGroup {
  type: ResourceGroupType;
  title: string;
  items: Array<{ name: string; metrics: Record<string, number> }>;
}
interface ApiResourceDetail {
  label: string;
  fetchedAt: number;
  groups: ApiResourceGroup[];
}
interface ApiUsageAccount {
  label: string;
  plan: string;
  last_polled_at: number;
  metrics: ApiUsageMetric[];
  /** Present only when detail=1 — null when the label stopped resolving
   *  between calls (disabled account mid-request). */
  detail?: ApiResourceDetail | null;
  /** Present only when detail=1 AND this account's detail fetch failed —
   *  one account's failure never fails the whole response. */
  detail_error?: string;
}

const toApiDetail = (detail: ResourceDetail): ApiResourceDetail => ({
  label: detail.label,
  fetchedAt: detail.fetchedAt,
  groups: detail.groups.map((g) => ({
    type: g.type,
    title: g.title,
    items: g.items.map((item) => ({ name: item.name, metrics: item.metrics })),
  })),
});

api.get('/api/cf-usage', async (c) => {
  // Fail-closed: unset secret, missing header, or mismatch → 401. An unset
  // secret must NEVER open the endpoint (timingSafeEqual on '' is false but
  // the !expected guard makes the intent explicit and unconditional).
  const expected = c.env.CF_USAGE_API_TOKEN ?? '';
  const token = extractProjectToken(c) ?? '';
  if (!expected || !token || !timingSafeEqual(expected, token)) {
    return c.json({ error: 'Unauthorized: valid Bearer token required (see README CF 用量 API)' }, 401);
  }

  let usage: CfUsageData;
  try {
    usage = await getTodayCfUsage(c.env.DB);
  } catch (error) {
    console.error('cf-usage API error:', error);
    return c.json({ error: 'Failed to load usage data' }, 500);
  }

  const labelFilter = c.req.query('account');
  if (labelFilter) {
    const filtered = usage.accounts.filter((a) => a.label === labelFilter);
    if (filtered.length === 0) {
      return c.json({ error: `Unknown account label: ${labelFilter}` }, 404);
    }
    usage = { ...usage, accounts: filtered };
  }

  const wantDetail = c.req.query('detail') === '1';
  const accounts: ApiUsageAccount[] = [];
  for (const card of usage.accounts) {
    const metrics: ApiUsageMetric[] = card.metrics.map((row) => {
      const quota = quotaFor(row.metric, card.plan);
      return {
        metric: row.metric,
        label: METRICS[row.metric]?.label ?? row.metric,
        value: row.value,
        quota: quota > 0 ? quota : null,
        pct: quota > 0 ? Math.round((row.value / quota) * 1000) / 10 : null,
        projected_eod: row.projected_eod,
      };
    });
    const entry: ApiUsageAccount = {
      label: card.label,
      plan: card.plan,
      last_polled_at: card.last_ok_at,
      metrics,
    };
    if (wantDetail) {
      entry.detail = null;
      try {
        const detail = await getResourceDetailByLabel(c.env.DB, card.label);
        entry.detail = detail ? toApiDetail(detail) : null;
      } catch (error) {
        entry.detail_error = error instanceof Error ? error.message : String(error);
      }
    }
    accounts.push(entry);
  }

  return c.json({
    generated_at: Math.floor(Date.now() / 1000),
    quota_reset: 'UTC 00:00 (Taipei 08:00)',
    accounts,
  });
});
```

- [ ] **Step 8.4: secret 六檔同步**（§F/§G/§H guard 三方＋型別＋測試 bindings＋文件檔；§J：`CF_USAGE_API_TOKEN` = 合法 `{VENDOR}_{ROLE}_{TYPE}`——無需 legacy allowlist）

`src/types.ts` AppBindings 內加（ADMIN_PASSWORD 之後）：

```ts
  /**
   * Static Bearer token guarding GET /api/cf-usage (read-only usage feed
   * for other projects). Set via `wrangler secret put CF_USAGE_API_TOKEN`
   * (file-sourced); value lives in ~/.config/watch-dog/usage-api-token
   * (operator machine) and .dev.vars (sealed) — see SECRETS.md.
   */
  CF_USAGE_API_TOKEN?: string;
```

`src/lib/bindings.ts`：

```ts
export const REQUIRED_BINDING_KEYS = ['ADMIN_ACCOUNT', 'ADMIN_PASSWORD', 'CF_USAGE_API_TOKEN'] as const;
```

`wrangler.jsonc` secrets.required：

```jsonc
	"secrets": {
		"required": ["ADMIN_ACCOUNT", "ADMIN_PASSWORD", "CF_USAGE_API_TOKEN"]
	}
```

`.portability.toml`：`worker = ["ADMIN_ACCOUNT", "ADMIN_PASSWORD", "CF_USAGE_API_TOKEN"]`＋meta 區塊（ADMIN_PASSWORD meta 後）：

```toml
[[secrets.meta]]
name = "CF_USAGE_API_TOKEN"
env = "all"
authority = "B"
provenance = "openssl rand -hex 32（值經 ~/.config/watch-dog/usage-api-token 本機檔散佈，agent 不經手明文）"
shared_across = []
last_rotated = "2026-09-12（首次設定）"
owner = "@peter"
```

`vitest.config.ts` bindings：

```ts
        bindings: { ADMIN_ACCOUNT: 'test-admin', ADMIN_PASSWORD: 'test-admin-token', CF_USAGE_API_TOKEN: 'test-usage-api-token' },
```

`.dev.vars.example`（ADMIN 區塊後）：

```
# Static Bearer token for GET /api/cf-usage (read-only usage API).
# Generate: openssl rand -hex 32 — prod value is file-sourced via
# `wrangler secret put CF_USAGE_API_TOKEN < ~/.config/watch-dog/usage-api-token`.
CF_USAGE_API_TOKEN=change-me-local-usage-api-token
```

- [ ] **Step 8.5: 跑測試＋guards 確認**

Run: `./node_modules/.bin/tsc --noEmit && npm run test:app -- tests/api.test.ts && npm run test:guards`
Expected: tsc 0 error；api 新 5 案 PASS；guards 21/21（§F/§G/§H 三方同步過）。

- [ ] **Step 8.6: Commit**

```bash
git add src/routes/api.ts src/types.ts src/lib/bindings.ts wrangler.jsonc .portability.toml vitest.config.ts .dev.vars.example tests/api.test.ts
git commit -m "feat(api): GET /api/cf-usage 對外唯讀用量 API——Bearer CF_USAGE_API_TOKEN fail-closed＋detail=1 逐資源（id 剝除）＋secret 三方鏈同步

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: 文件同步（D35/D36）

**Files:**
- Modify: `README.md`、`docs/api.md`、`docs/usage.md`、`secrets-archive/SECRETS.md`

- [ ] **Step 9.1: README.md**——`## API Endpoints` 段（~line 153）內加 CF 用量 API 小節：

````markdown
### CF 用量 API（供其它專案的 Claude Code／自動化使用）

watch-dog 對外提供**唯讀** CF 用量查詢 API，讓其它專案（或其 Claude Code）取得全部監控帳號的配額用量做後續分析與優化。

**認證**：`Authorization: Bearer <CF_USAGE_API_TOKEN>`（靜態 token、read-only）。Token 值存於操作者本機 `~/.config/watch-dog/usage-api-token`（repo 外，chmod 600）——向操作者索取該檔內容即可；token 值 [NEVER] 寫進任何 committed 檔。

```bash
TOKEN=$(cat ~/.config/watch-dog/usage-api-token)
BASE="https://watch-dog.helperp.workers.dev"

# 全部帳號今日用量（9 指標/帳號：值/配額/百分比/收盤預估）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/cf-usage"

# 單一帳號＋逐資源明細（Workers/Pages 專案名、D1/KV/R2 各資源名稱與用量）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/cf-usage?account=helperp&detail=1"
```

| 參數 | 說明 |
|------|------|
| `account` | 選填。依 label 過濾單一帳號（未知 label → 404） |
| `detail` | 選填。`1` = 附逐資源明細（每帳號即時查詢 GraphQL，per-isolate 5 分鐘快取） |

回應：`generated_at`、`quota_reset`（UTC 00:00＝台北 08:00）、`accounts[]`（`label`/`plan`/`last_polled_at`/`metrics[]`：`metric`/`label`/`value`/`quota`/`pct`/`projected_eod`）。`detail=1` 時另帶 `detail.groups[]`（workers/pages/d1/kv/r2 逐資源 `name`＋`metrics`；查詢失敗 → `detail_error`，僅降級該帳號）。**回應永不包含 32-hex account id、資源 id 或任何 token 值**（label／名稱／數字而已）。

**給目標專案 CLAUDE.md 的指示塊**（直接貼上）：

> 要查本專案所在 CF 帳號的配額用量（watch-dog 集中監控）：
> ```bash
> curl -s -H "Authorization: Bearer $(cat ~/.config/watch-dog/usage-api-token)" \
>   "https://watch-dog.helperp.workers.dev/api/cf-usage?account=<LABEL>&detail=1"
> ```
> `<LABEL>` 問操作者（或不帶 `account` 列出全部帳號）。判讀：`metrics[].pct` = 今日已用配額 %（≥60 警戒、≥80 危險）；`projected_eod` = 燃燒速率收盤預估（> `quota` 即將超額）。分析步驟：找 pct 最高與 `projected_eod` 超額的指標 → 對照 `detail.groups` 同型別資源找消耗大戶 → 提出優化建議。
````

- [ ] **Step 9.2: docs/api.md**——`## Error Responses`（line 236）之前加：

````markdown
### GET /api/cf-usage

Read-only CF quota usage feed for cross-project automation (other repos' Claude Code). Requires the static usage token — **not** a project token.

**Request:**
```http
GET /api/cf-usage?account=helperp&detail=1
Authorization: Bearer <CF_USAGE_API_TOKEN>
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| account | string | Optional. Filter to one account by label (unknown label → 404) |
| detail | string | Optional. `1` = include per-resource detail (live GraphQL query, 5-min per-isolate cache) |

**Response:**
```json
{
  "generated_at": 1738464000,
  "quota_reset": "UTC 00:00 (Taipei 08:00)",
  "accounts": [
    {
      "label": "helperp",
      "plan": "free",
      "last_polled_at": 1738463000,
      "metrics": [
        { "metric": "d1_rows_read", "label": "D1 rows 讀取", "value": 1000000, "quota": 5000000, "pct": 20, "projected_eod": null }
      ],
      "detail": {
        "label": "helperp",
        "fetchedAt": 1738464000,
        "groups": [
          { "type": "d1", "title": "D1 Databases", "items": [ { "name": "watch-dog-db", "metrics": { "d1_rows_read": 900000, "d1_rows_written": 5000 } } ] }
        ]
      }
    }
  ]
}
```

`quota`/`pct` are `null` for record-only metrics (no free-tier quota). With `detail=1`, a per-account fetch failure yields `detail_error` on that account only (HTTP stays 200). The response never contains account ids, resource ids, or token values. Usage token provisioning lives in SECRETS.md (`CF_USAGE_API_TOKEN`).
````

- [ ] **Step 9.3: docs/usage.md**——「首頁雙 Tab」bullet 後追加一條：

```markdown
- **帳號卡排序＋折疊＋明細展開（2026-09-12 起）**：卡片依「最緊指標」（最高配額比例）降序排列；折疊面只顯示該最緊指標＋`N 項 ≥60%` 琥珀 chip；點開「全部指標與資源明細」顯示 9 指標全列＋**逐資源明細**（Workers/Pages 專案名、D1 database/KV namespace/R2 bucket 名稱與用量——明細為展開時即時查詢，per-isolate 5 分鐘快取；D1/KV 名稱由每日 REST 解析，未解析顯示短 id）。展開期間 30 秒自動刷新暫停（收合後恢復）。**對外 API**：`GET /api/cf-usage`（Bearer `CF_USAGE_API_TOKEN`，見 README「CF 用量 API」）供其它專案的 Claude Code 取用量做分析。
```

- [ ] **Step 9.4: secrets-archive/SECRETS.md**——Worker secrets 表/清單加 `CF_USAGE_API_TOKEN` 條目：

```markdown
### CF_USAGE_API_TOKEN（2026-09-12 首次設定）

- **用途**：`GET /api/cf-usage` 對外唯讀用量 API 的靜態 Bearer token（`timingSafeEqual` 常數時間比對、fail-closed；缺值一律 401）
- **來源**：`openssl rand -hex 32`（操作者本機產生）
- **值存放**：域 A＝`~/.config/watch-dog/usage-api-token`（操作者本機明文檔，chmod 600，repo 外——其它專案經此檔取得）＋ `.dev.vars`（seal 進 `env.7z`）；域 B＝`wrangler secret put CF_USAGE_API_TOKEN`（file-sourced pipe，agent 不經手明文）
- **被誰用**：其它專案的 Claude Code／自動化（README「CF 用量 API」記載用法與本機檔路徑）
- **輪替**：重新 `openssl rand -hex 32` → 覆寫本機檔 → `wrangler secret put CF_USAGE_API_TOKEN < 檔` → `.dev.vars` 同步＋`seal.sh` reseal → 通知消費端專案
- **上次更換**：2026-09-12（首次設定）
```

- [ ] **Step 9.5: Commit**

```bash
git add README.md docs/api.md docs/usage.md secrets-archive/SECRETS.md
git commit -m "docs(cf-usage): README CF 用量 API（token 取得/curl/判讀/CLAUDE.md 指示塊）＋api.md/usage.md/SECRETS.md 同步

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: 全量驗證＋FIX-LOG＋部署＋收簿記

**Files:**
- Modify: `FIX-LOG.md`（新條目）

- [ ] **Step 10.1: `make ci` 全綠**

Run: `make ci`
Expected: tsc ✓ / ESLint 0 warning ✓ / app pool 全綠 / guards 21/21 ✓ / §L ✓ / §M 僅已知 legacy warns（CLOUDFLARE_API_TOKEN/SLACK_API_TOKEN）。
（**紀律**：`./node_modules/.bin/tsc --noEmit`——[NEVER] `npx tsc`；輸出 [NEVER] pipe 進 tail/head/grep——重導向 `/tmp/x.log` 後對檔案 grep、分開查 exit code。）

- [ ] **Step 10.2: §3.1 手追**（書面記錄進 FIX-LOG 條目）

1. SELECT 清單無 account_id（getTodayCfUsage＋findEnabledAccountByLabel 後者只進 service 不出）；
2. fragment 錯誤路徑：throw → 200＋CfDetailError（htmx 不 swap 非 2xx）；
3. API 401 路徑：secret 缺 → `!expected` 先擋（不可能部署——required 鏈，但 fail-closed 語義仍鎖）；
4. KV id 正規化三態：kvo（bare）→normalize 冪等；kvs（hyphen）→bare；REST（bare）→bare——join 鍵一致；
5. poller 掛鉤 try/catch 邊界：refresh throw 不觸 summary/failures/self-warning；
6. details 展開 → `toggle from:closest details once` → fragment → swap innerHTML；details 開啟時 reload guard 抑制 `location.reload()`。

- [ ] **Step 10.3: FIX-LOG.md 條目**（格式：目標/原因/預期結果/範圍/驗證）＋commit

```bash
git add FIX-LOG.md
git commit -m "docs(fix-log): CF 資源明細＋對外用量 API 條目（目標/原因/預期結果/範圍/驗證）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 10.4: 本地手動瀏覽器驗證（ship-check 前置）**

```bash
DEV_PORT=8789 ./dev-tunnel.sh   # .dev.vars 先補 CF_USAGE_API_TOKEN（見 10.5 Step b 的 echo 同款）
```

目檢清單：卡排序（最緊在前）／折疊面＝最緊指標＋chip／點開 details→全指標＋明細表載入（Workers/Pages/D1/KV/R2 名稱）／**展開時 30s 不 reload**（開著等 >30s）／收合後下個 tick 恢復 reload／mobile 寬度表格不爆版。

- [ ] **Step 10.5: 部署（操作者批准後；順序 [NEVER] 顛倒——secret 先於 deploy，schema 先於 secret）**

```bash
# a. remote D1 schema（冪等——只會新增 cf_resource_names）
npx wrangler d1 execute watch-dog-db --remote --file=src/db.sql

# b. token 產製＋域 A/B 散佈（agent 不經手值——全程 file-sourced）
mkdir -p ~/.config/watch-dog
openssl rand -hex 32 > ~/.config/watch-dog/usage-api-token
chmod 600 ~/.config/watch-dog/usage-api-token
npx wrangler secret put CF_USAGE_API_TOKEN < ~/.config/watch-dog/usage-api-token
grep -q '^CF_USAGE_API_TOKEN=' .dev.vars || echo "CF_USAGE_API_TOKEN=$(cat ~/.config/watch-dog/usage-api-token)" >> .dev.vars
bash secrets-archive/seal.sh   # 需 ENV_SECRET_PASS——操作者協助輸入

# c. deploy
npm run deploy
```

- [ ] **Step 10.6: 線上驗證矩陣**（curl 存 `/tmp` 檔再 grep——[NEVER] 管線；首測帶 `?cb=$(date +%s)` 防 edge stale）

```bash
BASE="https://watch-dog.helperp.workers.dev"
TOK="$HOME/.config/watch-dog/usage-api-token"

# 1-2. 401 雙態
curl -s -o /tmp/wd-noauth.json -w '%{http_code}' "$BASE/api/cf-usage" > /tmp/wd-code1 ; echo
curl -s -o /tmp/wd-badauth.json -w '%{http_code}' -H 'Authorization: Bearer wrong' "$BASE/api/cf-usage" > /tmp/wd-code2 ; echo
# 3. 200 全帳號（compare 兩碼檔 = 401/401；本體檔驗 shape + 32-hex=0）
curl -s -H "Authorization: Bearer $(cat $TOK)" "$BASE/api/cf-usage" -o /tmp/wd-api.json
# 4. 404 未知 label
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat $TOK)" "$BASE/api/cf-usage?account=ghost" ; echo
# 5. detail=1
curl -s -H "Authorization: Bearer $(cat $TOK)" "$BASE/api/cf-usage?detail=1" -o /tmp/wd-detail.json
# 6. 首頁：卡排序 + label + 32-hex=0
curl -s "$BASE/?cb=$(date +%s)#cf" -o /tmp/wd-home.html
# 7. fragment（取 /tmp/wd-api.json 內任一 label）
curl -s "$BASE/cf-usage/detail?label=<LABEL>" -o /tmp/wd-frag.html

grep -c '' /tmp/wd-api.json                       # 非空
grep -oE '[0-9a-f]{32}' /tmp/wd-api.json /tmp/wd-detail.json /tmp/wd-home.html /tmp/wd-frag.html | wc -l   # 預期 0
```

通過判定：401×2、200、404、detail 有 groups、首頁有 `cf-warn-chip`/`cf-expand`/`hx-get="/cf-usage/detail?label=`、fragment 有群組標題、四檔 32-hex 計數 = 0。

- [ ] **Step 10.7: 收簿記**

1. `evo log-attempt --project watch-dog --task cf-resource-detail-api --kind code --goal "首頁 CF 卡排序折疊明細＋對外用量 API" --outcome <實況> [--signature <樣態key>]`
2. market-ops 卡 `stage: done`（補驗收證據：/tmp 驗證檔路徑＋deploy version）→ `~/Code/market-ops` commit＋push
3. peter-brain `ingest_doc`（**source_type="project-status"** upsert——非 dev-brain）：watch-dog 現況（CF 監控三層：帳號級輪詢告警→首頁排序折疊→逐資源明細＋對外 API；blockers=無；next=無）
4. `git push`

---

## 驗證總綱（§4——每 task 內已內嵌，此處為全案收斂順序）

1. `./node_modules/.bin/tsc --noEmit`
2. `npm run lint`
3. `npm run test:app`（= `vitest run`，[NEVER] `--project app`）
4. `npm run test:guards`
5. `make ci`（最終全量）
6. 本地 `wrangler dev` 目檢（Task 10.4）
7. 部署後線上矩陣（Task 10.6）

**通用紀律**：輸出 [NEVER] pipe 進 tail/head/grep——寫檔再 grep 檔案、exit code 分開查；`npx tsc` [NEVER]；部署後 curl 带 cache-bust。

## D35/D36（文件同步 gate）

- **D35**：新對外端點必出現於 `README.md`（API Endpoints＋CF 用量 API 小節含 token 取得法）——Task 9.1。
- **D36**：`docs/api.md` 端點規格＋`docs/usage.md` 操作者視角＋`secrets-archive/SECRETS.md` 新 secret 條目——Task 9.2–9.4。（`docs/testing.md` 為 admin UI 手動清單——本功能不觸 /admin，依計畫會議裁定跳過。）

## §5.5 ship-check

- [ ] `make ci` 全綠（含 §L/§M——僅已知 legacy warns）
- [ ] 本地瀏覽器目檢六項（排序/折疊面/展開明細/展開暫停 reload/收合恢復/mobile）
- [ ] 部署順序正確：remote D1 → `wrangler secret put` → `npm run deploy`（secret 檔案來源、agent 零接觸值）
- [ ] 線上驗證矩陣 7 項通過（401×2/200/404/detail/首頁/fragment/32-hex=0×4 檔）
- [ ] `.dev.vars` 已補值＋`seal.sh` reseal＋SECRETS.md 記載
- [ ] 簿記四件：evo／market-ops done／peter-brain project-status／push

## 自審清單（writing-plans self-review——已跑）

1. **Spec coverage**：設計文件 8 行大綱 → Task 1（表）/2-3（明細查詢＋快取）/4（名稱解析）/5-7（排序＋折疊＋展開）/8（API）/9（token 發佈文件）；安全不變式 5 條 → Task 6/7/8 測試雙護欄＋型別收縮；已知取捨 3 條 → 設計文件既載，行為由 Task 7（reload 暫停）/2（Pages 原名）/2（limit 100 註解）落地。無缺口。
2. **Placeholder scan**：全 task 均含完整程式碼/指令/預期輸出；零 TBD/TODO/「同 Task N」。
3. **Type consistency**：`resetResourceCaches`/`getResourceDetailByLabel`/`refreshResourceNamesIfNeeded`/`getTodayCfUsage`/`normalizeNsId`/`buildResourceQuery`/`parseResourceDetail`/`seedResourceName`/`cfD1ListUrl`/`cfKvListUrl`/`TEST_USAGE_API_TOKEN` 跨 task 名稱一致；`CfAccountCardData.topMetric?/maxRatio/warnCount` 三者定義（Task 5）與消費（Task 7 測試+視圖）一致；`ResourceDetail`/`ResourceItem`/`ResourceGroup` 欄位在 2/3/6/8 task 間一致；API 的 `toApiDetail` 輸出（無 id）與 Task 8 測試斷言（32-hex=0）一致。
