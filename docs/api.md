# Watch-Dog Sentinel API Documentation

Base URL: `https://watch-dog.helperp.workers.dev`

> 客戶端專案的快速接入請從 [client-guide.md](client-guide.md) 開始；本檔是完整 API 參考。

## Authentication

Machine API requests authenticate with the project token as a Bearer token
(the legacy `X-Project-Token` header was removed 2026-09-04 — Bearer only):

```
Authorization: Bearer your-project-token-here
```

Each project has its own unique token, which you can generate in the Admin Dashboard.

The `/admin` dashboard is separate: it sits behind HTTP Basic Auth where the
password is the `ADMIN_TOKEN` Worker secret (username is ignored).

---

## Endpoints

### POST /api/pulse

Report a heartbeat pulse from a service.

**Request:**
```http
POST /api/pulse
Authorization: Bearer your-project-token
Content-Type: application/json

{
  "check_name": "database-health",
  "status": "ok",
  "message": "Database responding in 12ms",
  "latency": 12
}
```

**Request Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| check_name | string | Yes | Name of the check |
| status | string | No | "ok" or "error" (default: "ok") |
| message | string | No | Optional message |
| latency | number | No | Latency in milliseconds |

**Response:**
```json
{
  "success": true,
  "check_id": "my-service:database-health",
  "status": "ok",
  "timestamp": 1738464000
}
```

**Error Responses:**

| Status | Description |
|--------|-------------|
| 400 | Bad Request (invalid JSON, missing check_name) |
| 401 | Unauthorized (missing token) |
| 403 | Forbidden (invalid token) |
| 404 | Not Found (check not registered) |

---

### PUT /api/config

Update project and check configurations. **Registration is closed** (2026-09-05):
the project must already exist (created by the operator via `/admin`) — an
unknown `project_id` returns 404. An existing project additionally requires its
own token (403 on mismatch).

**Request:**
```http
PUT /api/config
Authorization: Bearer your-project-token
Content-Type: application/json

{
  "project_id": "my-service",
  "display_name": "My API Service",
  "checks": [
    {
      "name": "health",
      "display_name": "Health Check",
      "type": "heartbeat",
      "interval": 60,
      "grace": 10,
      "threshold": 3,
      "cooldown": 300
    }
  ]
}
```

**Request Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| project_id | string | Yes | Unique project identifier (lowercase, numbers, hyphens) |
| display_name | string | Yes | Human-readable name |
| checks | array | Yes | Array of check configurations |

**Check Config Fields**（defaults and actual clamps — out-of-range values are silently clamped, invalid entries silently skipped; trust `checks_registered` in the response）:

| Field | Type | Default | Accepted | Description |
|-------|------|---------|----------|-------------|
| name | string | - | `[a-z0-9-]` style, validated | Check name (unique within project) |
| display_name | string | - | - | Display name |
| type | string | - | `heartbeat` \| `event` | Others are skipped |
| interval | number | 300 | clamped 10–300 | Pulse interval (seconds), heartbeat only |
| grace | number | 60 | clamped 0–60 | Grace period (seconds) |
| threshold | number | 1 | clamped 1–1 (fixed at 1) | Failures before alert |
| cooldown | number | 900 | clamped 0–900 | Alert cooldown (seconds); 0 = use global silence |
| monitor | 0 \| 1 | 1 | 0 or 1 | 0 = accept pulses but never alert; omit to keep the stored value |

**Top-level payload fields:**

| Field | Type | Description |
|-------|------|-------------|
| checks_replace | boolean | Replace-set semantics: this project's checks NOT listed in `checks` — and their logs — are deleted. **漏列即刪.** Default `false` (pure upsert). Scoped to this project only. |

> Note: `threshold` is currently pinned to 1 by the server-side clamp — sending `3` behaves as `1`.

**Response:**
```json
{
  "success": true,
  "project_id": "my-service",
  "message": "Configuration updated",
  "checks_registered": 1,
  "checks_deleted": 0
}
```

**Error Responses:** 400 (invalid body/charset) · 401 (no token) · 403 (wrong token) · **404 (unknown project — registration is closed, ask the operator)**

---

### GET /api/status

Get all projects and their check statuses.

**Response:**
```json
{
  "projects": [
    {
      "id": "my-service",
      "display_name": "My API Service",
      "maintenance_until": 0,
      "in_maintenance": false,
      "checks": [
        {
          "id": "my-service:health",
          "name": "health",
          "display_name": "Health Check",
          "type": "heartbeat",
          "status": "ok",
          "last_seen": 1738464000,
          "is_stale": false
        }
      ]
    }
  ],
  "timestamp": 1738464000
}
```

