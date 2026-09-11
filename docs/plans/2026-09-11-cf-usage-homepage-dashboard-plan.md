# CF 用量儀表板上首頁（雙 Tab）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公開首頁 `GET /` 變雙 Tab（服務狀態／CF 用量），CF pane 以帳號卡＋配額進度條呈現今日用量——**永不出現 32-hex Account ID**（SQL 即不選取）；`/admin` CF tab 一切不變。

**Architecture:** 服務端渲染零新依賴：`GET /` 在既有 projects/checks 查詢外，以**獨立 try/catch** 加查 `cf_usage_state ⋈ cf_accounts`（今日、enabled），route 分組成 per-account cards，view（`CfUsagePane`）渲染；Alpine `x-show` 切 tab、URL hash 持久化；配額由 `METRICS` registry 派生（與 poller 同源）。共用格式化/配額函數抽成唯一實作（`src/lib/format.ts`、`cfUsage.ts#quotaFor`）。

**Tech Stack:** Hono 4 `hono/html`（自動跳脫）、Pico.css dark、Alpine.js 3.14（既有 CDN）、htmx 1.9.10 既有 30s 輪詢、D1 原生 prepared statements（不變式 ③）、vitest `@cloudflare:vitest-pool-workers`。

**設計真源：** `docs/plans/2026-09-11-cf-usage-homepage-dashboard-design.md`（操作者已批准的 spec；本計畫完全遵循）。

---

## 0. 02-BUILD-SPEC 合規宣告

**tier: major（8 檔＋新能力）**——超過 5 檔且屬新負載能力（公開端點渲染新資料類），全套 gates 適用（D21 THINK、D33 user story、§2.3 模組形狀、§3.1 手追測試斷言、§4 驗證順序、§5.5 ship-check）。無 critical-path 檔案（不觸 auth/middleware/secret/schema/migration）。

### THINK（§1，七欄）

| 欄 | 內容 |
|---|---|
| **目標** | 首頁可直接巡查全部 CF 帳號配額消耗（誰接近額度、誰投影會爆），不必登入 /admin；公開但不洩 Account ID |
| **為什麼是這個方案** | 方案 A（spec 已定案）：服務端渲染一次進兩 pane，零新依賴、零 fragment 端點、零圖表庫；tab 切換重用 /admin 既有 Alpine 模式；config 無變動、無部署風險放大 |
| **變更範圍** | 8 檔（下方清單）；無 schema、無 secret、無 cron、無 API 契約變動 |
| **風險與緩解** | ①公開頁洩 ID → **SQL SELECT 不含 account_id**（源頭斷）＋泛型 32-hex regex 測試護欄；②GET / 增讀 → 每次 +≤72 rows（前綴掃描）；30s 自動刷新的長開 tab ≈ +124k rows/day（host 帳號 5M 額度的 ~2.5%），YAGNI 先不做快取（記錄於設計取捨）；③CF 查詢炸拖垮首頁 → 獨立 try/catch，只降級 CF pane；④tab hash 凍結 30s 刷新 → hyperscript 改無條件 reload（hash 由 tab 寫入，舊條件 `hash===''` 在 #cf 時永假） |
| **測試策略** | 新 `tests/dashboard.test.ts` 7 案（app pool，SELF.fetch）；既有 133 app+21 guards 全綠為 gate；§3.1 手追清單見 Task 5 |
| **回滾計畫** | 純疊加式變更（無 schema/API 變動），`git revert` 單 commit 即回原狀；部署回滾＝重 deploy 前版 |
| **驗收條件** | D33 驗收 9 條（下方）＋`make ci` 全綠＋線上探測（雙 tab 存在、`grep -cE '[0-9a-f]{32}'` = 0） |

### D33 使用者故事＋驗收條件

**故事**：作為操作者，我想在公開首頁一眼看到所有 CF 帳號今日的配額消耗（誰接近額度、誰的燃燒速率投影會超額），不必登入 /admin 也能日常巡查；同時任何訪客都不該看到 32-hex Account ID。

**驗收條件（測試場景映射）**：
1. `GET /` 呈現雙 Tab：服務狀態（原內容原封）＋CF 用量（測試 1）
2. 每啟用帳號一卡：label＋plan 徽章＋指標列（registry 中文標籤）（測試 1）
3. 有配額指標：值＋進度條＋%；<60% 藍／≥60% 琥珀／≥80% 紅（測試 3）
4. 投影超額 → 45° 條紋＋⚠＋tooltip 帶預估收盤值（測試 4）
5. 無配額指標（workers_errors 等）：值 only 無條（測試 5）
6. **回應 HTML 永不含任何 32-hex id**——特定 id＋泛型 regex 雙護欄（測試 2）
7. CF 查詢失敗只降級 CF pane，服務狀態照常（測試 6→對應「隔離」案）
8. tab 存 URL hash（#status/#cf），30s 刷新後停留原 tab（測試 1 斷言 hash 邏輯在 HTML 中）
9. 空狀態導向 /admin（測試 6）；/admin CF tab 一切不變（既有 admin 測試全綠）

### 模組形狀（§2.3：14-DESIGN-PRINCIPLES §0 兩問＋§2 四條）

