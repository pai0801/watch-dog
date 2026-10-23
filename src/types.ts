/**
 * src/types.ts
 * Type definitions for Watch-Dog Sentinel
 *
 * This file defines all TypeScript interfaces used throughout the application:
 * - Env: Cloudflare Worker environment bindings
 * - Project: Project entity with maintenance state
 * - Check: Check entity with monitoring rules and current state
 * - Log: Historical log entries
 * - PulsePayload, ConfigPayload, CheckConfig: API request types
 *
 * @module types
 */

/**
 * Cloudflare Worker environment bindings
 *
 * These values are configured in wrangler.toml or Cloudflare dashboard.
 * Alert settings live in the D1 `settings` table (single source of truth,
 * configured via /admin); the legacy SLACK_* env fallback was removed
 * before the first production deploy (TODO-REVIEW #7).
 */
export interface Env {
  /** D1 Database binding */
  DB: D1Database;
}

/**
 * Bindings for the Hono app: Env plus the admin auth pair.
 */
export interface AppBindings extends Env {
  /**
   * Basic-Auth account for the /admin gate, set via
   * `wrangler secret put ADMIN_ACCOUNT` (or .dev.vars locally).
   */
  ADMIN_ACCOUNT?: string;
  /**
   * Basic-Auth password for the /admin gate, set via
   * `wrangler secret put ADMIN_PASSWORD` (or .dev.vars locally).
   */
  ADMIN_PASSWORD?: string;
  /**
   * Static Bearer token guarding GET /api/cf-usage (read-only usage feed
   * for other projects). Set via `wrangler secret put CF_USAGE_API_TOKEN`
   * (file-sourced); value lives in ~/.config/watch-dog/usage-api-token
   * (operator machine) and .dev.vars (sealed) — see SECRETS.md.
   */
  CF_USAGE_API_TOKEN?: string;
  /**
   * Optional cross-monitor: bearer token for POSTing a heartbeat to
   * ops-control every cron tick (independent CF account — watches the
   * watch-dog). Missing → heartbeat silently skipped (10 §5.2 optional).
   * Set via `wrangler secret put OPS_CONTROL_HOST_TOKEN`.
   */
  OPS_CONTROL_HOST_TOKEN?: string;
  /**
   * Non-secret cross-monitor endpoint ([vars] in wrangler.jsonc), e.g.
   * https://ops-control.<subdomain>.workers.dev — no trailing slash.
   */
  OPS_CONTROL_HEARTBEAT_URL?: string;
  /**
   * Optional external engine trigger: bearer token for POST /api/engine/trigger
   * (rn1g VPS cron = second trigger source, 2026-10-24). Missing → endpoint
   * fails closed (503); core sentinel unaffected (10 §5.2 optional wiring).
   * Set via `wrangler secret put TRIGGER_TOKEN`.
   */
  TRIGGER_TOKEN?: string;
}

/**
 * Project entity representing a monitored service
 *
 * Each project has a unique token used for API authentication.
 * Projects can be put into maintenance mode to suppress alerts.
 */
export interface Project {
  /** Unique project identifier (e.g., "my-service") */
  id: string;
  /** Secret token for API authentication */
  token: string;
  /** Human-readable display name */
  display_name: string;
  /** Unix timestamp when maintenance mode ends (0 = not in maintenance) */
  maintenance_until: number;
  /** Unix timestamp when project was created */
  created_at: number;
}

/**
 * Check entity representing a single monitoring rule
 *
 * Checks define the rules for monitoring and track current state.
 * The check ID format is `{project_id}:{check_name}`.
 */
export interface Check {
  /** Unique check ID */
  id: string;
  /** Parent project ID */
  project_id: string;
  /** Check name (unique within project) */
  name: string;
  /** Human-readable display name (null = use name) */
  display_name: string | null;
  /** Check type: heartbeat (periodic) or event (triggered) */
  type: 'heartbeat' | 'event';
  /** Expected interval between pulses (seconds) */
  interval: number;
  /** Grace period beyond interval before considered stale (seconds) */
  grace: number;
  /** Consecutive failures before alerting */
  threshold: number;
  /** Minimum time between alerts (seconds) */
  cooldown: number;
  /** Unix timestamp of last pulse */
  last_seen: number;
  /** Current status: ok, error, or dead */
  status: 'ok' | 'error' | 'dead';
  /** Current consecutive failure count */
  failure_count: number;
  /** Unix timestamp of last alert sent */
  last_alert_at: number;
  /** Last message from pulse (null = none) */
  last_message: string | null;
  /** Email-escalation episode flag: 1 = this failing episode has been
   *  escalated to email (sustained errors or dead); gates recovery emails. */
  escalated: number;
  /** Whether this check is monitored (1 = enabled, 0 = disabled) */
  monitor: number;
}

