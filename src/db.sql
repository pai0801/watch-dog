-- src/db.sql
-- Database schema for Watch-Dog Sentinel
--
-- Tables:
--   - projects: Stores project tokens and maintenance state
--   - checks: Defines monitoring rules and current state
--   - logs: Historical log entries (periodically cleaned)
--   - settings: Admin-configurable settings (Slack, cooldown)
--
-- The schema uses SQLite syntax compatible with Cloudflare D1.
-- All timestamps are stored as Unix timestamps (seconds since epoch).

-- ============================================================================
-- Projects Table
-- ============================================================================
-- Each project represents a monitored service with its own authentication token
CREATE TABLE IF NOT EXISTS projects (
    -- Unique project identifier (e.g., "my-service", "api-backend")
    id TEXT PRIMARY KEY,
    -- Secret token for API authentication (min 16 characters recommended)
    token TEXT NOT NULL,
    -- Human-readable display name for UI
    display_name TEXT NOT NULL,
    -- Unix timestamp when maintenance mode ends (0 = not in maintenance)
    maintenance_until INTEGER DEFAULT 0,
    -- Unix timestamp when project was created
    created_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- Checks Table
-- ============================================================================
-- Each check defines a monitoring rule and tracks its current state
CREATE TABLE IF NOT EXISTS checks (
    -- Unique check ID in format "{project_id}:{check_name}"
    id TEXT PRIMARY KEY,
    -- Parent project reference
    project_id TEXT NOT NULL,
    -- Check name (unique within project, e.g., "database", "api-health")
    name TEXT NOT NULL,
    -- Optional display name (null = use name)
    display_name TEXT,
    -- Check type: "heartbeat" = periodic checks, "event" = error-triggered
    type TEXT NOT NULL,

    -- ---------- SLA Rules ----------
    -- Expected interval between pulses (seconds)
    interval INTEGER DEFAULT 300,
    -- Grace period beyond interval before stale (seconds)
    grace INTEGER DEFAULT 60,
    -- Consecutive failures before triggering alert
    threshold INTEGER DEFAULT 1,
    -- Minimum time between alerts for same check (seconds)
    cooldown INTEGER DEFAULT 900,

    -- ---------- Current State ----------
    -- Unix timestamp of last received pulse
    last_seen INTEGER DEFAULT 0,
    -- Current status: "ok", "error", or "dead"
    status TEXT DEFAULT 'ok',
    -- Current consecutive failure count
    failure_count INTEGER DEFAULT 0,
    -- Unix timestamp of last alert sent
    last_alert_at INTEGER DEFAULT 0,
    -- Last message from pulse (optional)
    last_message TEXT,
    -- Email-escalation episode flag: 1 once a failing episode has been
    -- escalated to the email channel (sustained errors / dead). Cleared when
    -- the episode resolves (error window drained + ok pulse). Recovery emails
    -- are only sent for email-worthy episodes — this is what stops "orphan
    -- recovery" emails for warning-level flaps the operator was never told
    -- about (2026-09-10 ek-gateway incident).
    escalated INTEGER DEFAULT 0,

    -- ---------- Monitoring Control ----------
    -- If 0, cron watcher will skip this check (1 = enabled, 0 = disabled)
    monitor INTEGER DEFAULT 1,

    FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- ============================================================================
-- Logs Table
-- ============================================================================
-- Historical log entries, periodically cleaned (7-day retention)
CREATE TABLE IF NOT EXISTS logs (
    -- Auto-incrementing primary key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Associated check ID
    check_id TEXT NOT NULL,
    -- Status at time of log
    status TEXT NOT NULL,
    -- Optional latency measurement (milliseconds)
    latency INTEGER,
    -- Optional message
    message TEXT,
    -- Unix timestamp when log was created
    created_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_checks_project ON checks(project_id);
-- Composite (check_id, created_at): per-check queries filter a created_at
-- window (escalation error count, admin log viewer). A check_id-only index
-- made each a full partition scan — ek-gateway:jobs holds ~15k rows, so every
-- escalated ok pulse read 14.4k rows (~7.3M rows/day, 2026-09-11). The
-- composite prefix still covers the plain check_id deletes below.
CREATE INDEX IF NOT EXISTS idx_logs_check_id_created_at ON logs(check_id, created_at);
DROP INDEX IF EXISTS idx_logs_check_id;
-- created_at index: the hourly 7-day log cleanup DELETEs by created_at range —
-- without this, every cleanup run was a full-table scan (D1 rows-read quota burner).
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_type ON checks(monitor, type) WHERE monitor = 1;

-- ============================================================================
-- CF Usage Monitoring Tables (2026-09-11)
-- ============================================================================
-- Passive quota monitor for all Cloudflare accounts the operator runs
-- services on (born from two shared-account D1 quota exhaustion incidents:
-- 2026-09-07 log cleanup ~4.1M rows/day, 2026-09-11 countRecentErrors
-- ~7.3M rows/day — both discovered only after HTTP 500s). The poller hits
-- the GraphQL Analytics API per account every 30 minutes — thresholds and
-- semantics live in src/services/cfUsage.ts.

-- One row per monitored CF account. api_token is an account-scoped
-- Analytics-Read token stored in D1 — same single-truth-source model as the
-- Slack/email tokens in settings (NOT a Worker secret — see SECRETS.md).
CREATE TABLE IF NOT EXISTS cf_accounts (
    -- CF account tag (32 hex chars, validated server-side)
    account_id TEXT PRIMARY KEY,
    -- Human-readable label (e.g. "Helperp prod")
    label TEXT NOT NULL,
    -- Analytics-Read API token (masked in admin UI, never echoed)
    api_token TEXT NOT NULL,
    -- Quota-table key ('free' | 'paid') — selects the metric quota set
    plan TEXT DEFAULT 'free',
    -- 0 = poller skips entirely (no fetch, no alerts — state rows retained)
    enabled INTEGER DEFAULT 1,
    -- Unix ts of last successful poll (0 = never — self-warning transition detection)
    last_ok_at INTEGER DEFAULT 0,
    -- Last poll failure reason (null = last poll ok)
    last_error TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Per-(day, account, metric) usage snapshot + alert state machine.
-- PK leads with day_utc: the per-poll read (WHERE day_utc = ?), the admin
-- snapshot read, and the retention DELETE are all prefix scans — the
-- idx_logs lesson (D1 rows-read discipline) applied at design time.
CREATE TABLE IF NOT EXISTS cf_usage_state (
    -- UTC quota day 'YYYY-MM-DD' (quota resets UTC 00:00 = 08:00 Taipei)
    day_utc TEXT NOT NULL,
    account_id TEXT NOT NULL,
    -- Metric registry key (see METRICS in cfUsage.ts)
    metric TEXT NOT NULL,
    -- Latest measured value from GraphQL
    value INTEGER DEFAULT 0,
    -- Burn-rate projection to end of UTC day (counters only, elapsed >= 30min)
    projected_eod INTEGER,
    -- Alert dedup state: 0 none | 1 warning (60% / projection) | 2 critical (80%).
    -- Monotonic within a day (only upgrades dispatch) — counters start each UTC
    -- day at 0, gauges carry yesterday's level over (storage quotas don't reset).
    alerted_level INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (day_utc, account_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_cf_accounts_enabled ON cf_accounts(enabled) WHERE enabled = 1;

-- Per-resource display names for the on-demand detail fragment (2026-09-12).
-- GraphQL analytics dimensions give Workers, Pages and R2 real names for
-- free (scriptName, bucketName) but D1 databaseId and KV namespaceId are
-- opaque ids — this table maps them to the names the REST list endpoints
-- return. Refreshed at most daily per (account, resource_type) by the
-- 30-min poller (refreshResourceNamesIfNeeded in cfResources ts) and read
-- by the detail fragment and the usage API. No extra index needed: every
-- read is a full scan of one account's few dozen rows and the PK prefix
-- (account_id, resource_type) already covers the refresh gate query
CREATE TABLE IF NOT EXISTS cf_resource_names (
    -- CF account tag (32 hex) — joins cf_accounts
    account_id TEXT NOT NULL,
    -- Which REST list the row came from: 'd1' or 'kv'
    resource_type TEXT NOT NULL,
    -- database uuid (D1, hyphenated) or namespace id normalized to bare hex (KV)
    resource_id TEXT NOT NULL,
    -- Display name from the REST list (database name or namespace title)
    name TEXT NOT NULL,
    -- Unix ts of the refresh that wrote this row (replace-set bookkeeping)
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, resource_type, resource_id)
);

-- ============================================================================
-- Settings Table
-- ============================================================================
-- Application settings stored in database (replaces env vars)
CREATE TABLE IF NOT EXISTS settings (
    -- Unique setting key
    key TEXT PRIMARY KEY,
    -- Setting value (stored as text, numbers parsed as needed)
    value TEXT NOT NULL,
    -- Optional description for UI
    description TEXT,
    -- Unix timestamp of last update
    updated_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- Default Settings
-- ============================================================================
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('slack_api_token', '', 'Slack Bot Token (xoxb-...)'),
    ('slack_channel_info', '', 'Slack Channel ID for Info logs'),
    ('slack_channel_warning', '', 'Slack Channel ID for Warnings'),
    ('slack_channel_success', '', 'Slack Channel ID for Success/Recovery'),
    ('slack_channel_critical', '', 'Slack Channel ID for Critical alerts'),
    ('silence_period_seconds', '3600', 'Cooldown period in seconds for duplicate alerts');
