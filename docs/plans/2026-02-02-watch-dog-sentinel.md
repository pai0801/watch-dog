# Watch-Dog Sentinel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a serverless passive monitoring system (Dead Man's Switch) that receives heartbeats from distributed services and alerts when they fail to report.

**Architecture:** Cloudflare Workers + Hono framework with D1 database for state. Services POST heartbeats to `/api/pulse`. A Cron trigger runs every minute to find "dead" checks (missed heartbeats) and triggers alerts via Slack API. Dashboard uses HTMX polling for auto-refresh.

**Tech Stack:** Cloudflare Workers, Hono v4, D1 (SQLite), TypeScript, HTMX, Alpine.js, Pico.css, Slack Web API

---

## Environment Variables (from .env)

- `CLOUDFLARE_API_TOKEN` - Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `SLACK_API_TOKEN` - Slack Bot Token (xoxb-*)
- `SLACK_CHANNEL_CRITICAL` - Channel ID for critical alerts
- `SLACK_CHANNEL_SUCCESS` - Channel ID for recovery notifications
- `SLACK_SILENCE_PERIOD_SECONDS` - Silence period for duplicate alerts

---

## Task 1: Create D1 Database

**Files:**
- Create: `wrangler.jsonc` (modify existing)

**Step 1: Create D1 database**

Run:
```bash
export CLOUDFLARE_API_TOKEN="<REDACTED 2026-09-04 — 此文件曾明文洩漏現役 token（detect-secrets baseline 掃描發現）；值已從工作樹移除，git 歷史仍有舊值 → 舊 token [MUST] 於 CF dashboard 作廢輪替（見 secrets-archive/SECRETS.md 與 FIX-LOG 2026-09-04 條目）>"
export CLOUDFLARE_ACCOUNT_ID="c8be0aed8df53afd214770b0130ec55e"
npx wrangler d1 create watch-dog-db
```

Expected output: Database created with `database_id`

**Step 2: Update wrangler.jsonc with D1 binding and Cron**

Add to `wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "watch-dog",
  "main": "src/index.tsx",
  "compatibility_date": "2026-01-28",

  [[d1_databases]]
  binding = "DB"
  database_name = "watch-dog-db"
  database_id = "<from-step-1-output>"

  [triggers]
  crons = ["* * * * *"]

  "assets": {
    "binding": "ASSETS",
    "directory": "./public"
  },
  "observability": {
    "enabled": true
  }
}
```

**Step 3: Commit**

```bash
git add wrangler.jsonc
git commit -m "feat: add D1 binding and cron trigger to wrangler config"
```

---

## Task 2: Create Database Schema

**Files:**
- Create: `src/db.sql`

**Step 1: Write the schema**

Create `src/db.sql`:
```sql
-- Projects table: manages tokens and global maintenance state
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    display_name TEXT NOT NULL,
    slack_webhook TEXT,
    maintenance_until INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Checks table: defines rules and current state
CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT,
    type TEXT NOT NULL,

    -- SLA rules
    interval INTEGER DEFAULT 300,
    grace INTEGER DEFAULT 60,
    threshold INTEGER DEFAULT 1,
    cooldown INTEGER DEFAULT 900,

    -- State
    last_seen INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ok',
    failure_count INTEGER DEFAULT 0,
    last_alert_at INTEGER DEFAULT 0,
    last_message TEXT,

    FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Logs table (periodically cleaned)
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id TEXT NOT NULL,
    status TEXT NOT NULL,
    latency INTEGER,
    message TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Indexes for query optimization
CREATE INDEX IF NOT EXISTS idx_checks_project ON checks(project_id);
CREATE INDEX IF NOT EXISTS idx_logs_check_id ON logs(check_id);
```

**Step 2: Run migration (local)**

Run:
```bash
npx wrangler d1 execute watch-dog-db --local --file=src/db.sql
```

Expected: Tables created successfully

**Step 3: Run migration (production)**

Run:
```bash
npx wrangler d1 execute watch-dog-db --file=src/db.sql
```

Expected: Tables created successfully

**Step 4: Insert test project**