/**
 * Log entry for historical tracking
 */
export interface Log {
  /** Auto-incrementing log ID */
  id: number;
  /** Associated check ID */
  check_id: string;
  /** Status at time of log */
  status: string;
  /** Optional latency measurement (milliseconds) */
  latency: number | null;
  /** Optional message */
  message: string | null;
  /** Unix timestamp when log was created */
  created_at: number;
}

/**
 * Payload for POST /api/pulse endpoint
 *
 * Services send this payload to report their heartbeat status.
 */
export interface PulsePayload {
  /** Name of the check being reported */
  check_name: string;
  /** Status: "ok" (default) or "error" */
  status?: 'ok' | 'error';
  /** Optional message describing the status */
  message?: string;
  /** Optional latency in milliseconds */
  latency?: number;
}

/**
 * Configuration for a single check
 *
 * Used when registering or updating checks via PUT /api/config.
 */
export interface CheckConfig {
  /** Check name (unique within project) */
  name: string;
  /** Human-readable display name */
  display_name: string;
  /** Check type: "heartbeat" or "event" */
  type: 'heartbeat' | 'event';
  /** Pulse interval in seconds (default: 300) */
  interval?: number;
  /** Grace period in seconds (default: 60) */
  grace?: number;
  /** Failures before alerting (default: 1) */
  threshold?: number;
  /** Alert cooldown in seconds (default: 900) */
  cooldown?: number;
  /** Monitoring toggle: 1 = alert (default), 0 = accept pulses but never
   *  alert. Optional — omit to keep the stored value on update. */
  monitor?: 0 | 1;
}

/**
 * Payload for PUT /api/config endpoint
 *
 * Used to register or update project and check configurations.
 */
export interface ConfigPayload {
  /** Array of check configurations */
  checks: CheckConfig[];
  /** Replace-set semantics (WD-02): when true, this project's checks NOT
   *  listed in `checks` — and their logs — are deleted. 漏列即刪. */
  checks_replace?: boolean;
}

/**
 * Schedule entity — a registered periodic callback (scheduler hub).
 * Design: docs/plans/2026-10-19-scheduler-hub-design.md (dumb ticker).
 */
export interface Schedule {
  /** Numeric id (signature domain — bound into the HMAC message) */
  id: number;
  /** Owning project id */
  project_id: string;
  /** Human label, unique within the project */
  name: string;
  /** https:// callback URL the hub POSTs on every fire */
  callback_url: string;
  /** Fire interval in minutes (1..10080; granularity = 1-min tick) */
  interval_minutes: number;
  /** Per-schedule HMAC secret — write-only after creation (never in reads) */
  secret: string;
  /** Optional immediate retry on failure (0 = off, 1 = one retry) */
  retry_count: number;
  /** Slack warning when consecutive failures crosses this (0 = off) */
  alert_after_failures: number;
  /** Unix ts of next due fire (fired when <= now) */
  next_run_at: number;
  /** Unix ts of last fire attempt (null = never) */
  last_run_at: number | null;
  /** 'ok' (2xx ack) | 'fail' (null = never) */
  last_status: 'ok' | 'fail' | null;
  /** Consecutive failures (reset on any ack) */
  consecutive_failures: number;
  /** Project-side maintenance mute (1 = skip) */
  paused: number;
  /** Unix ts of creation */
  created_at: number;
}

/** Payload for POST /api/schedules */
export interface ScheduleCreatePayload {
  project_id: string;
  name: string;
  callback_url: string;
  /** Default 60 */
  interval_minutes?: number;
  /** 0 | 1, default 0 */
  retry_count?: number;
  /** Default 0 = off */
  alert_after_failures?: number;
}

/** Payload for PUT /api/schedules/:id (all fields optional) */
export interface ScheduleUpdatePayload {
  name?: string;
  callback_url?: string;
  interval_minutes?: number;
  retry_count?: number;
  alert_after_failures?: number;
  paused?: 0 | 1;
}
