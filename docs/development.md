# Development Guide

## Prerequisites

- Node.js 22+（package.json `engines`；wrangler 4.x 實測硬擋 <22）
- npm
- Cloudflare account with Workers enabled（D1 額度是帳號級——動 schema/高頻寫入前見全域紀律）
- Wrangler CLI（`npm install` 即含 devDependency；無需全域安裝）

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Wrangler

Bindings live in `wrangler.jsonc`:

```jsonc
{
  "name": "watch-dog",
  "main": "src/index.ts",
  "compatibility_date": "...",
  "d1_databases": [{ "binding": "DB", "database_name": "watch-dog-db", "database_id": "your-database-id" }],
  "triggers": { "crons": ["* * * * *"] }
}
```

Local secrets (e.g. the admin password) go in `.dev.vars` — copy
`.dev.vars.example` to get started.

### 3. Create D1 Database

```bash
npx wrangler d1 create watch-dog-db
```

Copy the `database_id` into your `wrangler.jsonc`.

### 4. Run Migrations

```bash
# Local
npx wrangler d1 execute watch-dog-db --local --file=src/db.sql

# Production
npx wrangler d1 execute watch-dog-db --remote --file=src/db.sql
```

### 5. Set the Admin Credentials（帳密成對）

`/admin` uses Basic Auth with the **account + password pair** — both halves
are verified (username is NOT ignored; `src/middleware/adminAuth.ts`).
Secrets: `ADMIN_ACCOUNT` + `ADMIN_PASSWORD`. Local dev 放 `.dev.vars`（拷
`.dev.vars.example`）；production：

```bash
npx wrangler secret put ADMIN_ACCOUNT   # 帳號
npx wrangler secret put ADMIN_PASSWORD  # 密碼
```

> 歷史注記：2026-09-05 前為單一 `ADMIN_TOKEN`（username 忽略）——已改制，
> `ADMIN_TOKEN` worker secret 已刪。失敗計數鎖定（20 次/15 分/IP）見
> `src/services/loginGuard.ts`。

## Local Development

### Start Dev Server

```bash
npm run dev
```

The server runs at `http://localhost:8787`.

### Type Checking

```bash
npm run typecheck
```

### Run Migrations Locally

```bash
npx wrangler d1 execute watch-dog-db --local --file=src/db.sql
```

### View Local Database

```bash
npx wrangler d1 execute watch-dog-db --local --command "SELECT * FROM checks"
```

## Deployment

### Deploy to Production

```bash
npm run deploy
```

單一部署（wrangler.jsonc 無 `[env]` 區塊——無 preview/staging env）。部署
與維運完整手冊見 [documentation/deployment.md](../documentation/deployment.md)。

## Testing

### Automated Tests

```bash
npm test
```

The suite runs inside workerd via `@cloudflare/vitest-plugin` (workerd-faithful:
D1, cron handler, and the real worker `fetch`), with `@msw/cloudflare`
intercepting outbound Slack API calls. Coverage: alert state machine
(threshold / silence / maintenance / recovery), API auth, admin Basic Auth +
CSRF guard + token masking, and the cron handler.

### Manual Testing Checklist

See [docs/testing.md](testing.md) for the full testing checklist.

### API Testing with curl

```bash
# Set your token
TOKEN="your-project-token-here"
API="http://localhost:8787"

# Update an operator-created project's config（註冊封閉：未知 project 回 404——
# project 由操作者經 /admin 建立，之後才可用本端點改 config）
curl -X PUT $API/api/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "test",
    "display_name": "Test Project",
    "checks": [{
      "name": "health",
      "display_name": "Health Check",
      "type": "heartbeat",
      "interval": 60
    }]
  }'

# Send a pulse
curl -X POST $API/api/pulse \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"check_name": "health", "status": "ok"}'

# Get status
curl $API/api/status
```

### Testing Cron Handler

The cron handler runs every minute. To test:

1. Check that `watch-dog:self-health` check exists
2. Wait 1-2 minutes
3. Verify the check's `last_seen` updates

## Code Style

