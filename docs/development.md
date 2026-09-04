# Development Guide

## Prerequisites

- Node.js 18+
- npm or yarn
- Cloudflare account with Workers enabled
- Wrangler CLI installed globally

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

### 5. Set the Admin Password

`/admin` requires the `ADMIN_TOKEN` secret (Basic Auth password; username
ignored). For local dev put it in `.dev.vars`; for production:

```bash
npx wrangler secret put ADMIN_TOKEN
```

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

### Deploy Specific Environment

```bash
npx wrangler deploy --env production
```

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

# Register a project
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
├── index.ts           # Entry point: Hono app, mounts routes, exports fetch + scheduled
├── cron.ts            # Cron handler (dead-check detection, self-health, log cleanup)
├── db.sql             # Database schema
├── types.ts           # TypeScript type definitions
├── client_example.py  # Reference Python client (see docs/usage.md)
├── routes/
│   ├── api.ts         # Machine API (config / pulse / maintenance / status)
│   ├── admin.ts       # Admin dashboard routes (behind Basic Auth + CSRF guard)
│   └── dashboard.ts   # Public read-only dashboard
├── views/
│   ├── layout.ts      # HTML layout + CSS
│   ├── dashboard.ts   # Public dashboard views
│   └── adminViews.ts  # Admin page views (token masked)
├── middleware/
│   └── adminAuth.ts   # Basic Auth (ADMIN_TOKEN) + XHR/htmx CSRF check
├── lib/
│   └── auth.ts        # Constant-time token compare, project auth helpers
└── services/
    ├── logic.ts       # Check processing state machine
    ├── alert.ts       # Slack alert service
    ├── settings.ts    # Settings management
    └── maintenance.ts # Maintenance mode state transitions
tests/                 # vitest suite (runs inside workerd)
docs/                  # Documentation
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
