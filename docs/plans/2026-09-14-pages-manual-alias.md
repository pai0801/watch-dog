# BUILD-PLAN — Pages 專案手動別名（admin 命名面板）

> tier: **major**（>5 檔：cfResources/admin/adminViews/db.sql + 2 測試檔）— 02-BUILD-SPEC §1.5

THINK:
1. ROOT CAUSE:     操作者追問「`pages-worker #14766800` 到底是哪個專案」——#編號標籤只解決了
                   「多列可區分」，沒解決「這是哪個專案」。CF API 四個面已實證無法反查
                   （2026-09-14，見 2026-09-14-pages-name-fix-and-projection-alerts.md），
                   自動歸因死路；唯一可行=操作者手動命名一次，比對 CF dashboard 各專案的
                   Functions 請求數字（今天/昨天數字好認）。
2. CORRECT LAYER:  儲存=既有 cf_resource_names（新 resource_type='pages'，resource_id=原始
                   scriptName——每日 replace-set 刷新只碰 d1/kv，不會蓋掉手動列）；
                   讀取=cfResources loadNames→parseResourceDetail（alias 優先、#標籤回退）；
                   管理=admin 帳號列「Pages 別名」按鈕→modal 面板（列出近兩日 Pages 列
                   +今天/昨天請求數+每列一個儲存格）。
3. AFFECTED FILES: src/services/cfResources.ts、src/routes/admin.ts、
                   src/views/adminViews.ts、src/db.sql（註解）、tests/{cfResources,admin}.test.ts。
                   爆破半徑：NameResourceType 加 'pages'（loadNames/parse 各一處）；
                   detail 快取（5 min TTL）在 alias 儲存後需失效→新 invalidateDetailCache。
4. ASSUMPTIONS:    最可能錯的：「scriptName 編號長期穩定」——觀察資料（今日/昨日同列同編號）
                   支持穩定；若 CF 改版編號會變，alias 失效回退 #標籤，無資料損壞風險。
5. SIMPLER PATH:   重用 cf_resource_names 與 admin modal 既有 idiom（edit modal/red fragment/
                   parseBody），零新表、零新中介層——已是最小路。
6. RISK:           alias 是操作者輸入→hono/html 內插自動轉義（XSS 防線既有）；長度上限 100；
                   script_name 白名單 regex（^pages-worker--\d+-(production|preview)$）防亂寫 key。
                   admin 面（Basic Auth 後）顯示 account_id 與原始 scriptName 合規。
7. VERDICT:        PROCEED（操作者已選手動別名方案）

## User Story

**As a** 操作者,
**I want** 在 admin 對每個 Pages 內部編號填一次專案名（對照 dashboard 請求數字）,
**so that** 明細的 Pages 列直接顯示專案名，一眼知道誰在燒請求。

### Acceptance Criteria

1. AC1：admin 帳號列有「Pages 別名」按鈕→modal 列出該帳號近兩日所有 Pages 列（原始 scriptName、今天/昨天請求數）＋每列 alias 輸入框；輸入框預帶已存別名。
2. AC2：儲存後 cf_resource_names 落一列（type='pages'）；首頁/API 明細該列顯示別名（detail 快取即時失效）；清空儲存=刪除別名、回退 #編號顯示；每日名稱刷新不影響 pages 列。
3. AC3：make ci 全綠（新增：alias 儲存/刪除/格式驗證 admin 測試 + alias 優先於 #標籤的解析測試）。

## 變更檔案

| # | 檔案 | 變更 |
|---|---|---|
| 1 | src/services/cfResources.ts | NameResourceType +'pages'；loadNames 收 pages；pages 命名 alias 優先；export isPagesScriptName + invalidateDetailCache |
| 2 | src/routes/admin.ts | GET/POST /admin/cf-usage/accounts/:id/pages-aliases（renderPagesAliasPanel 共用） |
| 3 | src/views/adminViews.ts | Actions 列加「Pages 別名」按鈕 |
| 4 | src/db.sql | cf_resource_names 註解補 pages 手動別名 |
| 5 | tests×2 | cfResources：alias 優先/回退、fetch 層解析；admin：面板渲染、儲存、刪除、格式拒絕 |
