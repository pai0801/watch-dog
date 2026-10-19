# Scheduler Hub（排程觸發樞紐）設計文件

> 日期：2026-10-19
> 狀態：已與操作者討論定案（本文記錄目標與大綱；實作計畫見 `2026-10-19-scheduler-hub-plan.md`）
> tier：**major**（新增 load-bearing flow + D1 schema + >5 檔，見 02-BUILD-SPEC §1.5）

## 1. 目標（為什麼做）

Cloudflare Workers Free 帳號的 cron trigger 上限是 **5 條/account**，本帳號（helperp）已滿——
2026-09-23 watch-dog 被迫從每分鐘放寬成每 5 分鐘（`wrangler.jsonc` 註解）；`~/Code` 有 20+ 個
專案在搶 cron slot（dev-brain `ef457dc42d3a`：兩次 deploy code 10072 事故）。

解法：把 watch-dog 升級成**排程觸發樞紐（scheduler hub）**——受監專案向 watch-dog 註冊
「固定間隔回呼」，watch-dog 的既有 cron tick 到期就主動 POST 叫醒對方。1 條（既有的）cron
slot 服務全部專案，註冊方不再需要自己的 cron。

## 2. 核心設計決策（與操作者確認定案）

| 決策 | 結論 | 理由 |
|---|---|---|
| 部署位置 | **併進 watch-dog 本體**（方案 A） | 零新增 cron slot；重用 D1／project token／Slack 警報／註冊模型 |
| hub 角色 | **dumb ticker**——只負責按註冊間隔叫醒目標，不懂業務 | 介面最窄的深模組；精度控制、debounce、冪等、漏 tick 自癒全在目標端；hub 永不需為滿足某專案的排程需求而改 |
| 註冊管理 | **專案自助**（既有 project token），admin **唯讀觀察、不可改** | 權限模型乾淨：admin 面向零寫入端點 |
| 失敗語義 | **fire 前推進 `next_run_at = now + interval`**（at-most-once per period）；**無自動暫停**；`retry_count`（0/1）與 `alert_after_failures`（0=off）由註冊方自選 | 暫停的 job 是靜默失效，比持續失敗可見更危險；hub 的角色是讓失敗顯形，不是替目標做決策；「成功才推進」會每 tick 重錘剛死掉的目標 |
| 認證通道 | HTTP callback + **HMAC-SHA256 簽名**（Stripe 式 `t=...,v1=...` header） | 跨帳號通用、防偽造、防重放；同帳號未來要優化再加 service binding |
| 觸發契約 | POST JSON `{schedule_id, scheduled_at, fired_at}`；2xx = ack | 目標端用 `scheduled_at`/`fired_at` 算 elapsed，drift 不累積 |
| tick 粒度 | cron `*/5` → `*/1` | dumb ticker 模型要支援「註冊 1 分鐘＋自行節流」的高精度 pattern；頻率放寬不佔用額外 slot（上限計條數，getkm `ef457dc42d3a` 實證） |
| 高精度 pattern | 註冊 `interval_minutes=1`，目標端自己記 last-event 時間、自行判斷是否觸發對應事件 | CF cron 本身有延遲，與其讓 hub 假裝精準，不如目標端用真實時間算 |

## 3. 架構大綱

```
註冊專案 ──(Bearer token)──> POST/GET/PUT/DELETE /api/schedules   [routes/schedules.ts]
                                │ D1 schedules 表（schema 真源 src/db.sql）
cron */1 tick ──> scheduled handler [cron.ts]
                  ├─ (既有) fail-dead 偵測＋自我監控     ← 不變式①，零改動
                  ├─ (既有) hourly cleanup / 30-min usage poll
                  └─ (新增) runDueSchedules()            [services/scheduler.ts]
                       ├─ SELECT due (paused=0, next_run_at<=now) LIMIT 20
                       ├─ 先推進 next_run_at（at-most-once）
                       ├─ POST callback（HMAC 簽名、10s timeout、可選重試 1 次）
                       ├─ 記錄 last_status / consecutive_failures
                       └─ 跨過 alert_after_failures → Slack warning（≤5/tick）

admin ──(Basic Auth)──> GET /admin/schedules               [routes/admin.ts，唯讀、secret 永不回傳]
```

## 4. 額度與安全預算（設計時算死）

- **External subrequests**：free 上限 50/invocation。每 tick 最多 20 fires × (1+retry 1) + 5 條
  Slack 警報 = **45 ≤ 50**。超出 due 的 job 排下一分鐘（`ORDER BY next_run_at`，late-but-fired）。
- **D1**：每 tick 1 條 due SELECT（rows_read = 排程數）；fire 才寫（2 updates/fire）。遠低於
  免費額度——符合 D1 額度紀律（動手前估算、帳號級後爆型）。
- **secret**：per-schedule HMAC secret 為 D1 runtime 資料（同 `cf_accounts.api_token` 先例，
  非 Worker secret，不動 `.portability.toml`）；建立時回傳一次，之後永不回傳（admin 查詢直接
  不 SELECT 該欄）。
- **不變式①保護**：scheduler 在 scheduled handler 內走獨立 try/catch（比照 usagePoll 先例），
  絕不在 fail-dead 路徤之前，且內部 `Promise.allSettled` 不外拋。

## 5. 爆破半徑

- 動到：`src/db.sql`、`src/cron.ts`、`src/index.ts`（mount route）、`src/types.ts`、
  `src/routes/admin.ts`（+1 唯讀 GET）、`wrangler.jsonc`（cron 頻率）、`tests/utils.ts`。
- 新增：`src/services/scheduler.ts`、`src/routes/schedules.ts`、`tests/schedules.test.ts`。
- 文件同步（D16/D35/D36）：README、`docs/api.md`、`docs/client-guide.md`、`docs/testing.md`、
  `FIX-LOG.md`、`CLAUDE.md`/`AGENTS.md`（職責變寬標註）。
- 回滾：模組整段移除 + `DROP TABLE schedules`；schema 全冪等（`IF NOT EXISTS`），無遷移負擔。

## 6. 驗收摘要（完整 AC 見 plan 的 user-story）

1. 專案用 token 可 CRUD 自己的 schedule，看不見也改不了別人的。
2. 到期排程收到帶 HMAC 簽名的 POST；2xx 記 ok。
3. fire 前推進 `next_run_at`——失敗的目標不會被每 tick 重錘。
4. `retry_count=1` 失敗當場補一次；`alert_after_failures` 跨越時發 Slack warning；無自動暫停。
5. admin 可唯讀總覽（secret 永不出現），無任何寫入端點。
6. 高精度 pattern（註冊 1 分鐘＋自行節流）與驗簽範例寫進 client 文件。
