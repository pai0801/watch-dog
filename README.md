# Watch-Dog Sentinel

A serverless, passive monitoring system ("Dead Man's Switch") for distributed microservices. Services report heartbeats to the Sentinel, and if they stop reporting, alerts are triggered.

> **Production**: `https://watch-dog.helperp.workers.dev` · public status feed: [`/api/status`](https://watch-dog.helperp.workers.dev/api/status)

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

### 4. Set the Admin Password

The `/admin` dashboard sits behind HTTP Basic Auth (any username; the password
is the `ADMIN_TOKEN` Worker secret):

```bash
# Generate a strong password
openssl rand -hex 24

# Set it as a Worker secret (prompted interactively)
npx wrangler secret put ADMIN_TOKEN
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and set `ADMIN_TOKEN`
there instead.

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

自動生 token、建 project（含 `self` check）、印出 client 專案要貼的三行 env（`WATCHDOG_URL` / `WATCHDOG_PROJECT` / `WATCHDOG_TOKEN`），並記到本地 `docs/tokens.local.md`（**gitignored**——private repo 也不把 token 值寫進 committed 檔：本 repo 的 pre-commit 值級掃描會擋，且 2026-02-02 曾因 docs 內文明 token 付出輪替代價）。

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/pulse` | POST | project token | Report heartbeat |
| `/api/config` | PUT | project token | Register project/checks |
| `/api/status` | GET | public | Get all statuses |
| `/api/status/:projectId` | GET | public | Get project status |
| `/api/maintenance/:projectId` | POST | project token | Toggle maintenance mode |
| `/admin` | GET | Basic Auth (`ADMIN_TOKEN`) | Admin dashboard |

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
