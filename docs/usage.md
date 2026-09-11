# Watch-Dog 操作者指南（Usage）

> 本檔給**管理 watch-dog 本身**的操作者。要**接入監控的客戶端專案**請讀 [client-guide.md](client-guide.md)；完整 API 規格見 [api.md](api.md)。

## 服務地址

- **Watch-Dog URL**: `https://watch-dog.helperp.workers.dev/`
- **Admin 管理頁面**: `https://watch-dog.helperp.workers.dev/admin`（Basic Auth——帳號 = `ADMIN_ACCOUNT`、密碼 = `ADMIN_PASSWORD` 兩個 Worker secrets，成對驗證）

## 概述

Watch-Dog Sentinel 是**被動監控系統**（Dead Man's Switch）。服務主動向 Watch-Dog 報告心跳，停止報告 = 觸發 Slack 警報。Cron 每分鐘掃描逾期 check。

### 核心概念

| 概念 | 說明 |
|------|------|
| **Project Token** | 每個專案獨立的 token，客戶端 API 認證用（Bearer only） |
| **Slack API Token / 頻道** | 全域設定，存於 D1 `settings` 表（`/admin` 設定）——**不是** Worker secret |
| **Admin 帳密 (`ADMIN_ACCOUNT`/`ADMIN_PASSWORD`)** | `/admin` 頁面的 Basic Auth 帳號＋密碼（2026-09-05 起成對驗證，取代單一 ADMIN_TOKEN） |
| **Monitor 開關** | 勾選 = 監控該 check；不勾 = 照收 pulse 但不警報 |

> **安全提示**：`/api/maintenance/:projectId` 也需要 Project Token；Slack API Token 在表單只顯示遮罩，留空送出 = 保留現有值。

## 操作流程

### 1) 建立 Project（最快路徑 = 一行）

```bash
scripts/enroll.sh my-service 我的服務
```

自動：openssl 生 token → admin API 建 project（**不附任何模板 check**——WD-01 教訓：自動 `self` check 等於預約 DEAD 誤報；checks 由 client 的 `PUT /api/config` 宣告）→ 印出 client 要貼的三行 env → 記到 `docs/tokens.local.md`（**同 `.env` 模型**：本地明文 gitignored＋自動 seal 加密進 `env.7z`）。也可以手動走 Admin UI（`/admin` → New Project，token 至少 16 字元——server 端強制）。

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

## Admin 管理頁面（五標籤）

### Settings 標籤
- Slack API Token 與頻道 ID（Token 遮罩顯示，留空送出 = 保留）
- **Email Alerts（email-king gateway）**：gateway URL＋consumer token（遮罩、留空保留）＋收件人。email 通道語義（2026-09-10 對稱化後）——**critical（判死）無條件寄**；**warning 在 15 分鐘內第 3 次 error 起升級寄信**（`Service Warning — Sustained`，每集一封）；**recovery 只在該集曾進過信箱（判死或升級）且錯誤窗排空後寄**（有頭有尾各一封）——瞬時 warning 與其恢復僅 Slack（信箱留給真中斷）。token 向操作者索取（email-king 經 SSH mint，見該 repo README「透過 email-king 寄信」節）
- 警報全局靜默期
- **測試警報**：Slack 三顆按鈕（critical／warning／recovery）＋ **📧 Test Email**——各送一通真實訊息，**當場顯示送達成敗**（✓ 或具體錯誤——token 未設、頻道未設、API 拒絕含 email-king 錯誤碼）——修完設定按一下就知道通了沒

### Projects 標籤
- 查看所有專案（含 token 遮罩）、建立、刪除（刪除連同 checks/logs）
- **New Project 對話框「🎲 產生」**：server 端生 48-hex token（與 `scripts/enroll.sh` 同款）
- **Rotate Token**：輪替專案 token——舊值立即失效，新值**只顯示一次**（modal）；記得同步 client env 與本機 `docs/tokens.local.md`
- Mute 1h / Unmute（維護模式）

### Checks 標籤
- 查看所有 check 狀態（依專案過濾、可展開）
- **Monitor checkbox**：勾選 = 監控、不勾 = 暫停
- 編輯（interval/grace/threshold/cooldown）、刪除

### Logs 標籤
- 最近 pulse 歷史（`logs` 表，cron 每 7 天清除）：時間／check／狀態／latency／訊息
- 依專案過濾＋筆數上限（50/100/200）

### CF 用量標籤（2026-09-11 起）
全 CF 帳號的配額監控（9/7 log cleanup、9/11 countRecentErrors 兩次 D1 額度事故的事後 500 → 事前預警）：
- **輪詢節奏**：既有每分鐘 cron 在 handler 內閘控（`% 1800 < 60`，與每小時 cleanup 同機制）——**零新增 cron trigger**，每 30 分鐘輪詢一次全部啟用帳號；每支 token 一支 GraphQL 查詢（五個 dataset 合併），互為並行
- **監控指標（9 項/帳號）**：D1 rows 讀/寫、Workers 請求/錯誤、KV 操作、KV 儲存 bytes/keys、R2 儲存 bytes/物件數；免費額度查 `METRICS` registry（paid plan 對映預留）
- **警示語義**：已用 ≥60% → 警告（Slack）；≥80% → 危險（Slack＋**email**）；counter 類依燃燒速率**預估今日超額** → 警告（含預估觸頂時間，額度 UTC 00:00＝台北 08:00 重置）。日內只升不降、每指標每級恰一次；**無 recovery 告警**（額度重置非事件）
- **▶ 立即輪詢**：手動觸發一次，回 `polled/recorded/alerts/failures` 摘要——**onboarding 逐帳號驗 token 的工具**
- **新增帳號**：Account ID（32 hex）＋Label＋API Token＋Plan。Token 到各帳號 dash.cloudflare.com → My Profile → API Tokens → Create Custom Token，**僅 Account→Analytics: Read、單帳號 scope**；遮罩顯示、留空=保留（同 Slack/Email token 合約）
- **自我監控**：token 失效/網路錯只在「ok→fail 轉換」時寄一則 Slack 自我警告（死 token 不會洗版）；全部帳號同時失敗才寄信
- **成本紀律**：監控自身用量 ≈80 rows read + ≈80 rows written /poll（48 polls/day ≈ 0.08% 讀 / 3.8% 寫額度）——監控自己在 host 帳號的 `d1_rows_read/written` 曲線上是特徵不是 bug

## Zero Trust（Cloudflare Access）前置規劃

操作者計畫在 edge 加 Cloudflare Access（Zero Trust）防護。與本系統的關係：

- **建議範圍**：至少涵蓋 `/admin*`；更保守可整域（dashboard 與 `/api/status` 為公開唯讀，machine API `/api/pulse` 等需要 client 直連——若整域上 Access，**client 的 pulse 會被擋**，需為 machine API 路徑設 bypass 或用 Service Auth token）。
- **與 Basic Auth 的關係**：Access（edge 的 SSO/email 驗證）在前、Basic Auth（`ADMIN_ACCOUNT`/`ADMIN_PASSWORD`）在後——兩層保留，Access 上線後 Basic Auth 就是第二層縱深，不需移除。
- **程式面**：無需改碼。Access 驗證通過後會帶 `Cf-Access-User` 等 header，未來若想把 admin 身分從 Basic Auth 換成 Access 身分再另行規劃。

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
3. **Admin 帳密輪替** — 換值後 `wrangler secret put ADMIN_ACCOUNT`／`ADMIN_PASSWORD`＋所有瀏覽器需重新輸入