**新/改單元的 §0 兩問**：
- `src/lib/format.ts`（`fmtMetricValue`）：介面測試＝「metric key＋數字 → 人類可讀字串」（admin 快照表既有輸出形態即規格）；擁有測試＝間接（兩個 UI 的 app-pool 測試＋tsc 型別），純函數無狀態，恰當。
- `cfUsage.ts#quotaFor`：介面＝`(metric, plan) → number`（0＝無配額）；poller 門檻、admin 快照、首頁 pane 三端共用——正是「第二呼叫端出現→抽具名模組」。
- `views/dashboard.ts#CfUsagePane`：介面＝`CfUsageData → html 片段`；route 組資料、view 只渲染，單向依賴。
- `routes/dashboard.ts#groupCfUsage`（私有）：flat JOIN rows → per-account cards；正確性依 SQL `ORDER BY a.label` 的連續性（同帳號列相鄰），斷言由測試 1/3 覆蓋。

**§2 四條**：
1. **單向依賴**：`routes → views → {services.cfUsage, lib.format}`；views 不回頭 import routes ✓（新增後維持）
2. **介面窄**：`DashboardContent` 只 +1 參數（`cfPane`）；`CfUsageData` 3 欄；無新 env/binding
3. **錯誤邊界**：CF pane 級 try/catch（與 cron poller 的 fail-dead 隔離同構）
4. **唯一實作**：`fmtMetricValue` 與 `quotaFor` 各自收斂為單一實作（原先 admin 私有/poller 內聯）

### 檔案清單＋爆炸半徑

| 檔案 | 變更 | 半徑 |
|---|---|---|
| `src/lib/format.ts` | **新**：`fmtMetricValue`（自 adminViews 抽出） | 純函數，零行為變更 |
| `src/services/cfUsage.ts` | **+`quotaFor()` 導出**；poller L397 一行改用 | 33 個 cfUsage 測試鎖定行為 |
| `src/views/adminViews.ts` | 刪私有 fmt helpers 改 import；快照表 quota 改用 `quotaFor` | admin 頁零行為變更（app pool 鎖定） |
| `src/routes/dashboard.ts` | +CF 查詢（獨立 try/catch）＋`groupCfUsage`＋`DashboardContent` 傳 cfPane | `GET /` 與 htmx fragment 路徑（後者不變） |
| `src/views/dashboard.ts` | +`CfUsagePane`/卡/指標列組件＋型別；`DashboardContent` 改雙 Tab 殼＋無條件 reload | 唯一呼叫端＝routes/dashboard.ts |
| `src/views/layout.ts` | +CF pane CSS（含 mobile 一條） | 疊加式，不動既有選擇器 |
| `tests/utils.ts` | +`reapplySchema()` | 僅測試用 |
| `tests/dashboard.test.ts` | **新**：7 案 | — |
| `docs/usage.md` | CF 段 +1 bullet | — |

### dataviz 裁定（已實跑驗證器，2026-09-11）

`validate_palette.js "#3498db,#f39c12,#e74c3c" --mode dark`（表面 #1a1a19 與卡面 #242424 各一次）：**CVD 分離 ΔE 13.7（deutan）✓／正常視覺 18.2 ✓／對表面對比 ≥3:1 ✓／chroma ✓**；lightness band FAIL 僅適用 categorical 系列（status palette 刻意不等亮），不採納。編碼規則：**% 數字永遠印出（文字用中性墨色，bar 承載 status 色）→ 非 color-alone**；投影＝**45° 條紋**（texture 二級編碼）＋⚠＋tooltip。

---

## Task 1：唯一實作收斂——`fmtMetricValue` 抽 lib、`quotaFor` 進 registry 模組（純重構）

**Files:**
- Create: `src/lib/format.ts`
- Modify: `src/services/cfUsage.ts`（+`quotaFor`；L397 改用）
- Modify: `src/views/adminViews.ts:37-52`（刪私有 helpers）＋ `:483`（quota 改用）

- [ ] **Step 1.1：建 `src/lib/format.ts`**

```ts
// src/lib/format.ts
// Shared value formatting for the CF usage metric displays. Born when the
// homepage CF pane became the second caller of a helper that used to live
// privately in adminViews (14-DESIGN-PRINCIPLES: one implementation).

/** "1179 B" / "12.3 KiB" / "1.0 GiB" for the *_bytes storage gauges. */
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** Byte gauges get human units; everything else is a plain count. */
export const fmtMetricValue = (metric: string, n: number): string =>
  metric.endsWith('_bytes') ? fmtBytes(n) : n.toLocaleString();
```

- [ ] **Step 1.2：`cfUsage.ts` 加 `quotaFor`（放 METRICS 定義之後、純 helper 區之前）**

```ts
/** Quota for a metric on a plan — 0 = record-only (no quota). Single
 *  derivation shared by the poller thresholds, the admin snapshot table,
 *  and the homepage CF pane (one implementation rule). */
export function quotaFor(metric: string, plan: CfPlanId): number {
  const def = METRICS[metric];
  return def ? (def.quotas[plan] ?? 0) : 0;
}
```

