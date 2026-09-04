// src/services/alert.ts
// Slack alert service for Watch-Dog Sentinel

import { D1Database } from '@cloudflare/workers-types';
import { Env } from '../types';
import { getEnvWithFallback } from './settings';

/**
 * Alert levels for Watch-Dog notifications
 * - critical: Service is DEAD (no pulse received)
 * - recovery:  Service recovered from DEAD state
 * - warning:   Service has ERROR status (pulse with error)
 */
export type AlertLevel = 'critical' | 'recovery' | 'warning';

/** Slack Block Kit block — 本檔使用的最小結構（header/section/context；完整 schema 見 Slack API）。 */
interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

/**
 * Slack message payload
 */
export interface SlackAlertData {
  /** Check ID that triggered the alert */
  checkId: string;
  /** Project display name */
  projectName: string;
  /** Check display name */
  checkName: string;
  /** Alert level */
  level: AlertLevel;
  /** Alert title/summary */
  title: string;
  /** Detailed message */
  message: string;
  /** Optional URL to view the check */
  url?: string;
  /** Optional metadata (shown in details section) */
  metadata?: Record<string, string | number>;
}

/**
 * Channel mapping for different alert levels
 * Maps alert levels to settings keys
 */
const CHANNEL_MAP: Record<AlertLevel, 'channel_critical' | 'channel_success' | 'channel_warning'> = {
  critical: 'channel_critical',
  recovery: 'channel_success',
  warning: 'channel_warning',
};

/**
 * Style configuration for alert levels
 */
const STYLE_MAP: Record<AlertLevel, { emoji: string; color: string }> = {
  critical: { emoji: '🚨', color: '#DC2626' }, // Red
  recovery: { emoji: '✅', color: '#10B981' },  // Green
  warning: { emoji: '⚠️', color: '#F59E0B' },   // Orange
};

/**
 * Send an alert to Slack using the Block Kit API
 *
 * @param db - D1 database for fetching settings
 * @param data - Alert data
 *
 * @example
 * ```ts
 * await sendSlackAlert(db, {
 *   checkId: 'chk_123',
 *   projectName: 'My API',
 *   checkName: 'Health Check',
 *   level: 'critical',
 *   title: 'Service Down',
 *   message: 'No pulse received for 5 minutes',
 *   metadata: { interval: 60, grace: 30 }
 * });
 * ```
 */
export async function sendSlackAlert(db: D1Database, env: Env, data: SlackAlertData): Promise<void> {
  const {
    checkId,
    projectName,
    checkName,
    level,
    title,
    message,
    url,
    metadata = {},
  } = data;

  // Get settings from database with environment variable fallback
  const settings = await getEnvWithFallback(db, env);

  // Get Slack token from settings
  const token = settings.api_token;
  if (!token) {
    console.error('[Slack] Slack API token not configured, skipping alert');
    return;
  }

  // Get channel ID for this alert level
  const channelKey = CHANNEL_MAP[level];
  const channelId = String(settings[channelKey] ?? '');
  if (!channelId) {
    console.error(`[Slack] Channel for ${level} alerts not configured, skipping alert`);
    return;
  }

  // Get style configuration
  const style = STYLE_MAP[level];

  // Build Block Kit payload
  const blocks: SlackBlock[] = [
    // Header with emoji and title
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${style.emoji} Watch-Dog: ${title}`,
        emoji: true,
      },
    },
    // Status and time fields
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Level:*\n${level.toUpperCase()}`,
        },
        {
          type: 'mrkdwn',
          text: `*Time:*\n${new Date().toISOString()}`,
        },
      ],
    },
    // Project and check info
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Project:*\n${projectName}`,
        },
        {
          type: 'mrkdwn',
          text: `*Check:*\n${checkName}`,
        },
      ],
    },
    // Main message
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Message:*\n${message}`,
      },
    },
  ];

  // Add metadata fields if present
  if (Object.keys(metadata).length > 0) {
    const metadataFields = Object.entries(metadata).map(([key, value]) => ({
      type: 'mrkdwn',
      text: `*${key}:*\n${value}`,
    }));

    blocks.push({
      type: 'section',
      fields: metadataFields,
    });
  }

  // Add URL button if provided
  if (url) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${url}|View Details →>`,
      },
    });
  }

  // Add footer with check ID
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Check ID: \`${checkId}\` | Watch-Dog Sentinel`,
      },
    ],
  });

  // Build Slack API payload
  const payload = {
    channel: channelId,
    username: 'Watch-Dog Sentinel',
    icon_emoji: ':dog2:',
    blocks,
    text: message, // Fallback for push notifications
  };

  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      // Bound the request: cron time is limited and a hung Slack call must
      // not stall the whole run (or hold a request open indefinitely).
      signal: AbortSignal.timeout(10_000),
    });

    const result = await response.json() as { ok: boolean; error?: string };

    if (!result.ok) {
      console.error(`[Slack] API Error: ${result.error}`);
    }
  } catch (error) {
    console.error('[Slack] Failed to send alert:', error);
  }
}

/**
 * Check if we're within the silence period (cooldown)
 * Prevents alert spam by respecting the cooldown period
 *
 * @param lastAlertAt - Unix timestamp of last alert
 * @param silencePeriodSeconds - Seconds to wait before next alert
 * @param now - Current Unix timestamp
 *
 * @returns true if within silence period (should NOT alert), false otherwise
 *
 * @example
 * ```ts
 * if (isInSilencePeriod(check.last_alert_at, 3600, now)) {
 *   return; // Skip alert
 * }
 * ```
 */
export function isInSilencePeriod(
  lastAlertAt: number,
  silencePeriodSeconds: number,
  now: number
): boolean {
  if (lastAlertAt === 0) return false;
  const elapsed = now - lastAlertAt;
  return elapsed < silencePeriodSeconds;
}

/**
 * Get the global silence period from database settings with env fallback
 * (SLACK_SILENCE_PERIOD_SECONDS when no DB row exists).
 *
 * @param db - D1 database for fetching settings
 * @param env - Worker environment for fallback values
 * @returns Silence period in seconds (default: 3600 = 1 hour)
 */
export async function getSilencePeriod(db: D1Database, env: Env): Promise<number> {
  const settings = await getEnvWithFallback(db, env);
  return settings.silence_period_seconds;
}