Run:
```bash
npx wrangler d1 execute watch-dog-db --local --command="INSERT INTO projects (id, token, display_name) VALUES ('test-project', 'test-token-123', 'Test Project')"
```

**Step 5: Commit**

```bash
git add src/db.sql
git commit -m "feat: create D1 database schema with projects, checks, and logs tables"
```

---

## Task 3: Create Types

**Files:**
- Create: `src/types.ts`

**Step 1: Write type definitions**

Create `src/types.ts`:
```typescript
export interface Env {
  DB: D1Database;
  SLACK_API_TOKEN: string;
  SLACK_CHANNEL_CRITICAL: string;
  SLACK_CHANNEL_SUCCESS: string;
  SLACK_SILENCE_PERIOD_SECONDS?: string;
}

export interface Project {
  id: string;
  token: string;
  display_name: string;
  slack_webhook: string | null;
  maintenance_until: number;
  created_at: number;
}

export interface Check {
  id: string;
  project_id: string;
  name: string;
  display_name: string | null;
  type: 'heartbeat' | 'event';
  interval: number;
  grace: number;
  threshold: number;
  cooldown: number;
  last_seen: number;
  status: 'ok' | 'error' | 'dead';
  failure_count: number;
  last_alert_at: number;
  last_message: string | null;
}

export interface Log {
  id: number;
  check_id: string;
  status: string;
  latency: number | null;
  message: string | null;
  created_at: number;
}

export interface PulsePayload {
  check_name: string;
  status?: 'ok' | 'error';
  message?: string;
  latency?: number;
}

export interface CheckConfig {
  name: string;
  display_name: string;
  type: 'heartbeat' | 'event';
  interval?: number;
  grace?: number;
  threshold?: number;
  cooldown?: number;
}

export interface ConfigPayload {
  checks: CheckConfig[];
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add TypeScript type definitions"
```

---

## Task 4: Create Slack Alert Service

**Files:**
- Create: `src/services/alert.ts`

**Step 1: Write Slack service**

Create `src/services/alert.ts`:
```typescript
import { Env } from '../types';

export interface SlackAttachment {
  color: string;
  title: string;
  text: string;
  footer: string;
  ts: number;
}

export interface SlackMessage {
  channel: string;
  attachments: SlackAttachment[];
}

const COLORS = {
  CRITICAL: '#ff0000',
  RECOVERY: '#36a64f',
  WARNING: '#ffcc00',
};

export async function sendSlackAlert(
  env: Env,
  level: 'CRITICAL' | 'RECOVERY' | 'WARNING',
  title: string,
  details: string,
  checkId: string
): Promise<void> {
  try {
    const channel = level === 'RECOVERY'
      ? env.SLACK_CHANNEL_SUCCESS
      : env.SLACK_CHANNEL_CRITICAL;

    const color = level === 'CRITICAL'
      ? COLORS.CRITICAL
      : level === 'RECOVERY'
        ? COLORS.RECOVERY
        : COLORS.WARNING;

    const payload: SlackMessage = {
      channel,
      attachments: [
        {
          color,
          title: `[${level}] ${title}`,
          text: details,
          footer: `Watch-Dog | ${checkId}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SLACK_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json() as { ok: boolean; error?: string };

    if (!result.ok) {
      console.error('Slack API error:', result.error);
    }
  } catch (e) {
    console.error('Failed to send Slack alert', e);
  }
}

export function isInSilencePeriod(
  lastAlertAt: number,
  silencePeriodSeconds: number,
  now: number
): boolean {
  if (lastAlertAt === 0) return false;
  return (now - lastAlertAt) < silencePeriodSeconds;
}
```

**Step 2: Commit**

```bash
git add src/services/alert.ts
git commit -m "feat: add Slack alert service with API integration"
```

---

## Task 5: Create Alert Logic Service

**Files:**
- Create: `src/services/logic.ts`

**Step 1: Write state machine logic**

Create `src/services/logic.ts`:
```typescript
import { D1Database } from '@cloudflare/workers-types';
import { Env, Check, Project } from '../types';
import { sendSlackAlert, isInSilencePeriod } from './alert';