poller 內（`for (const [metricKey, def] of Object.entries(METRICS))` 迴圈內，原 L397）：

```ts
// 前
const quota = def.quotas[account.plan] ?? 0;
// 後
const quota = quotaFor(metricKey, account.plan);
```

（`def` 在迴圈內另有用途，保留；只換 quota 一行。）

- [ ] **Step 1.3：`adminViews.ts` 刪私有 helpers、改 import**

刪除 L37-52（`fmtBytes`＋`fmtMetricValue` 兩個私有定義及其註解），import 區加：

```ts
import { fmtMetricValue } from '../lib/format';
```

快照表處（原 L483 一帶）quota 派生改：

```ts
// 前
const def = METRICS[u.metric];
const quota = def ? (def.quotas[a.plan] ?? 0) : 0;
// 後
const quota = quotaFor(u.metric, a.plan);
```

（同檔 import 既有 `import { METRICS, type CfAccount } from '../services/cfUsage';` 改為 `import { METRICS, quotaFor, type CfAccount } from '../services/cfUsage';`——`METRICS` 保留：快照表的 metric 排序與顯示名仍用它。）

- [ ] **Step 1.4：驗證（純重構＝零行為變更）**

```bash
./node_modules/.bin/tsc --noEmit
npx vitest run tests/admin.test.ts tests/cfUsage.test.ts
```

預期：tsc 0 error；兩檔全綠（快照表格式與 quota 派生被既有斷言鎖定）。

- [ ] **Step 1.5：Commit**

```bash
git add src/lib/format.ts src/services/cfUsage.ts src/views/adminViews.ts
git commit -m "refactor(cf-usage): fmtMetricValue 抽 lib/format、quotaFor 進 registry 模組——展示層配額/格式化唯一實作（首頁 pane 將成第二/三呼叫端）"
```

---

## Task 2：失敗測試＋`reapplySchema` helper（先紅不 commit，與 Task 3 同批綠後 commit）

**Files:**
- Modify: `tests/utils.ts`（applySchema 之後 +helper）
- Create: `tests/dashboard.test.ts`

- [ ] **Step 2.1：`tests/utils.ts` 加 `reapplySchema`（`applySchema` 定義之後）**

```ts
/** Re-apply src/db.sql unconditionally — restores tables a destructive test
 *  dropped (applySchema's once-per-worker flag would skip it). */
export async function reapplySchema(): Promise<void> {
  schemaApplied = false;
  await applySchema();
}
```

- [ ] **Step 2.2：寫 `tests/dashboard.test.ts`（完整檔案）**

```ts
// tests/dashboard.test.ts
// Public homepage (GET /) — dual-tab shell + CF usage pane.
//
// The security invariant under test: the homepage is PUBLIC but must never
// leak the 32-hex CF account id — the route's SQL joins on it without
// selecting it, and this suite locks that at the HTML level (specific
// seeded ids + a generic 32-hex regex over the whole document).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { DB, reapplySchema, resetDb, seedCfAccount, seedCheck, seedProject, TEST_CF } from './utils';

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Seed one cf_usage_state row for today (the homepage reads day_utc = now). */
async function seedUsage(
  accountId: string,
  metric: string,
  value: number,
  projectedEod: number | null = null,
): Promise<void> {
  await DB.prepare(
    'INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level) VALUES (?, ?, ?, ?, ?, 0)'
  )
    .bind(todayUtc(), accountId, metric, value, projectedEod)
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe('GET / — dual-tab homepage with CF usage pane', () => {
  it('renders both tabs, the CF pane (label + metric names + plan badge) and the status pane side by side', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
    await seedCfAccount({ label: 'helperp' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000);

    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // tab shell + hash-persisted tab state
    expect(html).toContain('服務狀態');
    expect(html).toContain('CF 用量');
    expect(html).toContain("location.hash === '#cf'");
    // status pane intact inside its tabpanel
    expect(html).toContain('Test Project');
    // CF pane: label (never the id), registry display name, plan badge
    expect(html).toContain('helperp');
    expect(html).toContain('D1 rows 讀取');
    expect(html).toContain('cf-plan-badge');
    // freshness uses the shared $time magic
    expect(html).toContain('$time(');
  });

  it('NEVER leaks the 32-hex account id into the public HTML (security)', async () => {
    await seedCfAccount({ label: 'A' });
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'B' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1);
    await seedUsage(TEST_CF.accountIdB, 'kv_ops', 1);

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).not.toContain(TEST_CF.accountId);
    expect(html).not.toContain(TEST_CF.accountIdB);
    // generic guard: no 32-hex run anywhere in the document
    expect(html.match(/[0-9a-f]{32}/)).toBeNull();
  });

  it('colors bars by threshold: <60% plain, >=60% warn, >=80% danger', async () => {
    await seedCfAccount();
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000);   // 20% of 5M — plain
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 65_000);   // 65% of 100k — warn
    await seedUsage(TEST_CF.accountId, 'workers_requests', 90_000);  // 90% of 100k — danger

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    // Counts anchor on the rendered class ATTRIBUTE ('class="…'), because the
    // page ships its own <style> block where the same names appear as CSS
    // selectors (.cf-warn etc.) and would pollute bare-substring counts.
    expect((html.match(/cf-bar-fill"/g) ?? []).length).toBe(1); // plain fill: attr ends right after the base class
    expect((html.match(/cf-warn"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-danger"/g) ?? []).length).toBe(1);
  });

  it('marks projected-over-quota rows with stripes + warning flag + projected EOD text', async () => {
    await seedCfAccount();
    // 20% now, but the burn rate projects 150% of the 100k quota by UTC midnight
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 20_000, 150_000);
    await seedUsage(TEST_CF.accountId, 'kv_ops', 10_000); // non-projected control

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('cf-projected');
    expect(html).toContain('⚠');
    expect(html).toContain('預估'); // projected end-of-day value in the tooltip
  });

  it('renders unquoted metrics (workers_errors) as value-only, no bar', async () => {
    await seedCfAccount();
    await seedUsage(TEST_CF.accountId, 'workers_errors', 5);

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('Workers 錯誤');
    expect(html).toContain('>5<'); // raw count rendered
    // no rendered bar element anywhere (CSS selectors in <style> don't count —
    // anchor on the class attribute form)
    expect(html).not.toContain('class="cf-bar');
  });

  it('shows the empty state (pointing at /admin) when no accounts are configured', async () => {
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('尚無 CF 用量資料');
    expect(html).toContain('/admin');
    expect(html).not.toContain('class="cf-account-card"');
  });

  it('isolates a CF-side failure: status pane still renders, only the CF pane degrades', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
    await DB.prepare('DROP TABLE cf_usage_state').run();
    try {
      const res = await SELF.fetch('http://localhost/');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Test Project');            // status pane survived
      expect(html).toContain('Error loading CF usage'); // CF pane degraded alone
    } finally {
      await reapplySchema(); // restore the dropped table
    }
  });
});
```

