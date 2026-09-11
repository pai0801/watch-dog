# 設計文件：CF 資源明細展開＋對外用量 API（2026-09-11）

> 續作：`2026-09-11-cf-usage-homepage-dashboard-plan.md`（首頁雙 Tab CF 用量儀表板，version `9761fdb9` 已上線）。
> 本檔 = 目標＋大綱＋核定決策＋已實測釘死的 API 合約；實作計畫見同日 `-plan.md`。

## 目標

操作者三項需求（2026-09-11 原文）：

1. **帳號卡排序＋折疊**：首頁 CF 卡片先顯示「全帳號中最緊（配額比例最高）的指標」，帳號總覽依最高用量比例排序；展開才看明細。
2. **逐資源明細**：展開後顯示 Workers／Pages 的專案名稱，以及 D1／KV／R2 的**各資源名稱**（database / namespace / bucket）與用量。
3. **對外 API**：其它專案的 Claude Code 可經 watch-dog API 取得用量做後續分析與優化；README.md 詳細說明用法。

## 大綱

| # | 面向 | 設計 |
|---|------|------|
| 1 | 卡面 | 每卡折疊面 = header（label＋plan 徽章）＋ `topMetric`（該帳號配額比例最高的指標線，沿用既有 CfMetricLine）＋ `N 項 ≥60%` 琥珀 chip；native `<details>` 展開顯示全部 9 指標 |
| 2 | 排序 | `getTodayCfUsage`（自 dashboard route 抽入 cfUsage.ts）分組時計算每卡 `maxRatio`，卡片依 maxRatio 降序（同值按 label） |
| 3 | 資源明細 | 展開區內 `<div hx-get="/cf-usage/detail?label=…">` 由 htmx 拉取公開 HTML fragment（`toggle from:closest details once` 觸發）；fragment = 服務端即時查詢 GraphQL 維度分組 |
| 4 | 即時查詢＋快取 | `cfResources.ts`：每帳號一支含 6 個 dataset 的 GraphQL 維度查詢（今日 UTC 起），**5 分鐘 per-isolate 記憶體快取**（帳號＋label 兩個 Map），**零 D1 寫入** |
| 5 | 名稱解析 | Workers／Pages／R2 名稱 = GraphQL dimension 值直接是名稱（零額外查詢）；D1 databaseId／KV namespaceId 經 REST list（`/d1/database`、`/storage/kv/namespaces`）解析入 `cf_resource_names` 表，30 分鐘 poller 順帶每日刷新一次；解析不到 → 顯示 8 碼短 id＋… |
| 6 | KV id 正規化 | 三種格式並存（kvOps=bare hex、kvStorage=連字號 UUID、REST list=bare hex）→ 一律 `replace(/-/g,'').toLowerCase()` 後 join |
| 7 | 對外 API | `GET /api/cf-usage?account=<label>&detail=1`，`Authorization: Bearer <CF_USAGE_API_TOKEN>`（新 Worker secret，`timingSafeEqual` 常數時間比對、fail-closed 401）；回應**永不**含 account_id／api_token |
| 8 | Token 發佈 | 值存 `~/.config/watch-dog/usage-api-token`（本機明文檔，repo 外）＋ `.dev.vars`（域 A seal）＋ wrangler secret（域 B）；README.md 記載路徑與用法 |

## 已核定決策（操作者 2026-09-11）

- **名稱解析＝擴權全自動**——原以為需 re-mint token 加 D1:Read／KV:Read，**本日實測推翻**：現有 Analytics-scoped token 已可呼叫兩個 REST list（helperp＋gui 兩帳號驗證）。re-mint 相依性消除；403 時名稱退短 id（非故障）。
- **明細頻率＝按需即時查＋5 分鐘快取**——操作者問「同頻 30min 對我們會是負荷？」，量化後（見負載分析）核定 on-demand 方案：明細不進 D1、快取吸收重複查詢。
- **API＝靜態 Bearer token 簡單防護**——操作者原文：「token你寫到我們本地的文件供其它專案讀README.md時一併取得即可，簡單防護且read-only」。
- **負載分析結論「合理」**——操作者覆核批准（見下節）。

## 已實測釘死的 API 合約（2026-09-11，真實 token 逐項驗證）

GraphQL Analytics（`https://api.cloudflare.com/client/v4/graphql`），每帳號一支合併查詢（`limit: 100`）：