export async function processCheckResult(
  db: D1Database,
  env: Env,
  check: Check,
  project: Project,
  newStatus: 'ok' | 'error' | 'dead',
  message: string,
  latency: number = 0
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const silencePeriod = parseInt(env.SLACK_SILENCE_PERIOD_SECONDS || '3600', 10);

  let failureCount = check.failure_count;
  let lastAlertAt = check.last_alert_at;
  let shouldAlert = false;
  let alertType: 'CRITICAL' | 'RECOVERY' = 'CRITICAL';

  // 1. Status determination logic
  if (newStatus === 'ok') {
    // Recovery: if previously failed and threshold was met
    if (check.status !== 'ok' && failureCount >= check.threshold) {
      alertType = 'RECOVERY';
      shouldAlert = true;
      lastAlertAt = now;
    }
    failureCount = 0;
  } else {
    // Error or Dead
    failureCount += 1;

    // Check if should alert:
    // A. Not in maintenance mode
    // B. Failure count >= threshold
    // C. Outside silence period
    const inMaintenance = project.maintenance_until > now;
    const hitThreshold = failureCount >= check.threshold;
    const outsideSilence = !isInSilencePeriod(lastAlertAt, silencePeriod, now);

    if (!inMaintenance && hitThreshold && outsideSilence) {
      alertType = 'CRITICAL';
      shouldAlert = true;
      lastAlertAt = now;
    }
  }

  // 2. Update database
  await db
    .prepare(
      `UPDATE checks SET
        status = ?,
        last_seen = ?,
        failure_count = ?,
        last_alert_at = ?,
        last_message = ?
      WHERE id = ?`
    )
    .bind(newStatus, now, failureCount, lastAlertAt, message, check.id)
    .run();

  // 3. Write log
  await db
    .prepare(
      `INSERT INTO logs (check_id, status, latency, message, created_at)
      VALUES (?, ?, ?, ?, ?)`
    )
    .bind(check.id, newStatus, latency, message, now)
    .run();

  // 4. Send notification
  if (shouldAlert) {
    await sendSlackAlert(
      env,
      alertType,
      `${project.display_name}: ${check.display_name || check.name}`,
      `${message} (Failures: ${failureCount})`,
      check.id
    );
  }
}

export async function findDeadChecks(
  db: D1Database,
  now: number
): Promise<Array<Check & { project_name: string; maintenance_until: number; slack_webhook: string | null }>> {
  const result = await db
    .prepare(
      `SELECT c.*, p.display_name as project_name, p.maintenance_until, p.slack_webhook
      FROM checks c
      JOIN projects p ON c.project_id = p.id
      WHERE c.type = 'heartbeat'
      AND c.status != 'dead'
      AND (c.last_seen + c.interval + c.grace) < ?`
    )
    .bind(now)
    .all();

  return result.results as any;
}
```

**Step 2: Commit**

```bash
git add src/services/logic.ts
git commit -m "feat: add state machine logic for check processing"
```

---

## Task 6: Create API Routes

**Files:**
- Create: `src/index.tsx` (main entry point)
- Modify: `src/index.ts` (replace existing)

**Step 1: Rename index.ts to index.tsx**

Run:
```bash
mv src/index.ts src/index.tsx.bak
```

**Step 2: Write the main application with API routes**

Create `src/index.tsx`:
```tsx
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { html } from 'hono/html';
import { Env, CheckConfig, PulsePayload } from './types';
import { processCheckResult, findDeadChecks } from './services/logic';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Health check
app.get('/', (c) => c.text('Watch-Dog Sentinel Active 🟢'));