- [ ] **Step 2.3：跑測試確認紅（對的失敗原因）**

```bash
npx vitest run tests/dashboard.test.ts
```

預期：7 案全 FAIL——斷言缺字串（'服務狀態' tab、'helperp'…），**不是** import/compile 錯（測試只 import utils，utils 的 `reapplySchema` 已在 2.1 加入）。

---

## Task 3：實作——route 查詢＋分組、view 組件＋雙 Tab 殼（綠後與 Task 2 同 commit）

**Files:**
- Modify: `src/routes/dashboard.ts`（全文改寫如下）
- Modify: `src/views/dashboard.ts`（+型別＋組件；`DashboardContent` 改殼）

- [ ] **Step 3.1：`src/routes/dashboard.ts` 全文**

```ts
// src/routes/dashboard.ts
// Public monitoring dashboard (GET /).

import { Hono } from 'hono';
import type { AppBindings, Check, Project } from '../types';
import { METRICS } from '../services/cfUsage';
import { Layout } from '../views/layout';
import {
  CfUsagePane,
  DashboardContent,
  ErrorState,
  ProjectGrid,
} from '../views/dashboard';
import type { CfAccountCardData, CfUsageData, CfUsageRow } from '../views/dashboard';

const dashboard = new Hono<{ Bindings: AppBindings }>();

/** Shape the flat JOIN rows into per-account cards. Rows arrive sorted by
 *  label so a label change starts a new card (labels are the operator's
 *  per-account names — unique in practice for this single-operator system);
 *  metric order follows the METRICS registry. */
function groupCfUsage(rows: CfUsageRow[]): CfUsageData {
  const order = Object.keys(METRICS);
  const accounts: CfAccountCardData[] = [];
  for (const row of rows) {
    let card = accounts[accounts.length - 1];
    if (!card || card.label !== row.label) {
      card = { label: row.label, plan: row.plan, last_ok_at: row.last_ok_at, metrics: [] };
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
  }
  return {
    accounts,
    lastPolledAt: accounts.reduce((max, a) => Math.max(max, a.last_ok_at), 0),
  };
}

/**
 * GET /
 * Dashboard main page — dual tab: 服務狀態 (stats + project grid) and CF 用量.
 * Supports HTMX polling for auto-refresh (every 30s).
 */
dashboard.get('/', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const isHtmx = c.req.header('HX-Request');

  // CF usage pane — queried and caught on its own so a CF-side failure
  // degrades only this pane, never the service-status view (the same
  // isolation the cron poller applies to the fail-dead path).
  // account_id is deliberately NOT selected: this page is public and the
  // 32-hex id must never reach the response (source-level cutoff, not
  // front-end masking — it is joined on, never read out).
  let cfPane: ReturnType<typeof CfUsagePane>;
  try {
    const usage = await db
      .prepare(
        `SELECT s.metric, s.value, s.projected_eod, s.alerted_level, s.updated_at,
                a.label, a.plan, a.last_ok_at
         FROM cf_usage_state s JOIN cf_accounts a ON a.account_id = s.account_id
         WHERE s.day_utc = date('now') AND a.enabled = 1
         ORDER BY a.label, s.metric`
      )
      .all<CfUsageRow>();
    cfPane = CfUsagePane(groupCfUsage(usage.results));
  } catch (error) {
    console.error('CF usage pane error:', error);
    cfPane = ErrorState('Error loading CF usage', 'Unable to fetch CF usage data. Please try again.');
  }

  try {
    // Get all projects
    const projectsResult = await db
      .prepare('SELECT * FROM projects ORDER BY display_name')
      .all<Project>();

    const projects = projectsResult.results;

    // Get all checks
    const checksResult = await db
      .prepare('SELECT * FROM checks ORDER BY project_id, name')
      .all<Check>();

    const checks = checksResult.results;

    // Group checks by project
    const projectsWithChecks = projects.map((project) => ({
      ...project,
      in_maintenance: project.maintenance_until > now,
      checks: checks
        .filter((check) => check.project_id === project.id)
        .map((check) => ({
          ...check,
          is_stale: check.type === 'heartbeat' && (check.last_seen + check.interval + check.grace) < now,
        })),
    }));

    // Calculate overall stats
    const stats = {
      total: checks.length,
      ok: checks.filter((check) => check.status === 'ok').length,
      error: checks.filter((check) => check.status === 'error').length,
      dead: checks.filter((check) => check.status === 'dead').length,
      maintenance: projects.filter((p) => p.maintenance_until > now).length,
    };

    const projectGrid = ProjectGrid(projectsWithChecks);

    // HTMX request: only return the project grid (refresh stats via page reload)
    if (isHtmx) {
      return c.html(projectGrid);
    }

    // Full page: both panes behind the dual-tab shell
    return c.html(Layout({ content: DashboardContent(stats, projectGrid, cfPane) }));
  } catch (error) {
    console.error('Dashboard error:', error);
    if (isHtmx) {
      return c.html(ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.'));
    }
    return c.html(
      Layout({ content: ErrorState('Error loading dashboard', 'Unable to fetch project data. Please try again.') })
    );
  }
});

export default dashboard;
```

