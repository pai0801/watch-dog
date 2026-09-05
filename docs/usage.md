# Watch-Dog 操作者指南（Usage）

> 本檔給**管理 watch-dog 本身**的操作者。要**接入監控的客戶端專案**請讀 [client-guide.md](client-guide.md)；完整 API 規格見 [api.md](api.md)。

## 服務地址

- **Watch-Dog URL**: `https://watch-dog.helperp.workers.dev/`
- **Admin 管理頁面**: `https://watch-dog.helperp.workers.dev/admin`（Basic Auth，密碼 = `ADMIN_TOKEN` Worker secret，用戶名任意）

## 概述

Watch-Dog Sentinel 是**被動監控系統**（Dead Man's Switch）。服務主動向 Watch-Dog 報告心跳，停止報告 = 觸發 Slack 警報。Cron 每分鐘掃描逾期 check。

### 核心概念

| 概念 | 說明 |
|------|------|
| **Project Token** | 每個專案獨立的 token，客戶端 API 認證用（Bearer only） |
| **Slack API Token / 頻道** | 全域設定，存於 D1 `settings` 表（`/admin` 設定）——**不是** Worker secret |
| **Admin 密碼 (`ADMIN_TOKEN`)** | `/admin` 頁面的 Basic Auth 密碼（這才是 Worker secret） |
| **Monitor 開關** | 勾選 = 監控該 check；不勾 = 照收 pulse 但不警報 |

> **安全提示**：`/api/maintenance/:projectId` 也需要 Project Token；Slack API Token 在表單只顯示遮罩，留空送出 = 保留現有值。

## 操作流程

### 1) 建立 Project（最快路徑 = 一行）

```bash
scripts/enroll.sh my-service 我的服務
```

自動：openssl 生 token → admin API 建 project（含預設 `self` check）→ 印出 client 要貼的三行 env → 記到 `docs/tokens.local.md`（gitignored 本地清單）。也可以手動走 Admin UI（`/admin` → New Project，token 至少 16 字元——server 端強制）。

> **註冊已關閉（2026-09-05）**：`PUT /api/config` 不再能建立新 project（未知 project 回 404）。
> 客戶端拿到的是「操作者已建立專案的 token」——用它更新自己的 checks、發 pulse。
> 原因：開放註冊 = 任何知道 URL 的人都能建 check → 不發 pulse → 判死警報打進你的 Slack（警報通道虐待面）。
> Token 值[NEVER]寫進 committed 檔（private repo 也不）——本 repo pre-commit 有值級掃描，且 2026-02-02 曾在 docs 內文明付出輪替代價；本地翻 `docs/tokens.local.md`。

Token 交接給客戶端專案時走該專案的 secrets 管理管道（如各 repo 的 env-tools / secrets-archive 模式），[NEVER] 明文 commit。

### 2) 設定 Slack

`/admin` → Settings 標籤：API Token（`xoxb-…`）、critical / success / warning / info 四個頻道 ID、靜默期秒數。

> 現況（2026-09-05）：四頻道＋token 已設定完成，警報鏈已實測（判死 → critical 送達、恢復 → success 送達）。

### 3) 客戶端接入

把 [client-guide.md](client-guide.md) 給客戶端專案的維護者（或其 agent）——裡面有 30 秒最小閉環、三種語言範例、和可直接貼進 client repo CLAUDE.md 的 agent 指示塊。

## Admin 管理頁面

### Settings 標籤
- Slack API Token 與頻道 ID（Token 遮罩顯示，留空送出 = 保留）
- 警報全局靜默期

### Projects 標籤
- 查看所有專案、建立、刪除（刪除連同 checks/logs）

### Checks 標籤
- 查看所有 check 狀態
- **Monitor checkbox**：勾選 = 監控、不勾 = 暫停
- 編輯（interval/grace/threshold/cooldown）、刪除

## 檢查參數（含實際 clamp）

| 參數 | 說明 | 預設 | 實際範圍 |
|------|------|------|---------|
| **Type** | `heartbeat` = 定期心跳（會判死）；`event` = 只在 error 回報時警報 | — | 二選一 |
| **Interval** | 心跳間隔（秒） | 300 | clamp 10–300 |
| **Grace** | 寬限期（秒），超過 interval+grace 無 pulse 才判死 | 60 | clamp 0–60 |
| **Threshold** | 連續失敗次數門檻 | 1 | **固定 1**（clamp 1–1） |
| **Cooldown** | 同 check 警報冷卻（秒）；>0 覆蓋全局靜默期 | 900 | clamp 0–900 |
| **Monitor** | 勾選 = 監控 | 1 | — |

## 維護模式

排程維護時靜音整個 project（客戶端也可用自己的 token 呼叫，見 client-guide）：

```bash
curl -X POST "https://watch-dog.helperp.workers.dev/api/maintenance/my-service" \
  -H "Authorization: Bearer PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"duration":3600}'
```

## 故障排查（操作者視角）

### 沒有收到 Slack 通知？
1. `/admin` Settings 的 Slack API Token 是否有效、頻道 ID 是否正確
2. 該 check 的 Monitor 是否勾選
3. 該 project 是否在維護模式
4. 是否仍在 cooldown / 全局靜默期內
5. `wrangler tail watch-dog` 觀察 cron 執行——`[Slack]` 前綴的 console.error 即送信失敗原因

### Check 一直顯示 DEAD？
1. 客戶端確實在發 pulse？（`/api/status/<project_id>` 看 `last_seen`）
2. interval 是否設得比客戶端實際發送週期短

## 安全建議

1. **Token 保密** — 不 commit 進 repo，走環境變數 / secrets 管理管道
2. **Token 強度** — 至少 16 字元隨機值
3. **ADMIN_TOKEN 輪替** — 換值後 `wrangler secret put ADMIN_TOKEN`＋所有瀏覽器需重新輸入
