# 設計 Spec：CF 用量儀表板上首頁（雙 Tab）

**日期**：2026-09-11
**狀態**：待操作者審核
**前提**：CF 用量監控後端已上線（8 帳號、30 分鐘輪詢、`cf_usage_state` 14 天保留；FIX-LOG 2026-09-11 條目）。

## 1. 背景與目標

用量檢視目前藏在 `/admin`（CF 用量 tab 的今日快照表格），操作者要求：**首頁（`/`）直接看到美化的用量儀表板**，`/admin` 維持設定職責不變（快照表**留著**、不退場——2026-09-11 操作者裁定）。

## 2. 已定案決策（操作者裁定，勿重新 litigate）

| 決策 | 結論 |
|---|---|
| 公開程度 | **公開但藏 Account ID**——首頁顯示 label＋用量數值＋進度條，**32-hex account_id 永不出現** |
| 首頁佈局 | **雙 Tab 切換**：「服務狀態」（現有內容原封）＋「CF 用量」（新） |
| /admin | **原樣保留**（含快照表＋帳號 CRUD＋立即輪詢） |

## 3. 架構（方案 A：服務端渲染，零新依賴）

- `GET /`（`dashboard.ts`）擴充：既有 `projects+checks` 查詢外，**同一 handler 併行/序列**加查 `cf_usage_state`（今日）＋ `cf_accounts`（label、plan、last_ok_at）。
- 兩個 pane 一次 server-render 進 `DashboardContent`，Alpine `x-show` 切換（`/admin` tab 同款模式）。
- **不加** fragment 端點、**不加**圖表庫、**不加** CDN 依賴。Pico.css＋少量自訂 CSS。

### 3.1 資料流

```sql
-- 今日快照（PK 前綴掃描，等值查詢，rows_read ≤ 8×9=72）
SELECT s.metric, s.value, s.projected_eod, s.alerted_level, s.updated_at,
       a.label, a.plan, a.last_ok_at
FROM cf_usage_state s JOIN cf_accounts a ON a.account_id = s.account_id
WHERE s.day_utc = date('now') AND a.enabled = 1
ORDER BY a.label, s.metric;
```

- 欄位即 `src/db.sql` 實際 schema（cf_usage_state 不存 quota/pct——**配額由 `cfUsage.ts` 的 `METRICS` registry 按 metric key 派生**，view 層 `pct = value / METRICS[metric].quotas[plan]`，與 poller 同源不重複定義）。
- **view 只拿 label/plan/last_ok_at**——account_id 在 SQL 層就不選進來（源頭斷洩漏，不靠前端遮罩；JOIN 用它但不 SELECT 它）。
- 警報語義直接用 state row 現成的 `alerted_level`（0/1/2）＋`projected_eod`（非 null 且 >quota＝投影超額），**不重算**。

### 3.2 自動刷新

沿用既有機制：`#dashboard` 每 30 秒 `hx-get="/"`＋`location.reload()`（hash 為空才 reload）。**tab 狀態改存 URL hash**（`#status`/`#cf`）：Alpine init 讀 hash 還原 active tab——reload 後停留原 tab、可深連結分享。既有 reload 邏輯不需改（hash 非空本來就 reload）。

## 4. 視圖設計（CF 用量 pane）

### 4.1 版面結構

```
┌──────────────────────────────────────────┐
│ [服務狀態] [CF 用量]        ← tab（hash 綁定）│
├──────────────────────────────────────────┤
│ ▸ CF 用量 pane                            │
│   摘要列：8 帳號監控中 · 最後輪詢 14:30     │
│   ┌─帳號卡─┐ ┌─帳號卡─┐ ┌─帳號卡─┐（RWD 網格）│
│   │ helperp│ │ pm     │ │ ...    │         │
│   │ plan:free 徽章      │                  │
│   │ D1 讀 ████████░░ 62%  ↦投影超額⚠       │
│   │ D1 寫 ███░░░░░░░ 31%                   │
│   │ ...每 metric 一列...                   │
│   └────────┘ └────────┘ └────────┘        │
└──────────────────────────────────────────┘
```

- **帳號卡**：label（大字）＋plan 徽章＋該帳號所有 metric 列。
- **metric 列**：名稱｜現在值（人性化單位：5M/412k/1.2G）｜進度條＋百分比。
- **進度條色階＝警報語義**（實作前跑 dataviz 技能取配色規範，色階鎖定後寫進自訂 CSS）：
  - `<60%`：主色（正常）
  - `60–80%`：警告琥珀
  - `≥80%`：危險紅
  - **投影超額**（projected_eod 超配額）：進度條加條紋樣式＋行尾 ⚠ 標記＋title 顯示預估 EOD 值
- **無配額 metric**（workers_errors、kv_storage_keys、r2_objects）：只顯值，不畫條。
- **空狀態**（無帳號或 state 空）：提示卡「尚未設定監控帳號——到 /admin → CF 用量 新增」（/admin 連結可點，未登入者會 401，可接受）。
- **深色對比**：色階同時驗證淺色主題下可讀（Pico 預設淺色）。

### 4.2 服務狀態 pane

現有 `StatsCards`＋`ProjectGrid` 原封搬進 tab，行為零變更。

## 5. 錯誤處理

- CF 查詢失敗：**只**讓 CF pane 顯示 `ErrorState`（既有組件），服務狀態 pane 照常渲染——兩 pane 各自 try/catch，一個壞不拖累另一個（呼應 cron 的隔離設計）。
- 全頁失敗（projects 查詢炸）：既有 ErrorState 行為不變。

## 6. 測試計畫

| 測試 | 斷言 |
|---|---|
| GET / 渲染 | 雙 tab 按鈕存在；CF pane 含帳號 label 與 metric 名 |
| **藏 ID 護欄**（安全） | 回應 HTML **不含**任何 32-hex account id（seed 已知 id 斷言 `expect(html).not.toContain(seedId)`）；guard 測試移入 tests/guards 池或 app pool 視既有結構 |
| 色階 class | seed 62%/81%/投影超額的 state row → 對應 warn/danger/projected class |
| 空狀態 | 無帳號 → 空狀態提示卡存在、無帳號卡 |
| 無配額 metric | workers_errors 列無進度條 |
| 既有測試 | 全數不變綠（admin 快照表測試不動——admin 沒退場） |

## 7. 明確不做（YAGNI）

- 歷史趨勢圖/折線圖（14 天資料在，但先不做；未來要再加）
- 圖表庫（Chart.js 等）、SPA 框架
- /admin 任何退場或簡化（操作者裁定保留）
- per-metric 深連結、篩選器、排序

## 8. 檔案觸及面

| 檔案 | 變更 |
|---|---|
| `src/routes/dashboard.ts` | GET / 加 CF 查詢＋tab 資料組裝（獨立 try/catch） |
| `src/views/dashboard.ts` | 新 CfUsagePane 組件＋tab 殼；DashboardContent 擴雙 pane；hash 綁定 init |
| `src/views/layout.ts`（或 dashboard view 內） | 進度條/卡片網格自訂 CSS（少量） |
| `tests/dashboard.test.ts`（或新增） | §6 測試 |
| `docs/usage.md` | 首頁新 tab 說明一句 |