- [ ] **Step 3.2：`src/views/dashboard.ts`——import 區改為**

```ts
import { html } from 'hono/html';
import type { Check, Project } from '../types';
import { METRICS, quotaFor } from '../services/cfUsage';
import type { CfPlanId } from '../services/cfUsage';
import { fmtMetricValue } from '../lib/format';
```

- [ ] **Step 3.3：`src/views/dashboard.ts`——檔尾（`ErrorState` 之前）插入 CF pane 型別＋組件**

```ts
/** One metric line of the homepage CF pane (cf_usage_state columns minus the
 *  account identity — account_id is intentionally absent end to end). */
export interface CfMetricRowData {
  metric: string;
  value: number;
  projected_eod: number | null;
  alerted_level: number;
}

/** Per-account card: label + plan + today's metric rows. */
export interface CfAccountCardData {
  label: string;
  plan: CfPlanId;
  last_ok_at: number;
  metrics: CfMetricRowData[];
}

/** Everything the CF pane renders (the route groups flat JOIN rows into this). */
export interface CfUsageData {
  accounts: CfAccountCardData[];
  lastPolledAt: number;
}

/** Flat JOIN row the route reads. The SELECT list omits account_id on
 *  purpose — the homepage must never render it (see tests/dashboard.test.ts). */
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

/** One metric line: name | value, then bar + pct when the metric has a quota.
 *  Bar color is status (plain <60% / amber >=60% / red >=80%) — the printed
 *  percentage is the primary signal, color only reinforces (never
 *  color-alone); a projected-over-quota row adds 45-degree stripes + a
 *  warning flag with the projected end-of-day value in the tooltip. */
const CfMetricLine = (row: CfMetricRowData, plan: CfPlanId) => {
  const def = METRICS[row.metric];
  const quota = quotaFor(row.metric, plan);
  const name = def ? def.label : row.metric;
  const projectedOver = row.projected_eod !== null && quota > 0 && row.projected_eod > quota;
  const projTitle = projectedOver
    ? `預估今日收盤 ${fmtMetricValue(row.metric, row.projected_eod ?? 0)} — 超過配額 ${fmtMetricValue(row.metric, quota)}`
    : '';
  const title =
    quota > 0
      ? `${name}: ${fmtMetricValue(row.metric, row.value)} / ${fmtMetricValue(row.metric, quota)} 配額${projectedOver ? ` — ${projTitle}` : ''}`
      : `${name}: ${fmtMetricValue(row.metric, row.value)}`;

  if (quota <= 0) {
    return html`
      <div class="cf-metric" title="${title}">
        <div class="cf-metric-top">
          <span class="cf-metric-name">${name}</span>
          <span class="cf-metric-val">${fmtMetricValue(row.metric, row.value)}</span>
        </div>
      </div>
    `;
  }

  const pct = row.value / quota;
  const level = pct >= 0.8 ? ' cf-danger' : pct >= 0.6 ? ' cf-warn' : '';
  const fillClass = `cf-bar-fill${level}${projectedOver ? ' cf-projected' : ''}`;
  return html`
    <div class="cf-metric" title="${title}">
      <div class="cf-metric-top">
        <span class="cf-metric-name">${name}</span>
        <span class="cf-metric-val">${fmtMetricValue(row.metric, row.value)}</span>
      </div>
      <div class="cf-metric-bar-row">
        <div class="cf-bar">
          <div class="${fillClass}" style="width: ${Math.min(100, pct * 100)}%"></div>
        </div>
        <span class="cf-metric-pct">${Math.round(pct * 100)}%</span>
        ${projectedOver ? html`<span class="cf-proj-flag" title="${projTitle}">⚠</span>` : ''}
      </div>
    </div>
  `;
};

/** Account card: label + plan badge + all metric lines (registry order). */
const CfAccountCard = (card: CfAccountCardData) => html`
<div class="cf-account-card">
  <div class="cf-account-header">
    <h3>${card.label}</h3>
    <span class="cf-plan-badge">${card.plan}</span>
  </div>
  ${card.metrics.map((row) => CfMetricLine(row, card.plan))}
