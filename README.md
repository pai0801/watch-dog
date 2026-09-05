# Watch-Dog Sentinel

A serverless, passive monitoring system ("Dead Man's Switch") for distributed microservices. Services report heartbeats to the Sentinel, and if they stop reporting, alerts are triggered.

> **Production**: `https://watch-dog.helperp.workers.dev` · public status feed: [`/api/status`](https://watch-dog.helperp.workers.dev/api/status)

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

## Features

- **Passive Monitoring**: Services report heartbeats via simple HTTP API
- **Smart Alerting**: Configurable thresholds and cooldowns prevent false alarms
- **Slack Integration**: Rich Block Kit alerts with severity-based channels
- **Maintenance Mode**: Suppress alerts during scheduled maintenance windows
- **Admin Dashboard**: Web UI for managing projects, checks, and settings
- **Self-Monitoring**: Built-in health check for the monitoring system itself

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

自動生 token、建 project（含 `self` check）、印出 client 專案要貼的三行 env（`WATCHDOG_URL` / `WATCHDOG_PROJECT` / `WATCHDOG_TOKEN`），並記到 `docs/tokens.local.md`——**同 `.env` 模型**：本地明文（gitignored）＋自動 seal 加密進 `secrets-archive/env.7z`（committed）。token 值不進 committed 明文檔（pre-commit 值級掃描會擋，且 2026-02-02 曾因 docs 內文明 token 付出輪替代價）。

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/pulse` | POST | project token | Report heartbeat |
| `/api/config` | PUT | project token | Update checks（project 須由操作者建立；未知 project 404） |
| `/api/status` | GET | public | Get all statuses |
| `/api/status/:projectId` | GET | public | Get project status |
| `/api/maintenance/:projectId` | POST | project token | Toggle maintenance mode |
| `/admin` | GET | Basic Auth (`ADMIN_ACCOUNT`/`ADMIN_PASSWORD`) | Admin dashboard |

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
┌─────────────┐     pulse      ┌──────────────────┐
│   Service   │ ──────────────> │  Watch-Dog API  │
└─────────────┘                 └────────┬─────────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │  D1 Database │
                                   └──────┬───────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │                                   │
                        ▼                                   ▼
                  ┌─────────┐                         ┌─────────┐
                  │  Cron   │                         │  Slack  │
                  │ (1/min) │                         │ Alerts  │
                  └─────────┘                         └─────────┘
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
