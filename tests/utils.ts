// tests/utils.ts
// Shared fixtures: schema bootstrap + D1 seed/reset helpers.

import { env } from 'cloudflare:test';
import schemaSql from '../src/db.sql?raw';
import type { Check, Env, Project } from '../src/types';

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
    .filter(Boolean);
  await DB.batch(statements.map((s) => DB.prepare(s)));
  schemaApplied = true;
}

/** Wipe all rows so every test starts from a clean slate. */
export async function resetDb(): Promise<void> {
  await applySchema();
  await DB.batch([
    DB.prepare('DELETE FROM logs'),
    DB.prepare('DELETE FROM checks'),
    DB.prepare('DELETE FROM projects'),
    DB.prepare('DELETE FROM settings'),
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
    monitor: 1,
    ...overrides,
  };
  await DB.prepare(`
    INSERT INTO checks (
      id, project_id, name, display_name, type, interval, grace, threshold, cooldown,
      last_seen, status, failure_count, last_alert_at, last_message, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      check.id, check.project_id, check.name, check.display_name, check.type,
      check.interval, check.grace, check.threshold, check.cooldown,
      check.last_seen, check.status, check.failure_count, check.last_alert_at,
      check.last_message, check.monitor
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