</div>
`;

/** The CF 用量 tab pane. Public by design — renders labels and numbers only,
 *  never account ids (empty state points operators at /admin for setup). */
export const CfUsagePane = (data: CfUsageData) =>
  data.accounts.length === 0
    ? html`
      <div class="empty-state">
        <h3>尚無 CF 用量資料</h3>
        <p>到 <a href="/admin">/admin → CF 用量</a> 新增監控帳號（或按「立即輪詢」抓第一份快照），之後每 30 分鐘自動更新。</p>
      </div>
    `
    : html`
      <p class="cf-summary">
        ${data.accounts.length} 帳號監控中 · 最後輪詢 <span x-data="{}" x-text="$time(${data.lastPolledAt})"></span> · 額度 UTC 00:00（台北 08:00）重置
      </p>
      <div class="cf-grid">
        ${data.accounts.map((card) => CfAccountCard(card))}
      </div>
    `;
```

- [ ] **Step 3.4：`DashboardContent` 換成雙 Tab 殼（整個函式取代）**

```ts
/**
 * Full dashboard content behind the dual-tab shell: 服務狀態 (stats + grid)
 * and CF 用量 are both server-rendered; Alpine switches visibility and
 * persists the active tab in the URL hash (#status default / #cf), so the
 * 30s auto-reload lands back on the same tab (and #cf links are shareable).
 */
export const DashboardContent = (
  stats: Parameters<typeof StatsCards>[0],
  projectGrid: ReturnType<typeof html>,
  cfPane: ReturnType<typeof CfUsagePane>,
) => html`
<div x-data="{ tab: location.hash === '#cf' ? 'cf' : 'status' }">
  <div class="dashboard-tabs" role="tablist">
    <button type="button" role="tab" :aria-selected="tab === 'status'" :class="tab === 'status' ? 'primary' : 'outline secondary'" @click="tab = 'status'; location.hash = 'status'">服務狀態</button>
    <button type="button" role="tab" :aria-selected="tab === 'cf'" :class="tab === 'cf' ? 'primary' : 'outline secondary'" @click="tab = 'cf'; location.hash = 'cf'">CF 用量</button>
  </div>
  <div role="tabpanel" x-show="tab === 'status'">
    ${StatsCards(stats)}
    <div id="dashboard" hx-get="/" hx-trigger="every 30s" hx-swap="none" _="on htmx:afterRequest then location.reload()">
      ${projectGrid}
    </div>
  </div>
  <div role="tabpanel" x-show="tab === 'cf'" x-cloak>
    ${cfPane}
  </div>
</div>
`;
```

（**行為註記**：reload 從「hash 為空才 reload」改為**無條件 reload**——tab 狀態現在存在 hash 裡，舊條件在 `#cf` 下永遠不成立會凍結 CF pane 的 30s 刷新；reload 後 Alpine 由 hash 還原原 tab，兩 pane 都維持 30s 節奏。）

- [ ] **Step 3.5：跑新測試到綠**

```bash
./node_modules/.bin/tsc --noEmit
npx vitest run tests/dashboard.test.ts
```

預期：tsc 0 error；**7/7 PASS**。若測試 3 的 `cf-bar-fill"` 計數不符，優先檢查 `fillClass` 產出的 class 屬性串接（plain 應為 `class="cf-bar-fill"`）。

- [ ] **Step 3.6：跑全 app pool（既有零回歸）**

```bash
npx vitest run --project app
```

預期：既有 133＋新 7＝**140/140**。

- [ ] **Step 3.7：Commit（Task 2 測試＋Task 3 實作同批——main 上不留紅 commit）**

```bash
git add tests/utils.ts tests/dashboard.test.ts src/routes/dashboard.ts src/views/dashboard.ts
git commit -m "feat(dashboard): 首頁雙 Tab（服務狀態／CF 用量）——公開 pane 只取 label/plan/metric，SQL 即不選 account_id；CF 查詢獨立 try/catch 只降級自身；tab 存 URL hash 且 30s 刷新不再被 hash 凍結"
```

---

## Task 4：CSS（dataviz 規格落地）＋文件一句

**Files:**
- Modify: `src/views/layout.ts`（style 區兩處）
- Modify: `docs/usage.md`（CF 段 +1 bullet）

- [ ] **Step 4.1：layout.ts——`.empty-state h3 {…}` 與 `[x-cloak] {` 之間插入 CF pane CSS**