// API: Register/update check configuration (upsert)
app.put('/api/config', async (c) => {
  const token = c.req.header('Authorization')?.split(' ')[1];
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const project = await c.env.DB
    .prepare('SELECT * FROM projects WHERE token = ?')
    .bind(token)
    .first();

  if (!project) {
    return c.json({ error: 'Invalid Token' }, 403);
  }

  try {
    const body = await c.req.json() as { checks: CheckConfig[] };
    const checks = body.checks || [];

    for (const check of checks) {
      const checkId = `${project.id}:${check.name}`;
      const exists = await c.env.DB
        .prepare('SELECT 1 FROM checks WHERE id = ?')
        .bind(checkId)
        .first();

      if (exists) {
        await c.env.DB
          .prepare(
            `UPDATE checks SET display_name = ?, type = ?, interval = ?, grace = ?, threshold = ?, cooldown = ?
            WHERE id = ?`
          )
          .bind(
            check.display_name,
            check.type,
            check.interval || 300,
            check.grace || 60,
            check.threshold || 1,
            check.cooldown || 900,
            checkId
          )
          .run();
      } else {
        await c.env.DB
          .prepare(
            `INSERT INTO checks (id, project_id, name, display_name, type, interval, grace, threshold, cooldown)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            checkId,
            project.id,
            check.name,
            check.display_name,
            check.type,
            check.interval || 300,
            check.grace || 60,
            check.threshold || 1,
            check.cooldown || 900
          )
          .run();
      }
    }

    return c.json({ success: true, count: checks.length });
  } catch (e) {
    return c.json({ error: 'Invalid JSON', details: String(e) }, 400);
  }
});

// API: Receive heartbeat pulse
app.post('/api/pulse', async (c) => {
  const token = c.req.header('Authorization')?.split(' ')[1];
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const project = await c.env.DB
    .prepare('SELECT * FROM projects WHERE token = ?')
    .bind(token)
    .first() as any;

  if (!project) {
    return c.json({ error: 'Invalid Token' }, 403);
  }

  try {
    const body = await c.req.json() as PulsePayload;
    const checkId = `${project.id}:${body.check_name}`;

    const check = await c.env.DB
      .prepare('SELECT * FROM checks WHERE id = ?')
      .bind(checkId)
      .first() as any;

    if (!check) {
      return c.json({ error: 'Check not found (please register first)' }, 404);
    }

    const status = body.status === 'ok' ? 'ok' : 'error';

    await processCheckResult(
      c.env.DB,
      c.env,
      check,
      project,
      status,
      body.message || 'OK',
      body.latency || 0
    );

    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Invalid JSON', details: String(e) }, 400);
  }
});

// API: Maintenance mode toggle
app.post('/api/maintenance/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const duration = Number(c.req.query('duration')) || 0;
  const until = Math.floor(Date.now() / 1000) + duration;

  await c.env.DB
    .prepare('UPDATE projects SET maintenance_until = ? WHERE id = ?')
    .bind(until, projectId)
    .run();

  return c.json({ success: true, mode: duration > 0 ? 'maintenance' : 'active' });
});

// API: Get all projects and checks (for dashboard)
app.get('/api/status', async (c) => {
  const { results: projects } = await c.env.DB
    .prepare('SELECT * FROM projects ORDER BY id')
    .all();

  const { results: checks } = await c.env.DB
    .prepare('SELECT * FROM checks ORDER BY id')
    .all();

  return c.json({ projects, checks });
});

export default {
  fetch: app.fetch,
};
```

**Step 3: Test locally**

Run:
```bash
npm run dev
```

In another terminal:
```bash
# Test health check
curl http://localhost:8787/

# Test pulse with invalid token
curl -X POST http://localhost:8787/api/pulse -H "Authorization: Bearer invalid" -H "Content-Type: application/json" -d '{"check_name":"test"}'

# Test with valid token
curl -X POST http://localhost:8787/api/pulse -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d '{"check_name":"worker_health","status":"ok","message":"OK","latency":50}'
```

**Step 4: Commit**

```bash
git add src/index.tsx src/index.tsx.bak
git commit -m "feat: add core API routes for pulse, config, and maintenance"
```

---

## Task 7: Add Cron Trigger Handler

**Files:**
- Modify: `src/index.tsx`

**Step 1: Add scheduled export to index.tsx**

Add to end of `src/index.tsx` (before `export default`):

```tsx
// Cron Trigger: Find dead checks every minute
export const scheduled = async (
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> => {
  ctx.waitUntil(
    (async () => {
      const now = Math.floor(Date.now() / 1000);

      try {
        const deadChecks = await findDeadChecks(env.DB, now);

        for (const check of deadChecks) {
          const project = {
            id: check.project_id,
            display_name: check.project_name,
            maintenance_until: check.maintenance_until,
            slack_webhook: check.slack_webhook,
          };

          await processCheckResult(
            env.DB,
            env,
            check,
            project,
            'dead',
            `Heartbeat missed! Last seen: ${now - check.last_seen}s ago`
          );
        }

        // Clean old logs (7 days)
        await env.DB
          .prepare('DELETE FROM logs WHERE created_at < ?')
          .bind(now - 604800)
          .run();
      } catch (e) {
        console.error('Cron error:', e);
      }
    })()
  );
};

export default {
  fetch: app.fetch,
  scheduled,
};
```

**Step 2: Add MissingEvent type import**

Add to top of file with other imports:
```tsx
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { html } from 'hono/html';
import type { ScheduledEvent } from '@cloudflare/workers-types';
```

**Step 3: Commit**

```bash
git add src/index.tsx
git commit -m "feat: add cron trigger for dead check detection"
```

---

## Task 8: Create Dashboard UI Components

**Files:**
- Modify: `src/index.tsx` (add dashboard routes and components)

**Step 1: Add UI components and dashboard route**

Add to `src/index.tsx` after the imports:

```tsx
// --- UI Components (JSX) ---

const Layout = (props: { children: any; title?: string }) => html`
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${props.title || 'Watch-Dog Sentinel'}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <script src="//unpkg.com/alpinejs" defer></script>
  <style>
    :root { --primary: #e63946; --spacing: 1rem; }
    .status-ok { color: #2ecc71; }
    .status-error { color: #e74c3c; }
    .status-dead { color: #95a5a6; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
    article { min-height: 200px; }
    .time-display { font-size: 0.8rem; opacity: 0.7; }
  </style>
</head>
<body class="container" style="padding-top: 2rem;">
  <nav>
    <ul>
      <li><strong>🐶 Watch-Dog Sentinel</strong></li>
    </ul>
    <ul>
      <li><a href="/" class="secondary">Refresh</a></li>
    </ul>
  </nav>
  <main id="main-content">
    ${props.children}
  </main>
</body>
</html>
`;

const ProjectCard = (project: any, checks: any[]) => {
  const now = Math.floor(Date.now() / 1000);
  const isMaintenance = project.maintenance_until > now;

  return html`
  <article x-data="{ formatTime(ts) { return ts ? new Date(ts * 1000).toLocaleString() : '-' } }">
    <header style="display:flex; justify-content:space-between; align-items:center;">
      <h3 style="margin:0">${project.display_name}</h3>
      ${isMaintenance ? html`<small aria-label="Maintenance Mode">🚧 Maintenance</small>` : ''}
    </header>

    <table role="table">
      <thead>
        <tr>
          <th>Check</th>
          <th>Status</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody>
        ${checks.map((c) => html`
          <tr>
            <td>
              <strong>${c.display_name || c.name}</strong><br>
              <small>${c.last_message || '-'}</small>
            </td>
            <td>
              ${c.status === 'ok'
                ? html`<ins class="status-ok">OK</ins>`
                : c.status === 'dead'
                  ? html`<del class="status-dead">DEAD</del>`
                  : html`<u class="status-error">ERR (${c.failure_count})</u>`}
            </td>
            <td>
              <small class="time-display" x-text="formatTime(${c.last_seen})"></small>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <footer>
      <details>
        <summary>Actions</summary>
        <div class="grid">
          <button
            class="secondary outline"
            hx-post="/api/maintenance/${project.id}?duration=600"
            hx-swap="none"
            _="on htmx:after-request if window.confirm('Maintenance enabled for 10 minutes') then add .disabled to me">
            Maintenance 10m
          </button>
          <button
            class="contrast outline"
            hx-post="/api/maintenance/${project.id}?duration=0"
            hx-swap="none">
            Disable Maintenance
          </button>
        </div>
      </details>
    </footer>
  </article>
`;
};
```

**Step 2: Replace the existing root route with dashboard route**

Replace the `app.get('/', ...)` route:

```tsx
// Dashboard (HTMX Polling)
app.get('/', async (c) => {
  const { results: projects } = await c.env.DB
    .prepare('SELECT * FROM projects ORDER BY id')
    .all();

  const { results: checks } = await c.env.DB
    .prepare('SELECT * FROM checks ORDER BY id')
    .all();

  const content = html`
    <div class="card-grid" hx-get="/" hx-trigger="every 30s" hx-select=".card-grid" hx-swap="outerHTML">
      ${projects.map((p: any) => {
        const pChecks = (checks as any[]).filter((c) => c.project_id === p.id);
        return ProjectCard(p, pChecks);
      }).join('')}
    </div>
  `;

  if (c.req.header('HX-Request')) {
    return c.html(content);
  }
  return c.html(<Layout>{content}</Layout>);
});
```

**Step 3: Remove the old health check route**

Delete or move the old `app.get('/', (c) => c.text('...'))` route.

**Step 4: Commit**

```bash
git add src/index.tsx
git commit -m "feat: add dashboard UI with HTMX polling and Alpine.js"
```

---

## Task 9: Create Python Client SDK

**Files:**
- Create: `src/client_example.py`

**Step 1: Write Python client**

Create `src/client_example.py`:
```python
#!/usr/bin/env python3
"""Watch-Dog Sentinel Client SDK

Usage:
    wd = WatchDog("https://watchdog.your-domain.com", "your-project-token")

    # Register checks on startup
    wd.register([
        {
            "name": "worker_health",
            "display_name": "Worker Process Check",
            "type": "heartbeat",
            "interval": 60,
            "grace": 10,
            "threshold": 3,
            "cooldown": 600
        }
    ])

    # Send pulse periodically
    wd.pulse("worker_health", status="ok", latency=50)
"""

import requests
import time
from typing import List, Dict, Optional, Literal


class WatchDog:
    """Client for Watch-Dog Sentinel monitoring system."""

    def __init__(self, base_url: str, project_token: str, timeout: int = 5):
        """
        Initialize the WatchDog client.

        Args:
            base_url: Base URL of the Watch-Dog Sentinel service
            project_token: Project token for authentication
            timeout: Request timeout in seconds (default: 5)
        """
        self.base_url = base_url.rstrip('/')
        self.token = project_token
        self.timeout = timeout
        self.headers = {
            "Authorization": f"Bearer {project_token}",
            "Content-Type": "application/json"
        }

    def register(
        self,
        checks: List[Dict],
        timeout: Optional[int] = None
    ) -> bool:
        """
        Register check definitions with the Sentinel service.

        This method is idempotent - it will update existing checks
        and create new ones as needed.

        Args:
            checks: List of check configuration dictionaries
            timeout: Override default timeout for this request

        Returns:
            True if successful, False otherwise
        """
        payload = {"checks": checks}

        try:
            response = requests.put(
                f"{self.base_url}/api/config",
                json=payload,
                headers=self.headers,
                timeout=timeout or self.timeout
            )
            response.raise_for_status()
            print(f"[WatchDog] Config synced: {response.status_code}")
            return True
        except requests.RequestException as e:
            print(f"[WatchDog] Register failed: {e}")
            return False

    def pulse(
        self,
        check_name: str,
        status: Literal["ok", "error"] = "ok",
        message: str = "OK",
        latency: int = 0,
        timeout: Optional[int] = None
    ) -> bool:
        """
        Send a heartbeat pulse for a specific check.

        This method is designed to be non-blocking - any errors
        are caught and logged without raising exceptions.

        Args:
            check_name: Name of the check (must match registered name)
            status: "ok" or "error"
            message: Optional status message
            latency: Optional latency in milliseconds
            timeout: Override default timeout for this request

        Returns:
            True if successful, False otherwise
        """
        payload = {
            "check_name": check_name,
            "status": status,
            "message": message,
            "latency": latency
        }

        try:
            requests.post(
                f"{self.base_url}/api/pulse",
                json=payload,
                headers=self.headers,
                timeout=timeout or self.timeout
            )
            return True
        except requests.RequestException:
            # Monitoring should not crash the main application
            print(f"[WatchDog] Pulse failed (non-fatal)")
            return False


# Decorator for automatic heartbeat monitoring
def heartbeat(
    watchdog: WatchDog,
    check_name: str,
    message: str = "OK"
):
    """
    Decorator that automatically sends a pulse after function execution.

    Usage:
        @heartbeat(wd, "worker_health")
        def my_task():
            # do work
            pass
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            start = time.time()
            try:
                result = func(*args, **kwargs)
                latency = int((time.time() - start) * 1000)
                watchdog.pulse(check_name, "ok", message, latency)
                return result
            except Exception as e:
                watchdog.pulse(check_name, "error", str(e))
                raise
        return wrapper
    return decorator


# --- Example Usage ---
if __name__ == "__main__":
    # Configure for your environment
    wd = WatchDog(
        base_url="http://localhost:8787",  # Change to your deployed URL
        project_token="test-token-123"      # Change to your project token
    )

    # 1. Register checks on startup (idempotent - can be called every time)
    wd.register([
        {
            "name": "worker_health",
            "display_name": "Worker Process Health",
            "type": "heartbeat",
            "interval": 60,
            "grace": 10,
            "threshold": 3,
            "cooldown": 600
        },
        {
            "name": "database_check",
            "display_name": "Database Connectivity",
            "type": "heartbeat",
            "interval": 300,
            "grace": 30,
            "threshold": 2,
            "cooldown": 900
        }
    ])

    # 2. Send pulse in a loop
    print("Starting heartbeat loop... (Ctrl+C to stop)")
    try:
        while True:
            start = time.time()

            # ... do your checks here ...

            latency = int((time.time() - start) * 1000)
            wd.pulse("worker_health", status="ok", message="Healthy", latency=latency)
            print(f"Pulse sent (latency: {latency}ms)")

            time.sleep(60)  # Send pulse every 60 seconds
    except KeyboardInterrupt:
        print("\nStopped")
```

**Step 2: Test the Python client**

Run:
```bash
python3 src/client_example.py
```

**Step 3: Commit**

```bash
git add src/client_example.py
git commit -m "feat: add Python client SDK with decorator support"
```

---

## Task 10: Final Testing and Deployment

**Files:**
- None (testing and deployment)

**Step 1: Test locally with full flow**

Run:
```bash
npm run dev
```

Test script:
```bash
# 1. Check dashboard
curl http://localhost:8787/

# 2. Register a check
curl -X PUT http://localhost:8787/api/config \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{
    "checks": [{
      "name": "test_check",
      "display_name": "Test Check",
      "type": "heartbeat",
      "interval": 60,
      "grace": 10,
      "threshold": 2,
      "cooldown": 300
    }]
  }'

# 3. Send a pulse
curl -X POST http://localhost:8787/api/pulse \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"check_name": "test_check", "status": "ok", "message": "All good", "latency": 42}'

# 4. Get status
curl http://localhost:8787/api/status
```

**Step 2: Deploy to production**

Run:
```bash
npx wrangler deploy
```

**Step 3: Update production database**

Run:
```bash
npx wrangler d1 execute watch-dog-db --file=src/db.sql
npx wrangler d1 execute watch-dog-db --command="INSERT INTO projects (id, token, display_name) VALUES ('production', 'YOUR_SECURE_TOKEN', 'Production Project')"
```

**Step 4: Configure secrets in production**

Run:
```bash
npx wrangler secret put SLACK_API_TOKEN
# Enter: your_slack_bot_token_here

npx wrangler secret put SLACK_CHANNEL_CRITICAL
# Enter: your_critical_channel_id

npx wrangler secret put SLACK_CHANNEL_SUCCESS
# Enter: your_success_channel_id

npx wrangler secret put SLACK_SILENCE_PERIOD_SECONDS
# Enter: 3600
```

**Step 5: Verify deployment**

Visit your deployed Worker URL and check the dashboard loads.

**Step 6: Final commit**

```bash
git add .
git commit -m "chore: complete initial Watch-Dog Sentinel implementation"
```

---

## Summary

This plan implements the complete Watch-Dog Sentinel system:

1. **Infrastructure**: D1 database with Cron triggers
2. **Core Logic**: State machine with thresholds, cooldowns, maintenance mode
3. **API**: Config registration, pulse endpoint, maintenance toggle
4. **Dashboard**: Real-time UI with HTMX polling
5. **Client SDK**: Python library with decorator support

**Total estimated steps:** 43 individual commits
