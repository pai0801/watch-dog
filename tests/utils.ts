// tests/utils.ts
// Shared fixtures: schema bootstrap + D1 seed/reset helpers.

import { env } from 'cloudflare:test';
import schemaSql from '../src/db.sql?raw';
import type { Check, Env, Project } from '../src/types';
import type { CfAccount } from '../src/services/cfUsage';

export const DB = env.DB as unknown as D1Database;

/** Minimal Env for calling service functions directly in tests. */
export const TEST_ENV = { DB } as unknown as Env;

let schemaApplied = false;

/** Apply src/db.sql once per worker (idempotent statements). */
export async function applySchema(): Promise<void> {
  if (schemaApplied) return;
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    // Skip fragments that are only comments (a ';' inside a -- comment splits
    // mid-comment; comment-only fragments make D1 reject the whole batch).
    .filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
  await DB.batch(statements.map((s) => DB.prepare(s)));
  schemaApplied = true;
}

/** Re-apply src/db.sql unconditionally — restores tables a destructive test
 *  dropped (applySchema's once-per-worker flag would skip it). */
export async function reapplySchema(): Promise<void> {
  schemaApplied = false;
  await applySchema();
}

/** Wipe all rows so every test starts from a clean slate. */
export async function resetDb(): Promise<void> {
  await applySchema();
  await DB.batch([
    DB.prepare('DELETE FROM logs'),
    DB.prepare('DELETE FROM checks'),
    DB.prepare('DELETE FROM projects'),
    DB.prepare('DELETE FROM settings'),
    DB.prepare('DELETE FROM cf_accounts'),
    DB.prepare('DELETE FROM cf_usage_state'),
  ]);
}

export const TEST_SLACK = {
  api_token: 'xoxb-test-token-1234',
  channel_critical: 'C_CRITICAL',
  channel_success: 'C_SUCCESS',
  channel_warning: 'C_WARNING',
  channel_info: 'C_INFO',
};

/** Configure Slack settings so alerts actually attempt delivery. */
export async function setSlackSettings(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows: Array<[string, string]> = [
    ['slack_api_token', TEST_SLACK.api_token],
    ['slack_channel_critical', TEST_SLACK.channel_critical],
    ['slack_channel_success', TEST_SLACK.channel_success],
    ['slack_channel_warning', TEST_SLACK.channel_warning],
    ['slack_channel_info', TEST_SLACK.channel_info],
    ['silence_period_seconds', '3600'],
  ];
  for (const [key, value] of rows) {
    await DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = ?, updated_at = ?'
    )
      .bind(key, value, now, value, now)
      .run();
  }
}

/** email-king gateway fixture (arbitrary host — msw intercepts by URL). */
export const TEST_EMAIL = {
  email_gateway_url: 'https://ek-gw.test.local/api/v1/send',
  email_api_token: 'ek-test-send-token-1234',
  email_recipient: 'ops@example.com',
};

/** Configure email alert settings so email delivery is actually attempted. */
export async function setEmailSettings(): Promise<void> {
  await setSetting('email_gateway_url', TEST_EMAIL.email_gateway_url);
  await setSetting('email_api_token', TEST_EMAIL.email_api_token);
  await setSetting('email_recipient', TEST_EMAIL.email_recipient);
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = ?, updated_at = ?'
  )
    .bind(key, value, now, value, now)
    .run();
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function seedProject(overrides: Partial<Project> = {}): Promise<Project> {
  const project: Project = {
    id: 'test-project',
    token: 'test-token-1234567890',
    display_name: 'Test Project',
    maintenance_until: 0,
    created_at: nowSec(),
    ...overrides,
  };
  await DB.prepare(
    'INSERT INTO projects (id, token, display_name, maintenance_until, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(project.id, project.token, project.display_name, project.maintenance_until, project.created_at)
    .run();
  return project;
}

export async function seedCheck(projectId: string, overrides: Partial<Check> = {}): Promise<Check> {
  const check: Check = {
    id: `${projectId}:health`,
    project_id: projectId,
    name: 'health',
    display_name: 'Health Check',
    type: 'heartbeat',
    interval: 300,
    grace: 60,
    threshold: 1,
    cooldown: 900,
    last_seen: nowSec(),
    status: 'ok',
    failure_count: 0,
    last_alert_at: 0,
    last_message: null,
    escalated: 0,
    monitor: 1,
    ...overrides,
  };
  await DB.prepare(`
    INSERT INTO checks (
      id, project_id, name, display_name, type, interval, grace, threshold, cooldown,
      last_seen, status, failure_count, last_alert_at, last_message, escalated, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      check.id, check.project_id, check.name, check.display_name, check.type,
      check.interval, check.grace, check.threshold, check.cooldown,
      check.last_seen, check.status, check.failure_count, check.last_alert_at,
      check.last_message, check.escalated, check.monitor
    )
    .run();
  return check;
}

export async function getCheck(id: string): Promise<Check | null> {
  return DB.prepare('SELECT * FROM checks WHERE id = ?').bind(id).first<Check>();
}

export async function getProject(id: string): Promise<Project | null> {
  return DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Project>();
}

export async function countLogs(checkId: string): Promise<number> {
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM logs WHERE check_id = ?').bind(checkId).first<{ n: number }>();
  return row?.n ?? 0;
}

// ============================================================================
// CF usage monitor fixtures
// ============================================================================

/** GraphQL endpoint + two distinguishable account/token pairs (msw routes
 *  the response by Authorization header). Tokens are throwaway test values. */
export const TEST_CF = {
  gqlUrl: 'https://api.cloudflare.com/client/v4/graphql',
  accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  token: `cf-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
  accountIdB: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  tokenB: `cf-test-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
};

export async function seedCfAccount(overrides: Partial<CfAccount> = {}): Promise<CfAccount> {
  const account: CfAccount = {
    account_id: TEST_CF.accountId,
    label: 'Test Account',
    api_token: TEST_CF.token,
    plan: 'free',
    enabled: 1,
    last_ok_at: 0,
    last_error: null,
    created_at: nowSec(),
    ...overrides,
  };
  await DB.prepare(`
    INSERT INTO cf_accounts (account_id, label, api_token, plan, enabled, last_ok_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      account.account_id, account.label, account.api_token, account.plan,
      account.enabled, account.last_ok_at, account.last_error, account.created_at
    )
    .run();
  return account;
}

export interface CfUsageStateTestRow {
  day_utc: string;
  account_id: string;
  metric: string;
  value: number;
  projected_eod: number | null;
  alerted_level: number;
}

export async function getUsageState(
  dayUtc: string,
  accountId: string,
  metric?: string
): Promise<CfUsageStateTestRow[]> {
  if (metric) {
    const rows = await DB
      .prepare('SELECT * FROM cf_usage_state WHERE day_utc = ? AND account_id = ? AND metric = ?')
      .bind(dayUtc, accountId, metric)
      .all<CfUsageStateTestRow>();
    return rows.results;
  }
  const rows = await DB
    .prepare('SELECT * FROM cf_usage_state WHERE day_utc = ? AND account_id = ?')
    .bind(dayUtc, accountId)
    .all<CfUsageStateTestRow>();
  return rows.results;
}

export async function getCfAccount(accountId: string): Promise<CfAccount | null> {
  return DB.prepare('SELECT * FROM cf_accounts WHERE account_id = ?').bind(accountId).first<CfAccount>();
}

/** UTC noon on a fixed day — deterministic dayUtc ('2026-09-11') and
 *  elapsedSec (43200) for projection math. */
export const CF_TEST_NOW = Date.UTC(2026, 8, 11, 12, 0, 0); // month 8 = September
