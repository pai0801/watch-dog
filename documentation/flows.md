# flows.md — 負載承重流程（D26 核心集）

> 產出：07-ALL-IN-ONE cycle 2026-11-06（03 §5a）。Anti-PRD：只記觸及 permissions／data-integrity／external-side-effects／ops-safety 的流程。
> 本檔同時涵蓋 cron.md 能力（scheduled job 清查：每分鐘 engine tick，見「偵測引擎 tick 流」）。

## 1. Pulse 上報流（fail-dead 核心）

- **Actor**：受監服務（project token 持有者）＋ watch-dog 引擎。
- **Precondition**：project 已由操作者建立（封閉註冊）、check 已註冊（`PUT /api/config`）。
- **Success**：check 狀態機推進（ok/error），死亡偵測持續有效。
- **步驟**：
  1. `POST /api/pulse`（Bearer token）→ 驗 token（id+token 成對或 token 反查，`src/routes/api.ts:268`）→ check 查無 → 404。
  2. `processCheckResult`（`src/services/logic.ts:69`）：ok 路徑 CAS on `failure_count`（`logic.ts:101`）——併發敗者只推 `last_seen`（pulse 必留痕，不變式①）；error/dead 原子遞增 failure_count。
  3. 狀態轉移 → `dispatchAlert`（`src/services/alert.ts:332`）：Slack 恆發；critical（dead）或 emailWorthy 另寄 email-king。
  4. Log 寫入採樣：recovery/transition 恆寫；steady ok 每小時邊界一筆（`shouldWriteOkLog`，`logic.ts:55`）。
  5. Escalation：15 分鐘窗 ≥3 筆 error → CAS escalated flag → email（`logic.ts:217`）。
- **Trust-boundary crossings**：匿名網路 → project token 邊界（401/403/404 deny）；outbound Slack/email（操作者設定之受信端點）。
- **State changes**：`checks`（status/failure_count/last_seen/escalated）、`logs`（採樣寫入）。
- **冪等性**：重複 pulse 冪等（狀態機非計數器）；CAS 防併發洗掉 error 狀態（TODO #19 已修）。

## 2. 偵測引擎 tick 流（cron，每分鐘）

- **Actor**：CF Cron Triggers（`*/1`）或外部觸發源（rn1g `POST /api/engine/trigger`，TRIGGER_TOKEN）——兩源共用 `runEngineTick`（`src/cron.ts:58`）。
- **Precondition**：D1 schema 已套用（`src/db.sql` 冪等）。
- **Success**：逾期 check 轉 dead＋警報；排程到期的回呼被觸發；心跳新鮮。
- **步驟與隔離分類**（每段獨立 try/catch——invariant ①：附加功能故障不拖垮偵測）：
  1. **Fail-dead 段**（單一 try/catch，`cron.ts:74`）：self-health UPDATE＋採樣 log → `findDeadChecks`（`logic.ts:300`：`type='heartbeat' AND status!='dead' AND monitor=1 AND last_seen+interval+grace<now`，partial index）→ 逐筆 `processCheckResult(dead)` → 每小時 cleanup gate（logs 7 天、cf_usage_state 14 天、issues 保留，`cron.ts:137`）。出錯 → `reportEngineError` 掛號 issue（fingerprint `watch-dog:engine-faildead`，critical；self-dogfood WATCHDOG-016，`cron.ts:26`）。
  2. **CF 用量輪詢**（每 30 分 gate，獨立 try/catch，`cron.ts:165`）→ `pollCfUsage`。
  3. **Scheduler hub**（每 tick，獨立 try/catch，`cron.ts:185`）→ `runDueSchedules`。
  4. **Cross-monitor 心跳**（5 分鐘 gate，獨立 try/catch，`cron.ts:203`）→ 送 ops-control；成功才蓋章（D1 settings key）。
- **Trigger 端去重**：recency guard（self-health last_seen <30s → skip，`src/routes/trigger.ts:47`）；引擎本身冪等。
- **Trust-boundary crossings**：cron 環境（無請求鑑權，平台保證）；trigger 端點 = Bearer secret 邊界（503 fail-closed）。
- **State changes**：`checks`、`logs`、`settings`（心跳蓋章）、`cf_usage_state`、`schedules`、`issues*`。

## 3. Scheduler hub 觸發流

- **Actor**：watch-dog 引擎 → 受監服務的 callback URL。
- **Precondition**：project 以 token 註冊 schedule（`POST /api/schedules`；secret 回傳**恰好一次**，`src/routes/schedules.ts:73`）。
- **Success**：到期回呼送達，target 驗 HMAC 簽名後執行任務。
- **步驟**：
  1. `runDueSchedules`（`src/services/scheduler.ts:117`）：`WHERE paused=0 AND next_run_at<=now ORDER BY next_run_at LIMIT 20`。
  2. **先推進 `next_run_at` 再 fire**（at-most-once per period，`scheduler.ts:131`）。
  3. `fireSchedule`：`POST callback_url` 帶 `X-Schedule-Signature: t=<firedAt>,v1=HMAC-SHA256(secret, "firedAt.scheduleId.scheduledAt")`（timeout 10s；retry_count=1 一次重試，`scheduler.ts:65`）。
  4. 更新 `last_run_at/last_status/consecutive_failures`；failure crossing（恰好等於 alert_after_failures）→ Slack warning（≤5 則/tick，`scheduler.ts:150`）。
