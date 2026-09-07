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
CREATE INDEX IF NOT EXISTS idx_logs_check_id ON logs(check_id);
-- created_at index: the hourly 7-day log cleanup DELETEs by created_at range —
-- without this, every cleanup run was a full-table scan (D1 rows-read quota burner).
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_type ON checks(monitor, type) WHERE monitor = 1;

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
