/**
 * src/services/settings.ts
 * Settings management service for Watch-Dog Sentinel
 *
 * Provides functions to:
 * - Retrieve all settings from the database
 * - Update individual settings
 * - Update all Slack settings atomically
 * - Get settings with environment variable fallback
 *
 * Settings are stored in the `settings` table and include:
 * - Slack API token and channel IDs
 * - Silence period (cooldown) for alerts
 *
 * @module services/settings
 */

import { D1Database } from '@cloudflare/workers-types';
import { Env } from '../types';

/**
 * Database setting record
 */
export interface Setting {
  /** Setting key (e.g., "slack_api_token") */
  key: string;
  /** Setting value */
  value: string;
  /** Optional description for UI */
  description: string | null;
  /** Unix timestamp of last update */
  updated_at: number;
}

/**
 * Slack notification settings
 */
export interface SlackSettings {
  /** Slack Bot Token (xoxb-...) */
  api_token: string;
  /** Channel ID for critical alerts */
  channel_critical: string;
  /** Channel ID for recovery notices */
  channel_success: string;
  /** Channel ID for warning alerts */
  channel_warning: string;
  /** Channel ID for info logs */
  channel_info: string;
}

/**
 * All application settings
 */
export interface AllSettings extends SlackSettings {
  /** Cooldown period between duplicate alerts (seconds) */
  silence_period_seconds: number;
}

// Maps DB keys to interface keys
const DB_KEY_TO_INTERFACE_KEY: Record<string, keyof AllSettings> = {
  'slack_api_token': 'api_token',
  'slack_channel_critical': 'channel_critical',
  'slack_channel_success': 'channel_success',
  'slack_channel_warning': 'channel_warning',
  'slack_channel_info': 'channel_info',
  'silence_period_seconds': 'silence_period_seconds',
};

/**
 * Get all settings from the database
 *
 * @param db - D1 database instance
 * @returns All settings with defaults for missing values
 *
 * @example
 * const settings = await getAllSettings(db);
 * console.log(settings.api_token);
 */
export async function getAllSettings(db: D1Database): Promise<AllSettings> {
  const result = await db.prepare('SELECT * FROM settings').all<Setting>();

  const settings: AllSettings = {
    api_token: '',
    channel_critical: '',
    channel_success: '',
    channel_warning: '',
    channel_info: '',
    silence_period_seconds: 3600,
  };

  for (const row of result.results) {
    const interfaceKey = DB_KEY_TO_INTERFACE_KEY[row.key];
    if (interfaceKey) {
      if (interfaceKey === 'silence_period_seconds') {
        settings[interfaceKey] = parseInt(row.value, 10) || 3600;
      } else {
        (settings[interfaceKey] as string) = row.value;
      }
    }
  }

  return settings;
}

/**
 * Update a single setting in the database
 *
 * @param db - D1 database instance
 * @param key - Setting key (e.g., "slack_api_token")
 * @param value - New value for the setting
 * @returns true if successful, false on error
 */
export async function updateSetting(db: D1Database, key: string, value: string): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = ?, updated_at = ?`)
      .bind(key, value, now, value, now)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Update all Slack settings atomically
 *
 * @param db - D1 database instance
 * @param settings - Slack settings object with values to update
 * @returns true if successful, false on error
 */
export async function updateSlackSettings(db: D1Database, settings: SlackSettings): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // An empty api_token means "keep the current value" — the admin form
    // never echoes the token back into HTML, so an empty field must not
    // wipe the stored secret.
    const updates: Array<[string, string]> = [
      ...(settings.api_token ? [['slack_api_token', settings.api_token] as [string, string]] : []),
      ['slack_channel_critical', settings.channel_critical || ''],
      ['slack_channel_success', settings.channel_success || ''],
      ['slack_channel_warning', settings.channel_warning || ''],
      ['slack_channel_info', settings.channel_info || ''],
    ];

    for (const [key, value] of updates) {
      await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = ?, updated_at = ?`)
        .bind(key, value || '', now, value || '', now)
        .run();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get settings with environment variable fallback
 *
 * This function provides a fallback to environment variables for
 * backward compatibility. New deployments should use the database.
 *
 * @param db - D1 database instance
 * @param env - Cloudflare Worker environment bindings
 * @returns All settings with env var fallbacks
 */
export async function getEnvWithFallback(db: D1Database, env: Env): Promise<AllSettings> {
  const dbSettings = await getAllSettings(db);

  // Fallback to env vars if DB setting is empty
  return {
    api_token: dbSettings.api_token || env.SLACK_API_TOKEN || '',
    channel_critical: dbSettings.channel_critical || env.SLACK_CHANNEL_CRITICAL || '',
    channel_success: dbSettings.channel_success || env.SLACK_CHANNEL_SUCCESS || '',
    channel_warning: dbSettings.channel_warning || env.SLACK_CHANNEL_WARNING || '',
    channel_info: dbSettings.channel_info || env.SLACK_CHANNEL_INFO || '',
    silence_period_seconds: dbSettings.silence_period_seconds || parseInt(env.SLACK_SILENCE_PERIOD_SECONDS || '3600', 10),
  };
}
