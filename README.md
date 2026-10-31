# Watch-Dog Sentinel

A serverless, passive monitoring system ("Dead Man's Switch") for distributed microservices — **plus** a cron-trigger hub that wakes your services on a schedule, without giving up a Cloudflare cron slot.

> **Production**: `https://watch-dog.helperp.workers.dev` · public status feed: [`/api/status`](https://watch-dog.helperp.workers.dev/api/status)

## 三大功能

| 功能 | 一句話 | 方向 |
|---|---|---|
| **① 服務監控**（Dead Man's Switch） | 你的服務定期上報 pulse；**pulse 停了 = 服務死了** → Slack（可選 Email）警報 | 你 → watch-dog |
| **② Cron 觸發**（排程樞紐） | 你註冊一個回呼 URL；watch-dog 每分鐘 tick 到期就 POST **叫醒你**——不用自己的 CF cron slot | watch-dog → 你 |
| **③ Issues 收集器**（異常分診） | CF Workers Issues 偵測到你的 Worker 異常 → webhook 推進 watch-dog 分診 → Windmill（rn4g-1）認領自動處置；[待處理觀察頁](https://watch-dog.helperp.workers.dev/issues)一目瞭然 | CF → watch-dog → Windmill |

①② 共用同一個 project token、同一套註冊模型（project 由操作者建立，閉合註冊）。③ 對受監專案**零代碼**——在 CF dashboard 設一次 Automations webhook 即接入（見下節）。可以只挑著用，也可以搭配（例：cron 觸發的任務跑完順手發 pulse，就是一個自帶死亡偵測的排程系統）。

## 客戶端接入（Client Onboarding）

> 你是要被監控的服務？這一段就是全部。完整版（Python/Node 範例、可貼進你 repo 的 agent 指示塊）：[docs/client-guide.md](docs/client-guide.md)。

### 1. 取得 token

**向操作者索取**——操作者跑一行建立你的 project，交付三個環境變數（放進你專案的 `.env` / secrets）：

```bash
WATCHDOG_URL=https://watch-dog.helperp.workers.dev
WATCHDOG_PROJECT=my-service        # 操作者建立時指定的 project id
WATCHDOG_TOKEN=<操作者交付>        # 你的專案身分，[NEVER] commit 進 repo
```

> 註冊不開放自助：`PUT /api/config` 對未知 project 回 404——project 由操作者建立（防陌生人建 check 打警報進 Slack）。

### 2. 定義 checks（首次設定，之後隨時可改）

```bash
curl -X PUT "https://watch-dog.helperp.workers.dev/api/config" \
  -H "Authorization: Bearer $WATCHDOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"my-service","display_name":"我的服務","checks":[{"name":"main","type":"heartbeat","interval":300,"grace":60}]}'
```

### 3. 每輪工作完成時發 pulse（就這一行）

```bash
curl -X POST "https://watch-dog.helperp.workers.dev/api/pulse" \
  -H "Authorization: Bearer $WATCHDOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"check_name":"main","status":"ok"}' --max-time 5
```

**規則一句話**：`interval + grace` 秒沒收到 pulse → 判 DEAD → Slack critical；恢復發 pulse → recovery 通知。pulse 打在「工作完成點」——進程卡死也抓得到（不只是進程死亡）。

驗證（公開免認證）：`curl -s https://watch-dog.helperp.workers.dev/api/status/my-service | jq`

### 4. （操作者可選）Email 警報啟用——經 email-king gateway 雙通道

> 2026-09-05 全程實測通過的 runbook。原則見 email-king README「跨服務憑證交接」
> （持有 VPS SSH 或 watch-dog admin 的 session 即可執行,不必 Peter 本人;
> 唯一人類步驟=收信者看信箱）。

```bash
# ① 在 email-king VPS 合併節點 mint consumer token(明文只出現一次,經管線不落終端)
ssh <vps> 'T=$(grep -E "^API_SECRET_TOKEN=" ~/email-king/.env | cut -d= -f2-) && \
  curl -s -X POST http://localhost:8000/api/v1/consumers \
  -H "Authorization: Bearer admin:$T" -H "content-type: application/json" \
  -d "{\"name\": \"watch-dog\"}"' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'

# ② 存設定到 watch-dog——[MUST] form-encoded + X-Requested-With
#    (WD-03 已修:JSON body 現在回 415 fail-loud,不再靜默存空值)
A=$(grep '^ADMIN_ACCOUNT=' .dev.vars | cut -d= -f2-)
P=$(grep '^ADMIN_PASSWORD=' .dev.vars | cut -d= -f2-)
curl -X POST "https://watch-dog.helperp.workers.dev/admin/settings/email" \
  -u "$A:$P" -H 'X-Requested-With: XMLHttpRequest' \
  --data-urlencode "email_gateway_url=https://ek-gw.96321478.xyz/api/v1/send" \
  --data-urlencode "email_api_token=<①的token>" \
  --data-urlencode "email_recipient=<收件信箱>"

# ③ 測試 → {"ok":true} + 收到信即通
curl -X POST "https://watch-dog.helperp.workers.dev/admin/settings/email-test" \
  -u "$A:$P" -H 'X-Requested-With: XMLHttpRequest'
```

啟用後,任何 check 判死/恢復 = Slack + Email 雙通道。失敗排障:415=② 送成 JSON
(改 form-encoded,WD-03 guard);403=漏 `X-Requested-With`;email-king 側稽核可查
`email_logs WHERE consumer LIKE 'watch-dog%'`。

### 5. （可選）註冊 Cron 觸發——讓 watch-dog 定時叫醒你的服務

不需要自己的 Cloudflare cron slot（Free 帳號只有 5 條，本哨兵帳號已滿）：註冊一個
固定間隔的 HTTPS 回呼，watch-dog 每分鐘 tick 到期就 POST 叫醒你。

**核心設計——dumb ticker**：hub 只負責「按你註冊的間隔叫醒」，不懂你的業務。
精度控制、debounce、冪等都在你端。CF cron tick 本身有延遲（秒～分鐘級），
與其讓 hub 假裝精準，不如目標端用真實時間自己算。

#### 5a. 註冊

```bash
# 註冊（回應中的 secret 只出現這一次，立即保存）
curl -X POST https://watch-dog.helperp.workers.dev/api/schedules \
  -H "Authorization: Bearer $WATCHDOG_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"my-service","name":"hourly-job","callback_url":"https://my-service.example.com/hooks/tick","interval_minutes":60,"retry_count":1,"alert_after_failures":3}'

# 列出 / 修改 / 刪除（?project_id= 一律必帶；改 interval 不重算下次觸發時間，下週期生效）
curl -H "Authorization: Bearer $WATCHDOG_TOKEN" "https://watch-dog.helperp.workers.dev/api/schedules?project_id=my-service"
```

| 參數 | 說明 |
|---|---|
| `interval_minutes` | 觸發間隔，1–10080 分鐘（預設 60）。實際粒度 = 1 分鐘 tick |
| `retry_count` | 0（預設）或 1——失敗當場補一次（註冊方自選，hub 不替你決定） |
| `alert_after_failures` | 預設 0=off；設 N = 連敗跨越 N 時操作者收 Slack warning |
| `paused` | 你自己的維護窗（PUT `{"paused":1}`），回復自助 |

#### 5b. 接收——watch-dog 會 POST 什麼到你家

- Method `POST`、`Content-Type: application/json`
- Header `X-Schedule-Signature: t=<fired_at>,v1=<hex>`，其中
  `v1 = HMAC-SHA256(secret, "<fired_at>.<schedule_id>.<scheduled_at>")`
- Body `{"schedule_id": 7, "scheduled_at": 1760000000, "fired_at": 1760000001}`（unix 秒）

回 `2xx` = ack；非 2xx 或 10 秒 timeout = 記一次失敗。**fire 前已推進下週期**——
失敗的目標等滿一個 interval 才會再被叫（絕不重錘），也**永遠不會被自動暫停**。

驗簽（防偽造/重放，務必做；完整版見 `docs/client-guide.md`）：

```js
async function verifySchedule(request, secret) {
  const m = (request.headers.get('X-Schedule-Signature') ?? '').match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const [, t, v1] = m;
  const { schedule_id, scheduled_at } = await request.json();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${schedule_id}.${scheduled_at}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && hex === v1; // 5 分鐘新鮮度
}
```

#### 5c. 高精度機制——註冊 1 分鐘觸發，自行 10 分鐘執行

這是 dumb ticker 的標準用法：**要「每 10 分鐘跑一次」時，不要註冊
`interval_minutes: 10`，而是註冊 `interval_minutes: 1`，你的 handler 自己記
last-run 時間、距離上次滿 600 秒才真正執行事件。**

```bash
curl -X POST https://watch-dog.helperp.workers.dev/api/schedules \
  -H "Authorization: Bearer $WATCHDOG_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"my-service","name":"every-10min","callback_url":"https://my-service.example.com/hooks/tick","interval_minutes":1}'
```

```js
// 目標端 handler（以 Workers/Durable Object 為例，last_run 持久化在你自己的儲存）
async function handleTick(request, storage) {
  if (!(await verifySchedule(request, SECRET))) return new Response('forbidden', { status: 403 });
  const { fired_at } = await request.json();
  const last = (await storage.get('last_event_at')) ?? 0;
  if (fired_at - last < 600) return new Response('skipped');   // 未滿 10 分鐘——跳過
  await storage.put('last_event_at', fired_at);
  await runMyTenMinuteJob();                                     // 滿 10 分鐘——執行
  return new Response('ok');
}
```

為什麼這樣更好：

- **漏 tick 自動補**——CF cron 偶爾延遲或漏一次，你只是晚一分鐘被叫醒，`fired_at - last >= 600`
  照樣成立，事件照跑；註冊 10 分鐘的話，漏一次 tick = 整個事件晚 10 分鐘。
- **drift 不累積**——用 body 的 `fired_at`（真實時間）算 elapsed，不是「被叫醒幾次 × 間隔」。
- **同一個 handler 多種週期**——註冊一條 1 分鐘 tick，可以同時驅動 10 分鐘/30 分鐘/1 小時
  多個事件（各記各的 last-run）。

粗粒度任務（每小時報表、每天清理）直接註冊對應 interval 即可，不需要這個機制。

完整契約（錯誤碼、失敗語義細節、Python 範例）見 `docs/client-guide.md`；
操作者可隨時用 Basic Auth 看 `GET /admin/schedules` 唯讀總覽（secret 永不回傳）。

### 6.（可選）Issues 異常收集——你的 Worker 異常 log 自動進分診佇列

**你的專案只要滿足一個條件：它是 Cloudflare Worker。零代碼、零 token。**

CF [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) 自動捕捉
uncaught exception / 5xx / `console.error` 並聚合。接入 watch-dog 只需**操作者在 CF dashboard
設定一次**（每個 Worker 一次）：

1. 該 Worker → **Issues** 分頁 → **Automations** → **Add automation**
   （觸發條件建議：occurrence threshold 或 recurrence-after-inactivity 擇一）
2. 目的地選 **Generic Webhook**：
   - URL：`https://watch-dog.helperp.workers.dev/api/ingest/issues`
   - Secret：向操作者索取（= watch-dog 的 `ISSUES_INGEST_TOKEN`；CF 會以
     `cf-webhook-auth` header 送達）
3. 完成。之後 issue 開啟/解決事件自動流入 watch-dog：
   - **開啟** → Slack 警報（若該專案在 maintenance 則靜音——部署窗口不吵）+ 進 Windmill 處置佇列
   - **解決** → 自動關單 + recovery 通知
   - **復發** → 新 episode 重進佇列（嘗試次數歸零）

人類看的入口：[**待處理 log 觀察頁**](https://watch-dog.helperp.workers.dev/issues)——
每筆 issue 的狀態（待處理/處理中/已修復/需人工/CF 已解決）、Windmill 認領標記（⚓ + 時間）、
嘗試次數（n/2）、script 與專案映射，30 秒自動刷新。

處置側（Windmill on rn4g-1）遵守的契約：**[docs/WINDMILL-CONTRACT.md](docs/WINDMILL-CONTRACT.md)**
——poll/claim/write-back 端點、三級處置權限（唯讀診斷與安全動作全自動；prod 部署只開 PR 等人工
merge）、自動處理上限 2 次即 escalate、每輪 poll 附 heartbeat（Windmill 自己也被 fail-dead 監控）。

> **操作者備註**：script → project 映射（`issue_map` 表）決定 claim 時自動進 maintenance 的
> 專案；未映射的 issue 照樣收進觀察頁與 Windmill 佇列，只是不聯動 maintenance。

## Features

- **Passive Monitoring**: Services report heartbeats via simple HTTP API — silence means dead
- **Cron-Trigger Hub (Scheduler)**: registered projects get signed HTTPS callbacks on their interval — one cron slot serves every project; high precision via 1-minute tick + target-side self-throttling
- **Smart Alerting**: Configurable thresholds and cooldowns prevent false alarms
- **Declarative Check Lifecycle**: clients own their full check set via `PUT /api/config` — upsert, replace-set (`checks_replace`) and per-check `monitor` toggle, no admin UI needed
- **Slack Integration**: Rich Block Kit alerts with severity-based channels
- **Maintenance Mode**: Suppress alerts during scheduled maintenance windows
- **Admin Dashboard**: Web UI for managing projects, checks, settings, pulse logs and token lifecycle

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/pai0801/watch-dog.git
cd watch-dog
npm install
```

### 2. Configure Environment

Edit `wrangler.jsonc` with your Cloudflare account details (D1 `database_id`, cron trigger).

### 3. Setup Database

```bash
# Local development
npx wrangler d1 execute watch-dog-db --local --file=src/db.sql

# Production (after `wrangler d1 create watch-dog-db`)
npx wrangler d1 execute watch-dog-db --remote --file=src/db.sql
```

### 4. Set the Admin Credentials

The `/admin` dashboard sits behind HTTP Basic Auth — an account/password pair,
both set as Worker secrets and both verified:

```bash
# Generate a strong password
openssl rand -hex 24

# Set both Worker secrets (prompted interactively)
npx wrangler secret put ADMIN_ACCOUNT
npx wrangler secret put ADMIN_PASSWORD
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and set
`ADMIN_ACCOUNT` / `ADMIN_PASSWORD` there instead.

### 5. Deploy

```bash
npm run deploy
```

### 6. Configure Slack

Visit `https://<your-worker-url>/admin` (browser will ask for the admin
password) and configure your Slack settings. The Slack API token is stored in
D1, never echoed back to the page, and left unchanged when the field is
submitted empty.

## Usage

- **Monitoring a service?** Start with the [Client Guide](docs/client-guide.md) — 30-second integration, copy-paste examples (shell / Node / Python), and a ready-made block for your repo's AI agent.
- **Operating this sentinel?** See the [Operator Guide](docs/usage.md).

### 接入新服務（操作者，一行）

```bash
scripts/enroll.sh my-service 我的服務
```

自動生 token、建 project（**不附任何模板 check**——WD-01：自動 `self` check 等於預約 DEAD 誤報；checks 由 client 的 `PUT /api/config` 宣告）、印出 client 專案要貼的三行 env（`WATCHDOG_URL` / `WATCHDOG_PROJECT` / `WATCHDOG_TOKEN`），並記到 `docs/tokens.local.md`——**同 `.env` 模型**：本地明文（gitignored）＋自動 seal 加密進 `secrets-archive/env.7z`（committed）。token 值不進 committed 明文檔（pre-commit 值級掃描會擋，且 2026-02-02 曾因 docs 內文明 token 付出輪替代價）。

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/pulse` | POST | project token | Report heartbeat |
| `/api/config` | PUT | project token | Update checks（project 須由操作者建立；未知 project 404） |
| `/api/status` | GET | public | Get all statuses |
| `/api/status/:projectId` | GET | public | Get project status |
| `/api/maintenance/:projectId` | POST | project token | Toggle maintenance mode |
| `/api/schedules` | POST | project token | 註冊排程觸發（secret 僅回傳一次） |
| `/api/schedules?project_id=` | GET | project token | 列出自己的排程（不含 secret） |
| `/api/schedules/:id?project_id=` | GET / PUT / DELETE | project token | 查詢 / 修改 / 刪除自己的排程 |
| `/api/cf-usage` | GET | Bearer `CF_USAGE_API_TOKEN` | 唯讀 CF 用量查詢（見下節） |
| `/api/ingest/issues` | POST | `cf-webhook-auth` header（= `ISSUES_INGEST_TOKEN`） | CF Issues Automations webhook 接收端（見 §6） |
| `/api/issues/report` | POST | project token | **掛號 API**：服務自評分級的主動上報（handled error／業務異常；分級指引見 `docs/client-guide.md`）——與 CF Issues 同佇列同 Windmill 車道 |
| `/api/windmill/issues` | GET | Bearer `WINDMILL_TOKEN` | Windmill 拉可認領 issues |
| `/api/windmill/heartbeat` | POST | Bearer `WINDMILL_TOKEN` | Windmill 每輪 poll 心跳（停跳 5 分鐘 → DEAD 警報） |
| `/api/windmill/issues/:id/claim` | POST | Bearer `WINDMILL_TOKEN` | Windmill 認領（映射專案自動 maintenance 45min） |
| `/api/windmill/issues/:id/feedback` | POST | Bearer `WINDMILL_TOKEN` | Windmill 回寫 done/failed/skipped |
| `/issues` | GET | public | 待處理 log 觀察頁（唯讀） |
| `/admin` | GET | Basic Auth (`ADMIN_ACCOUNT`/`ADMIN_PASSWORD`) | Admin dashboard |
| `/admin/schedules` | GET | Basic Auth | 排程樞紐唯讀總覽（secret 永不回傳） |

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

`account` 值請以 URL encode 傳遞（query 解碼會把 `+` 視為空格——label 內字面 `+` 需寫 `%2B`）。

回應：`generated_at`、`quota_reset`（UTC 00:00＝台北 08:00）、`accounts[]`（`label`/`plan`/`last_polled_at`/`metrics[]`：`metric`/`label`/`value`/`quota`/`pct`/`projected_eod`）。`detail=1` 時另帶 `detail.groups[]`（workers/pages/d1/kv/r2 逐資源 `name`＋`metrics`；查詢失敗 → `detail_error`，僅降級該帳號）。**回應永不包含 32-hex account id、資源 id 或任何 token 值**（label／名稱／數字而已）。

**給目標專案 CLAUDE.md 的指示塊**（直接貼上）：

> 要查本專案所在 CF 帳號的配額用量（watch-dog 集中監控）：
> ```bash
> curl -s -H "Authorization: Bearer $(cat ~/.config/watch-dog/usage-api-token)" \
>   "https://watch-dog.helperp.workers.dev/api/cf-usage?account=<LABEL>&detail=1"
> ```
> `<LABEL>` 問操作者（或不帶 `account` 列出全部帳號）。判讀：`metrics[].pct` = 今日已用配額 %（≥60 警戒、≥80 危險）；`projected_eod` = 燃燒速率收盤預估（> `quota` 即將超額）。分析步驟：找 pct 最高與 `projected_eod` 超額的指標 → 對照 `detail.groups` 同型別資源找消耗大戶 → 提出優化建議。注意 `detail=1` 逐帳號即時查詢為序列執行（冷快取最壞 ~N×10 秒）——自動化取用建議帶寬鬆 timeout，或先不帶 `detail` 輪詢、需要時再補查。

## Development

```bash
# Start local development server
npm run dev

# Type checking
npm run typecheck

# Run the test suite (vitest, inside workerd)
npm test

# Deploy to production
npm run deploy
```

## Architecture

```
┌─────────────┐  pulse (上報)   ┌──────────────────┐   callback (叫醒)   ┌─────────────┐
│   Service   │ ──────────────> │  Watch-Dog API  │ ──────────────────> │   Service   │
└─────────────┘                 └────────┬─────────┘   (HMAC 簽名 POST)  └─────────────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │  D1 Database │
                                   └──────┬───────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │                                   │
                        ▼                                   ▼
                  ┌─────────────┐                     ┌─────────┐
                  │  Cron (1/min)│                    │  Slack  │
                  │ 掃逾期+觸發  │                     │ Alerts  │
                  └─────────────┘                     └─────────┘
```

## Documentation

| 你是… | 讀這份 | 內容 |
|---|---|---|
| **要被監控的服務**（維護者 / AI agent） | [docs/client-guide.md](docs/client-guide.md) | 30 秒接入、token 與認證、check 參數（含實際 clamp）、警報路由、shell/Node/Python 範例、agent 指示塊 |
| **watch-dog 操作者** | [docs/usage.md](docs/usage.md) | Admin UI、專案建立、Slack 設定、維護模式、排查 |
| **整合進程式碼** | [docs/api.md](docs/api.md) | 完整 API 參考（端點 / 欄位 / 錯誤碼 / clamp） |
| **開發 / 維護本 repo** | [docs/development.md](docs/development.md) | 環境、測試、框架規範 |
| **手動測試** | [docs/testing.md](docs/testing.md) | 測試程序 |

歷史計畫文件在 `docs/plans/`（記錄用，不反映現況）。

## License

MIT