```css
    /* CF usage pane (homepage CF 用量 tab, 2026-09-11). Status palette
       validated for CVD separation (deutan deltaE 13.7) and >=3:1 contrast
       on the card surface; the % text stays neutral ink so color is never
       the only signal. cf-projected swaps the solid fill for 45-degree
       stripes of the same level pair (texture = secondary encoding). */
    .dashboard-tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }
    .cf-summary {
      font-size: 0.8rem;
      color: #888;
      margin-bottom: 1rem;
    }
    .cf-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
    }
    .cf-account-card {
      border: 1px solid #333;
      border-radius: 0.5rem;
      padding: 1.25rem;
      background: #242424;
    }
    .cf-account-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .cf-account-header h3 {
      font-size: 1.05rem;
      font-weight: 600;
      margin: 0;
    }
    .cf-plan-badge {
      padding: 0.125rem 0.6rem;
      background: rgba(52, 152, 219, 0.15);
      color: #3498db;
      border-radius: 1rem;
      font-size: 0.7rem;
      text-transform: uppercase;
    }
    .cf-metric {
      padding: 0.5rem 0;
      border-bottom: 1px solid #2e2e2e;
    }
    .cf-metric:last-child {
      border-bottom: none;
    }
    .cf-metric-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.75rem;
    }
    .cf-metric-name {
      font-size: 0.8rem;
      color: #bbb;
    }
    .cf-metric-val {
      font-size: 0.8rem;
      font-weight: 600;
    }
    .cf-metric-bar-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.3rem;
    }
    .cf-bar {
      flex: 1;
      height: 6px;
      background: #333;
      border-radius: 3px;
      overflow: hidden;
    }
    .cf-bar-fill {
      height: 100%;
      border-radius: 3px;
      --bar: #3498db;
      --bar-dim: #1b5e88;
      background: var(--bar);
    }
    .cf-bar-fill.cf-warn {
      --bar: #f39c12;
      --bar-dim: #9a6a0b;
    }
    .cf-bar-fill.cf-danger {
      --bar: #e74c3c;
      --bar-dim: #92271a;
    }
    .cf-bar-fill.cf-projected {
      background: repeating-linear-gradient(
        45deg,
        var(--bar) 0,
        var(--bar) 6px,
        var(--bar-dim) 6px,
        var(--bar-dim) 12px
      );
    }
    .cf-metric-pct {
      font-size: 0.75rem;
      color: #999;
      min-width: 2.75rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .cf-proj-flag {
      cursor: help;
      font-size: 0.85rem;
    }
```

- [ ] **Step 4.2：layout.ts——第一個 `@media (max-width: 639px)` 區塊內，`.dashboard-grid { grid-template-columns: 1fr; }` 之後加**

```css
      /* CF pane: single column on mobile */
      .cf-grid {
        grid-template-columns: 1fr;
      }
```

（⚠ 只加進**第一個** mobile 區塊——layout.ts 後段有既存的巢狀 @media 地帶，勿動。）

- [ ] **Step 4.3：`docs/usage.md` CF 段「成本紀律」bullet 之後加**

```md
- **首頁雙 Tab（2026-09-11 起）**：公開首頁 `/` 以 tab 切換「服務狀態／CF 用量」——用量卡＝Label＋plan 徽章＋各指標值＋配額進度條（<60% 藍／≥60% 琥珀／≥80% 紅；投影超額＝45° 條紋＋⚠，tooltip 帶預估收盤值）；**永不顯示 32-hex Account ID**（SQL 即不選取）；tab 存 URL hash（`#status`/`#cf`）可深連結、30 秒自動刷新後停留原 tab。`/admin` CF tab 職責不變（帳號管理＋立即輪詢＋快照表）
```

- [ ] **Step 4.4：驗證＋Commit**

```bash
./node_modules/.bin/tsc --noEmit && npm run lint
npx vitest run --project app
```

預期：tsc 0 error／lint 0 warning／140/140。

```bash
git add src/views/layout.ts docs/usage.md
git commit -m "style(dashboard): CF 用量 pane CSS——status 色階進度條（CVD 驗證）＋45° 條紋投影編碼＋mobile 單欄；usage.md 首頁雙 Tab 一句"
```

---

## Task 5：全量驗證、部署 gate、收尾簿記

**Files:** 無新碼（FIX-LOG.md 於部署後補條目）

- [ ] **Step 5.1：全量 CI**

```bash
make ci
```

預期：tsc ✓／ESLint 0 warning ✓／app pool 140/140 ✓／guards 21/21 ✓／§L §M ✓（**不得** pipe 進 tail/head/grep——輸出直接看）。

- [ ] **Step 5.2：§3.1 手追測試斷言（不信測試綠就算——逐條追資料流）**

1. **32-hex 零洩漏（測試 2）**：route SQL SELECT 清單＝`s.metric, s.value, s.projected_eod, s.alerted_level, s.updated_at, a.label, a.plan, a.last_ok_at`——無 `account_id`；view 內插值只有 label/plan/metric 名/數值/時間戳；`hono/html` 對字串內插自動跳脫（label 是操作者輸入，XSS 面同 admin 既有處理）→ 斷言 `not.toContain(id)` 與 regex 皆作用於完整 HTML ✓
2. **色階（測試 3）**：`d1_rows_written 65_000 / quotaFor('d1_rows_written','free') = 100_000 → pct 0.65 → level ' cf-warn'`；`workers_requests 90_000/100_000 → 0.9 → ' cf-danger'`；`d1_rows_read 1M/5M → 0.2 → ''`→ `class="cf-bar-fill"` ✓
3. **投影（測試 4）**：`projected_eod 150_000 > quota 100_000` 且非 null → `cf-projected`＋⚠＋「預估」字串；control 列（kv_ops 無投影）不觸發 ✓
4. **隔離（測試 7）**：DROP TABLE → 外層 try 只包 CF 查詢 → catch 給 cfPane=ErrorState → projects 查詢在另一 try → 兩者獨立 ✓
5. **無配額（測試 5）**：`quotaFor('workers_errors', …) = 0`（quotas:{}）→ `quota <= 0` 分支無 bar 節點 ✓
6. **既有路徑**：`isHtmx` fragment 仍只回 projectGrid；admin 頁零改動路徑（僅 import 換）✓

- [ ] **Step 5.3：渲染目檢（dataviz 步驟 7——validator 只驗色不驗版面）**

本地起 dev（workerd 本機可跑）：`DEV_PORT=8789 ./dev-tunnel.sh`（或 `npx wrangler dev --local`）→ 瀏覽器/lightpanda 開 `http://localhost:8789/`：
- [ ] 兩 tab 切換、`#cf` deep link 直接落 CF pane、30s 後 reload 停留原 tab
- [ ] 卡片無文字溢出／label 與 bar 不重疊／mobile 寬度（DevTools 375px）單欄
- [ ] 條紋與 ⚠ 在 projected 列清楚可辨
完後 `./dev-tunnel.sh stop`。