---

### GET /api/status/:projectId

Get status for a specific project.

**Response:**
```json
{
  "project": {
    "id": "my-service",
    "display_name": "My API Service",
    "in_maintenance": false
  },
  "checks": [...],
  "timestamp": 1738464000
}
```

---

### POST /api/maintenance/:projectId

Toggle maintenance mode for a project (suppresses alerts during maintenance).

**Requires the project token** (`Authorization: Bearer ...`) — unauthenticated
callers cannot mute alerts.

**Request:**
```http
POST /api/maintenance/my-service
Authorization: Bearer your-token
Content-Type: application/json

{
  "enabled": true,
  "duration": 3600
}
```

**Request Fields:**

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | true to enable, false to disable |
| duration | number | Duration in seconds (when enabling) |

**Response:**
```json
{
  "success": true,
  "project_id": "my-service",
  "maintenance_mode": true,
  "maintenance_until": 1738467600
}
```

---

### GET /api/cf-usage

Read-only CF quota usage feed for cross-project automation (other repos' Claude Code). Requires the static usage token — **not** a project token.

**Request:**
```http
GET /api/cf-usage?account=helperp&detail=1
Authorization: Bearer <CF_USAGE_API_TOKEN>
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| account | string | Optional. Filter to one account by label (unknown label → 404) |
| detail | string | Optional. `1` = include per-resource detail (live GraphQL query, 5-min per-isolate cache) |

**Response:**
```json
{
  "generated_at": 1738464000,
  "quota_reset": "UTC 00:00 (Taipei 08:00)",
  "accounts": [
    {
      "label": "helperp",
      "plan": "free",
      "last_polled_at": 1738463000,
      "metrics": [
        { "metric": "d1_rows_read", "label": "D1 rows 讀取", "value": 1000000, "quota": 5000000, "pct": 20, "projected_eod": null }
      ],
      "detail": {
        "label": "helperp",
        "fetchedAt": 1738464000,
        "groups": [
          { "type": "d1", "title": "D1 Databases", "items": [ { "name": "watch-dog-db", "metrics": { "d1_rows_read": 900000, "d1_rows_written": 5000 } } ] }
        ]
      }
    }
  ]
}
```

`quota`/`pct` are `null` for record-only metrics (no free-tier quota). With `detail=1`, each account also carries `detail.groups[]` (type ∈ workers/pages/d1/kv/r2, one group per resource type) listing per-resource `items` (`name` + `metrics`); a per-account fetch failure yields `detail_error` on that account only. Status codes: 401 = missing or invalid usage token (this endpoint never returns 403), 404 = unknown `account` label, 200 = everything else (`detail=1` per-account failures surface as `detail_error`; HTTP stays 200). The response never contains account ids, resource ids, or token values. Usage token provisioning lives in SECRETS.md (`CF_USAGE_API_TOKEN`).

---

## Error Responses

All endpoints may return error responses:

| Status | Description |
|--------|-------------|
| 400 | Bad Request (invalid JSON, missing fields) |
| 401 | Unauthorized (missing token) |
| 403 | Forbidden (invalid token) |
| 404 | Not Found (check doesn't exist) |
| 500 | Internal Server Error |

**Error Response Format:**
```json
{
  "error": "Error message here"
}
```

---

## Check Types

### Heartbeat Checks

Services must send pulses at regular intervals:

```python
# Every 60 seconds
while True:
    watchdog.pulse("health", status="ok", latency=12)
    time.sleep(60)
```

If pulses stop arriving, the check is marked DEAD after `interval + grace` seconds.

### Event Checks

Event checks only alert when an error is reported:

```python
try:
    do_something()
except Exception as e:
    watchdog.pulse("payment_failure", status="error", message=str(e))
```

---

## Alert Behavior

1. **Threshold**: Number of consecutive failures before alerting (currently fixed at 1 by clamp)
2. **Cooldown**: Minimum time between alerts for same check (0 = use the global silence period; a value > 0 overrides it for this check)
3. **Maintenance**: Alerts suppressed when project is in maintenance mode
4. **Monitor off**: A check paused in the admin UI (monitor = 0) still accepts pulses but never alerts

Alert levels:
- **Critical**: Service is DEAD (no pulse received)
- **Warning**: Service reported ERROR status
- **Recovery**: Service recovered from DEAD/ERROR state