- Use TypeScript for all new code
- Follow existing naming conventions (camelCase for variables, PascalCase for types)
- Add JSDoc comments for all exported functions
- Keep functions small and focused
- Use prepared statements for all SQL queries

## Project Structure

```
src/
├── index.ts           # Entry point: Hono app（mount 順序＝鑑權架構）+ secureHeaders + fetch/scheduled
├── cron.ts            # Engine tick（dead-check 偵測、self-health、cleanup、輪詢/排程/心跳隔離段）
├── db.sql             # Database schema（冪等真源）
├── types.ts           # TypeScript type definitions
├── routes/
│   ├── api.ts         # Machine API（config / pulse / maintenance / status / cf-usage）
│   ├── admin.ts       # Admin dashboard routes（Basic Auth + CSRF guard 之後）
│   ├── schedules.ts   # Scheduler hub 註冊 API（project token）
│   ├── trigger.ts     # POST /api/engine/trigger（rn1g 第二觸發源）
│   ├── issues.ts      # Issues 收集器（CF webhook ingest / Windmill 車道 / 觀察頁）
│   └── dashboard.ts   # Public read-only dashboard + cf-usage fragment
├── views/
│   ├── layout.ts      # HTML layout + CSS
│   ├── dashboard.ts   # Public dashboard views
│   ├── adminViews.ts  # Admin page views（token/id 面具化）
│   ├── cfDetail.ts    # CF 用量明細 htmx fragment
│   └── issues.ts      # 待處理 log 觀察頁 view
├── middleware/
│   └── adminAuth.ts   # Basic Auth（帳密成對）+ 失敗計數鎖定 + XHR/htmx CSRF check
├── lib/
│   ├── auth.ts        # Constant-time token compare, project auth helpers
│   ├── bindings.ts    # assertBindings（secrets 合約 Layer 2）
│   ├── validate.ts    # charset gate / clamp / LIKE escape
│   └── format.ts      # 指標值格式化
└── services/
    ├── logic.ts       # Check processing state machine（fail-dead 核心）
    ├── alert.ts       # Slack + email-king 雙通道警報
    ├── settings.ts    # D1 settings 表管理
    ├── maintenance.ts # Maintenance mode state transitions
    ├── scheduler.ts   # Dumb ticker：due 排程觸發（HMAC 簽名回呼）
    ├── crossMonitor.ts# ops-control 心跳（engine 蓋章 + fetch piggyback）
    ├── cfUsage.ts     # CF GraphQL Analytics 輪詢與警示
    ├── cfResources.ts # CF 資源明細與名稱刷新
    ├── issues.ts      # Issues 狀態機（ingest/claim/feedback/保險絲）
    └── loginGuard.ts  # admin 失敗計數鎖定（D1）
tests/                 # vitest suite（app pool 跑 workerd 全保真；guards pool 跑架構 guard）
documentation/         # 框架核心文檔集（architecture/flows/permissions/variables/tests/deployment）
docs/                  # Project documentation（api/client-guide/testing 等）
```

## Debugging

### View Real-time Logs

```bash
npx wrangler tail
```

### View Specific Log Types

```bash
# Only errors
npx wrangler tail --format pretty | grep ERROR

# Only cron logs
npx wrangler tail --format pretty | grep Cron
```

### Local Database Inspection

```bash
# List all tables
npx wrangler d1 execute watch-dog-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"

# View checks
npx wrangler d1 execute watch-dog-db --local --command "SELECT * FROM checks"

# View settings
npx wrangler d1 execute watch-dog-db --local --command "SELECT * FROM settings"
```

## Common Issues

### Database Not Found

If you get "database not found" errors:
1. Run migrations: `npx wrangler d1 execute watch-dog-db --file=src/db.sql`
2. Or for local: `npx wrangler d1 execute watch-dog-db --local --file=src/db.sql`

### Cron Not Triggering

Check `wrangler.jsonc` has the cron trigger:
```jsonc
"triggers": { "crons": ["* * * * *"] }
```

### TypeScript Errors

Run `npx tsc --noEmit` to check for type errors without building.

## Contributing

1. Create a feature branch
2. Make your changes
3. Add tests if applicable
4. Ensure TypeScript compiles
5. Submit a pull request