- [ ] **Step 5.4：部署（操作者批准後；直接 deploy 是允許路徑）**

```bash
npm run deploy
```

- [ ] **Step 5.5：線上驗證**

```bash
curl -s https://watch-dog.helperp.workers.dev/ -o /tmp/wd-home.html
grep -c '服務狀態' /tmp/wd-home.html   # ≥1
grep -c 'CF 用量' /tmp/wd-home.html    # ≥1
grep -cE '[0-9a-f]{32}' /tmp/wd-home.html  # 0（真實 8 帳號在庫下零洩漏）
grep -c 'cf-account-card' /tmp/wd-home.html # ≥8
```

再人工開頁面確認 8 張帳號卡、進度條色階與 admin 快照表數字一致（同源同式）。

- [ ] **Step 5.6：FIX-LOG 條目＋commit**

```md
### [2026-09-11] 首頁 CF 用量雙 Tab 儀表板——公開巡查但不洩 Account ID
**目標**：操作者要求 CF 用量上首頁美化呈現（/admin 維持設定職責）。**原因**：新能力（spec：docs/plans/2026-09-11-cf-usage-homepage-dashboard-design.md）。**預期結果**：GET / 雙 Tab（服務狀態原封＋CF 用量 pane）；SQL 不選 account_id（源頭斷）＋測試雙護欄（特定 id＋泛型 regex）；色階（藍/琥珀/紅）經 dataviz 驗證器 CVD 實跑（deutan ΔE 13.7、對比 ≥3:1）；投影＝45° 條紋＋⚠；CF 查詢獨立 try/catch；quotaFor/fmtMetricValue 收斂唯一實作。**範圍**：8 檔（見 plan）。**驗證**：`make ci` 全綠（140/140 app）＋線上探測（32-hex=0、8 卡、雙 tab）＋目檢截圖。
```

（數字以實跑結果回填；commit `docs(fix-log): …`。）

- [ ] **Step 5.7：收尾簿記（§5.5 ship-check）**

- dev-brain `putkm`：新能力無 bug 教訓——若執行中踩到值得記的坑才記
- `evo log-attempt --project watch-dog --task homepage-cf-dashboard --kind code --outcome success --signature …`
- market-ops 卡 WATCHDOG-005：stage → `done`（補驗收證據路徑）＋repo commit/push
- **peter-brain `ingest_doc`（source_type=project-status）**：watch-dog 狀態 upsert（新能力上線、健康度）
- `~/Code/market-ops` commit＋push

---

## 設計取捨記錄（已定案，勿重新 litigate）

1. **公開頁每次 +≤72 rows 讀**：不做快取/節流——單操作者低流量，成本記錄在案（~2.5%/常開 tab），額度警示系統本身就是監視器（自我監控已在 METRICS 曲線上）。
2. **label 分組**：單操作者系統 label 實務唯一；不為碰撞邊界加複雜度（invariant ②）。
3. **無條件 reload**：取代「hash 空才 reload」——tab hash 語義下舊條件會凍結 CF pane 刷新。
4. **KiB/MiB 單位**（共用 fmtMetricValue）：spec 草圖的 5M/412k 僅示意，唯一實作優先。
5. **alerted_level 不用於顯示**：那是 poller 去重狀態機；顯示色階用當前值/配額（與 admin 快照表同式），投影旗標用 projected_eod。