| 別名 | dataset | filter | dimension | 彙總 |
|------|---------|--------|-----------|------|
| `wkr` | `workersInvocationsAdaptive`（**非** groups） | `datetime_geq` | `scriptName` | `sum { requests errors }` |
| `pgs` | `pagesFunctionsInvocationsAdaptiveGroups`（**非** `pagesInvocationsAdaptive`——introspection 糾正） | `datetime_geq` | `scriptName`（實值如 `pages-worker--13581012-production`） | `sum { requests }` |
| `d1` | `d1AnalyticsAdaptiveGroups` | `date_geq` | `databaseId`（UUID） | `sum { rowsRead rowsWritten }` |
| `kvo` | `kvOperationsAdaptiveGroups` | `datetimeHour_geq` | `namespaceId`（**bare hex 無連字號**） | `sum { requests }` |
| `kvs` | `kvStorageAdaptiveGroups` | `date_geq` | `namespaceId`（**連字號 UUID**——與 kvo 格式不一致，須正規化） | `max { byteCount keyCount }` |
| `r2s` | `r2StorageAdaptiveGroups` | `date_geq` | `bucketName`（真實 bucket 名直接可得） | `max { payloadSize objectCount }` |

注意：dimensions／sum／max 是**選集欄位**（非引數）；缺 dataset 回應＝零用量非錯誤；`limit: 100` 為單頁假設（艦隊規模遠小於 100，超過即截斷——註解記載）。

REST 名稱解析（**現有 token 即可**，兩帳號實證）：

- `GET /client/v4/accounts/{id}/d1/database?per_page=100` → `result[].{uuid, name}`
- `GET /client/v4/accounts/{id}/storage/kv/namespaces?per_page=100` → `result[].{id, title}`（id = bare hex）

## 負載分析（核定：合理）

- **明細 on-demand**：每帳號最多 1 次 GraphQL／5 分鐘 = **≤288 次/帳號/日**（被快取硬上限，無論端點被 hammer 多兇）；正常人類操作 ≈ 數十次/日。GraphQL Analytics 查詢免費。
- **名稱刷新**：每帳號每日 2 次 REST list（d1＋kv）＋ ≤~20 列 upsert——艦隊 ~160 寫/日 ≈ **0.16%** of 100k 寫額度。單型別空結果（帳號無該資源）會每 poll 重試 REST（表無列、閘不滿足）——每次 2 個免費唯讀 call，可接受，註解記載。
- **fragment／API 的 D1 讀**：label 查帳號（label 快取 5 分）＋名稱表讀（~10 列）——hammer 路徑經兩層快取後 per-isolate 近零 D1 讀。
- **零 cron 變動**：名稱刷新掛在既有 30 分鐘 poll 迴圈（不變式：單一 `* * * * *` trigger 不變）。

## 安全不變式

1. **32-hex account_id 永不出現在公開 HTML／fragment／API 回應**——沿用源頭切斷：fragment 與 API 的回應組裝只碰 label；`ResourceDetail` 型別本身不含 id 欄位（編譯期保證）。測試雙護欄（特定 seed id `not.toContain`＋泛型 `/[0-9a-f]{32}/` regex）。
2. **名稱未解析的短 id 顯示 = 8 碼＋`…`**——不會誤觸 32-hex regex 護欄。
3. **API token 比對 fail-closed**：secret 未設（不可能——required 鏈）或比對失敗一律 401；`timingSafeEqual` 常數時間。
4. **token 值永不進 committed 檔**：`~/.config/watch-dog/usage-api-token`（repo 外）＋ `.dev.vars`（gitignored，seal 入 env.7z）＋ wrangler secret（file-sourced pipe，agent 不經手值）。
5. **明細失敗只降級自身**：fragment 錯誤回 200＋錯誤訊息片段（htmx 預設不 swap 非 2xx）；API detail 每帳號獨立 try/catch 帶 `detail_error`；永不影響首頁狀態 tab 與 fail-dead 路徑。

## Secrets 紀律（新 secret：CF_USAGE_API_TOKEN）

三方同步鏈全走：`.portability.toml [secrets].worker` ↔ `wrangler.jsonc secrets.required` ↔ `src/lib/bindings.ts REQUIRED_BINDING_KEYS`（guard §F/§G/§H 把關）＋ `src/types.ts` Env ＋ `vitest.config.ts` bindings ＋ `.dev.vars.example` ＋ `secrets-archive/SECRETS.md` ＋ `seal.sh` re-seal。

**部署順序（關鍵）**：`wrangler secret put` 先行（既有 worker 可隨時加 secret，無雞蛋問題）→ 再 `wrangler deploy`——順序顛倒會讓 assertBindings 在 secret 就位前殺死全站。

## 已知取捨

- **30s 自動刷新 vs 展開閱讀**：`<details>` 開啟時暫停頁面 reload（hyperscript 條件 `if no document.querySelector('details.cf-expand[open]')`），關閉後下個 tick 恢復——展開讀明細不被打斷。
- **Pages 專案名**：CF 內部部署名 `pages-worker--<id>-production` 原樣顯示（dimension 無 project slug 欄；`Pages:List` 權限未在 token 內、YAGNI）。
- **單頁 100 列**：單帳號單型別 >100 資源即截斷（艦隊規模不會觸及）。
