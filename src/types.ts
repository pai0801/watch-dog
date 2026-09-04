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
 * Some are legacy fallbacks; settings are now primarily stored in DB.
 */
export interface Env {
  /** D1 Database binding */
  DB: D1Database;
  /** @deprecated Use settings table instead */
  SLACK_API_TOKEN?: string;
  /** @deprecated Use settings table instead */
  SLACK_CHANNEL_CRITICAL?: string;
  /** @deprecated Use settings table instead */
  SLACK_CHANNEL_SUCCESS?: string;
  /** @deprecated Use settings table instead */
  SLACK_CHANNEL_WARNING?: string;
  /** @deprecated Use settings table instead */
  SLACK_CHANNEL_INFO?: string;
  /** @deprecated Use settings table instead */
  SLACK_SILENCE_PERIOD_SECONDS?: string;
}

/**
 * Bindings for the Hono app: Env plus the admin auth secret.
 */
export interface AppBindings extends Env {
  /**
   * Password for the /admin Basic-Auth gate, set via
   * `wrangler secret put ADMIN_TOKEN` (or .dev.vars locally).
   * The username is ignored — any username works.
   */
  ADMIN_TOKEN?: string;
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
}

/**
 * Payload for PUT /api/config endpoint
 *
 * Used to register or update project and check configurations.
 */
export interface ConfigPayload {
  /** Array of check configurations */
  checks: CheckConfig[];
}
