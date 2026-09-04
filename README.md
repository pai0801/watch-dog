# Watch-Dog Sentinel

A serverless, passive monitoring system ("Dead Man's Switch") for distributed microservices. Services report heartbeats to the Sentinel, and if they stop reporting, alerts are triggered.

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
git clone https://github.com/paipeter0801/watch-dog.git
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

See [docs/usage.md](docs/usage.md) for detailed usage instructions and client integration examples.

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

- [Usage Guide](docs/usage.md) - User documentation and client integration
- [API Documentation](docs/api.md) - Complete API reference
- [Development Guide](docs/development.md) - Setup and development instructions
- [Testing Checklist](docs/testing.md) - Manual testing procedures

## License

MIT
