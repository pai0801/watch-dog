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
-- by the detail fragment and the usage API. resource_type='pages' rows are
-- OPERATOR ALIASES (admin Pages-alias panel, 2026-09-14): CF exposes no
-- API mapping from the internal pages-worker--<digits>-<env> scriptName to
-- the project, so the operator names each one manually, and the daily replace-
-- set refresh only touches d1/kv and never pages rows. No extra index
-- needed: every read is a full scan of one account's few dozen rows and
-- the PK prefix (account_id, resource_type) already covers the refresh
-- gate query
CREATE TABLE IF NOT EXISTS cf_resource_names (
    -- CF account tag (32 hex) — joins cf_accounts
    account_id TEXT NOT NULL,
    -- Which REST list the row came from: 'd1' or 'kv' ('pages' = operator alias, admin panel)
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
-- Schedules Table (2026-10-19) — scheduler hub
-- ============================================================================
-- Dumb-ticker callback registry (docs/plans/2026-10-19-scheduler-hub-design.md):
-- the hub wakes each target at its registered interval and does NOTHING else
-- (precision/debounce/idempotency live in the target). next_run_at advances
-- BEFORE firing → at-most-once per period — failing targets are never
-- re-hammered. secret is D1 runtime data (cf_accounts.api_token precedent),
-- returned exactly once at creation, never selected by admin queries.
CREATE TABLE IF NOT EXISTS schedules (
    -- Numeric id (also the signature domain — targets bind it into HMAC)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Owning project (closed registration: operator-created, token-authed)
    project_id TEXT NOT NULL,
    -- Human label, unique within the project
    name TEXT NOT NULL,
    -- https:// callback URL the hub POSTs on every fire
    callback_url TEXT NOT NULL,
    -- Fire interval in minutes (1..10080, actual granularity = 1-min tick)
    interval_minutes INTEGER NOT NULL,
    -- Per-schedule HMAC secret (64 hex chars, generated at creation)
    secret TEXT NOT NULL,
    -- Optional immediate retry on failure (0 = off, 1 = one retry) —
    -- registration choice, never hub policy
    retry_count INTEGER NOT NULL DEFAULT 0,
    -- Slack warning when consecutive failures CROSSES this value
    -- (0 = off). No auto-pause exists by design (operator decision).
    alert_after_failures INTEGER NOT NULL DEFAULT 0,
    -- Due-fire bookkeeping: fired when <= now
    next_run_at INTEGER NOT NULL,
    -- Unix ts of last fire attempt (null = never fired)
    last_run_at INTEGER,
    -- 'ok' (2xx ack) | 'fail' (null = never fired)
    last_status TEXT,
    -- Reset to 0 on any ack, incremented on each failure
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    -- Project-side maintenance mute (1 = skip, only the project sets it)
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(project_id, name),
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
-- covers the cron due-query WHERE paused = 0 AND next_run_at <= ? ORDER BY next_run_at (equality prefix + range, ORDER BY via index order)
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(paused, next_run_at);

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

-- ============================================================================
-- Issues Collector Tables (2026-10-31, WATCHDOG-015)
-- ============================================================================
-- CF Workers Issues + Automations → generic webhook → watch-dog 收集分診，
-- Windmill（rn4g-1 VPS）poll 認領處置。四迴路閉環設計見
-- docs/WINDMILL-CONTRACT.md。事件量級 = 聚合後 issue 狀態變化（低量），
-- D1 無壓力；resolved/done 30 天由 cron 每小時清理。

-- 每個 CF issue 一列（fingerprint = alert_correlation_id 去重）。
-- 狀態機：open → claimed → done|failed(→open 重試)|skipped(→escalated)
--         open --attempt>=2--> escalated（保險絲：自動處理上限，人工接手）
--         任何狀態 --cf resolved--> resolved（attempt 歸零，新 episode 重新計數）
CREATE TABLE IF NOT EXISTS issues (
    -- Auto-incrementing primary key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- CF alert_correlation_id（UUID，同 issue 聚合鍵）；缺漏時退化為
    -- alert_type:account_id:episode_id 拼接
    fingerprint TEXT NOT NULL UNIQUE,
    -- CF account id（payload account_id；非 watch-dog 帳號標籤）
    account_id TEXT,
    -- 出問題的 Worker script 名（tolerant 解析，見 services/issues.ts）
    script_name TEXT,
    -- issue_map 映射到的 watch-dog project（NULL = 未映射，僅觀察）
    project_id TEXT,
    -- issue 標題（data.episode.summary ?? text ?? name）
    title TEXT NOT NULL,
    -- CF alert_type（如 workers_observability_alert）
    alert_type TEXT,
    -- 狀態機目前狀態：open|claimed|done|escalated|resolved
    state TEXT NOT NULL DEFAULT 'open',
    -- 自動處理嘗試次數（claim 時 +1；resolved 歸零）——保險絲計數器
    attempt_count INTEGER NOT NULL DEFAULT 0,
    -- 本 episode 是否已對操作者發過告警（gates recovery 通知，防孤兒 recovery）
    alerted INTEGER NOT NULL DEFAULT 0,
    -- Windmill 認領時間（「取過」標記）；NULL = 未認領
    claimed_at INTEGER,
    -- 認領者（目前固定 'windmill'）
    claimed_by TEXT,
    -- 最後一次 CF 事件（triggered|resolved），診斷用
    last_event TEXT,
    -- 最後一次原始 payload（JSON 字串，截 8KB —— 僅 DB 保存，不進公開頁面）
    payload TEXT,
    -- Unix timestamp 首次收到
    first_seen INTEGER NOT NULL,
    -- Unix timestamp 最後收到事件
    last_seen INTEGER NOT NULL,
    -- Unix timestamp CF 回報 resolved（NULL = 未解決）
    resolved_at INTEGER,
    -- Unix timestamp 保險絲觸發（attempt 達上限或 windmill skipped）
    escalated_at INTEGER
);

-- 事件史（審計軌跡：機器到底對這個 issue 做過什麼）
CREATE TABLE IF NOT EXISTS issue_events (
    -- Auto-incrementing primary key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Parent issue reference
    issue_id INTEGER NOT NULL,
    -- 事件種類：cf-triggered|cf-regressed|cf-resolved|claimed|feedback|escalated|reclaimed-stale
    event TEXT NOT NULL,
    -- 誰做的：cf-issues|windmill|fuse
    actor TEXT NOT NULL,
    -- JSON 詳情（{status, attempt, message...}，截 2KB）
    detail TEXT,
    -- Unix timestamp
    created_at INTEGER DEFAULT (unixepoch())
);

-- script → project 映射（operator 維護；claim 自動設 maintenance 依賴它）
CREATE TABLE IF NOT EXISTS issue_map (
    -- CF Worker script 名（精確匹配）
    script_name TEXT PRIMARY KEY,
    -- 對應的 watch-dog project id
    project_id TEXT NOT NULL,
    -- Unix timestamp of creation
    created_at INTEGER DEFAULT (unixepoch())
);

-- 公開觀察頁按 last_seen 倒序拉最近 100 筆
CREATE INDEX IF NOT EXISTS idx_issues_last_seen ON issues(last_seen);
-- Windmill pull：WHERE state = 'open'（等值前綴）
CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
-- 事件史按 issue 查（等值前綴）
CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);