- **預算**：≤20 fires×(1+retry)＋5 alerts ＝ ≤45 fetch/tick（Free 50 上限，`scheduler.ts:58`）。
- **SSRF 防線**：封閉註冊模型（操作者建的 project 才能註冊 callback）＋ https-only（`schedules.ts:36`）。
- **State changes**：`schedules`；外部 side effect＝對第三方 URL 的 POST。

## 4. Issues 收集與 Windmill 處置流

- **Actor**：CF Issues Automations（webhook）／受監服務（自評掛號）／ Windmill（rn4g-1）／操作者（issue_map 維護）。
- **信號迴路**：
  - `POST /api/ingest/issues`（`cf-webhook-auth` header ＝ ISSUES_INGEST_TOKEN）→ `parseCfWebhook`（tolerant；fingerprint ＝ alert_correlation_id）→ `ingestIssue`（`src/services/issues.ts:170`）：新指紋 → open＋warning 警報（maintenance 靜音）；resolved 事件 → 關閉＋recovery；done/resolved 再觸發 → regression 新 episode。
  - `POST /api/issues/report`（project token，WATCHDOG-016）：服務自評分級主動掛號。
- **處置迴路**（Windmill，WINDMILL_TOKEN）：
  1. `GET /api/windmill/issues`：listClaimable ＝ open ＋ claimed 超 1800s 的洩漏回收。
  2. `POST /:id/claim`：`attempt_count+1`；**保險絲①**：超過 MAX_AUTO_ATTEMPTS（2）→ escalated＋critical＋email；**保險絲②**：自動設映射專案 maintenance 2700s（issue_map 查 project）。
  3. `POST /:id/feedback`（done/failed/skipped）→ 對應狀態轉移（failed → open 重試或 escalated）。
  4. Windmill 每 poll 呼叫 heartbeat → 自舉 `automation:windmill-pulse` check → 走同一 fail-dead 偵測（Windmill 自己死也會被發現）。
- **Trust boundaries**：CF webhook secret／Windmill Bearer／project token 三面獨立；`GET /issues` 公開面只顯詮釋資料（raw payload 留 DB）。
- **State changes**：`issues`、`issue_events`（審計軌跡）、`projects.maintenance_until`（保險絲②）。

## 5. CF 用量監控流

- **Actor**：引擎（每 30 分鐘 poll）→ 操作者（alert/slack）＋跨專案 consumer（`GET /api/cf-usage`）。
- **步驟**：`pollCfUsage`（`src/services/cfUsage.ts:603`）：enabled 帳號並行（allSettled）→ 每帳號單一 batched GraphQL（5 datasets）→ gauge carry-over（前一天 alerted_level 繼承）→ 單 `db.batch`：upsert＋升級時 CAS claim（changes===1 才 dispatch）→ 閾值警示（warn 60%/投影過額、critical 80%；投影永不 critical）→ 帳號健康 UPDATE → 名稱日刷新（D1/KV REST，replace-set）。
- **Poller 自我警告**：transition-gated（僅 ok→fail 新失敗；全帳號失敗升級 email）。
- **公開面**：首頁/fragment/API 永不 SELECT/渲染 `account_id`（32-hex 洩漏防護）。
- **State changes**：`cf_usage_state`、`cf_accounts`、`cf_resource_names`。

## 6. Cross-monitor 心跳流（互監保險）

- **Actor**：watch-dog → ops-control（獨立 CF 帳號）。
- **語義**：死掉的服務不能訃告自己——watch-dog 死 → 心跳停滯 → ops-control（獨立帳號）告警操作者。
- **路徑**：(a) engine 路徑——5 分鐘 gate（D1 settings 蓋章，跨 isolate 唯一），成功才蓋章（`src/services/crossMonitor.ts:119`）；(b) fetch piggyback——per-isolate 300s 節流（`crossMonitor.ts:82`），免疫 CF cron dispatch 抖動。
- **Known risk**：piggyback 掩蓋「cron 死 fetch 活」failure class（operator decision，`crossMonitor.ts:57` 註解）。
- **State changes**：`settings`（蓋章）；outbound POST。

## 7. Token 生命週期（操作者面）

- 建立：admin 建專案時 server-side 產 24 bytes CSPRNG → 48 hex（`src/routes/admin.ts:202`）；強度 gate ≥16 字元（`admin.ts:725`）。
- 輪替：`POST /admin/projects/:projectId/rotate-token`（舊 token 立即失效，`admin.ts:221`）。
- 下發：操作者經秘密通道交付受監服務（`.env`/secrets）。
- Deny：任何 token 值永不回顯到 HTML/API（admin 面板 mask 尾 4 碼）。
