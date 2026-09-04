# Watch-Dog Sentinel API Documentation

Base URL: `https://watch-dog.paipeter-gui.workers.dev`

## Authentication

Machine API requests authenticate with the project token, preferably as a
Bearer token (the legacy `X-Project-Token` header still works):

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
X-Project-Token: your-token
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

Register or update project and check configurations.

**Request:**
```http
PUT /api/config
X-Project-Token: your-token
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

**Check Config Fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| name | string | - | Check name (unique within project) |
| display_name | string | - | Display name |
| type | string | - | "heartbeat" or "event" |
| interval | number | 300 | Pulse interval (seconds), heartbeat only |
| grace | number | 60 | Grace period (seconds) |
| threshold | number | 1 | Failures before alert |
| cooldown | number | 900 | Alert cooldown (seconds) |

**Response:**
```json
{
  "success": true,
  "project_id": "my-service",
  "message": "Configuration updated",
  "checks_registered": 1
}
```

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

1. **Threshold**: Number of consecutive failures before alerting
2. **Cooldown**: Minimum time between alerts for same check
3. **Maintenance**: Alerts suppressed when project is in maintenance mode

Alert levels:
- **Critical**: Service is DEAD (no pulse received)
- **Warning**: Service reported ERROR status
- **Recovery**: Service recovered from DEAD/ERROR state
