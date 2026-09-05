// src/services/alert.ts
// Slack alert service for Watch-Dog Sentinel

import { D1Database } from '@cloudflare/workers-types';
import { getAllSettings } from './settings';

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

/** Result of a Slack send attempt — lets callers (e.g. the admin test-alert
 *  button) report delivery success/failure instead of guessing from logs. */
export interface SlackSendResult {
  ok: boolean;
  /** Failure reason when ok === false (settings missing, Slack API error, network error). */
  error?: string;
}

/** Levels that also send email (outage + recovery); warnings stay Slack-only. */
const EMAIL_LEVELS: ReadonlySet<AlertLevel> = new Set(['critical', 'recovery']);

/** Result of an email-king gateway send attempt (same shape as Slack). */
export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Send an alert to Slack using the Block Kit API
 *
 * @param db - D1 database for fetching settings
 * @param data - Alert data
 * @returns Delivery result; cron callers ignore it, admin surfaces it
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
export async function sendSlackAlert(db: D1Database, data: SlackAlertData): Promise<SlackSendResult> {
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

  // Settings come from the D1 settings table (single source of truth)
  const settings = await getAllSettings(db);

  // Get Slack token from settings
  const token = settings.api_token;
  if (!token) {
    console.error('[Slack] Slack API token not configured, skipping alert');
    return { ok: false, error: 'Slack API token not configured（/admin → Settings）' };
  }

  // Get channel ID for this alert level
  const channelKey = CHANNEL_MAP[level];
  const channelId = String(settings[channelKey] ?? '');
  if (!channelId) {
    console.error(`[Slack] Channel for ${level} alerts not configured, skipping alert`);
    return { ok: false, error: `Channel for ${level} alerts not configured（/admin → Settings）` };
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
      return { ok: false, error: `Slack API: ${result.error ?? 'unknown error'}` };
    }
    return { ok: true };
  } catch (error) {
    console.error('[Slack] Failed to send alert:', error);
    return { ok: false, error: `Slack request failed: ${String(error)}` };
  }
}

/**
 * Send an alert email through the email-king gateway
 * (~/Code/email-king docs/SEND-SPEC.md: POST {url} Bearer token,
 * {to_email, subject, html_content, industry?, company?}).
 *
 * Best-effort: never throws — a gateway outage (which watch-dog itself
 * monitors as ek-gateway) must not break the Slack alert path.
 */
export async function sendEmailAlert(db: D1Database, data: SlackAlertData): Promise<EmailSendResult> {
  const settings = await getAllSettings(db);
  const { email_gateway_url: url, email_api_token: token, email_recipient: recipient } = settings;

  if (!url || !token || !recipient) {
    return { ok: false, error: 'Email alerts not configured（/admin → Settings → Email：gateway URL＋token＋收件人）' };
  }

  const style = STYLE_MAP[data.level];
  const subject = `${style.emoji} [watch-dog] ${data.projectName}/${data.checkName} — ${data.title}`;
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 560px;">
      <h2 style="margin: 0 0 0.5rem;">${style.emoji} Watch-Dog: ${data.title}</h2>
      <p style="color: #555; margin: 0 0 1rem;">${new Date().toISOString()}</p>
      <table style="border-collapse: collapse;">
        <tr><td style="padding: 4px 12px 4px 0; color: #777;">Level</td><td><b>${data.level.toUpperCase()}</b></td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #777;">Project</td><td>${data.projectName}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #777;">Check</td><td>${data.checkName}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #777;">Message</td><td>${data.message}</td></tr>
      </table>
      <p style="margin-top: 1rem;"><a href="https://watch-dog.helperp.workers.dev/">打開 Watch-Dog Dashboard →</a></p>
    </div>`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        to_email: recipient,
        subject,
        html_content: html,
        // CRM attribution on the gateway's monitoring page
        industry: '監控',
        company: 'watch-dog',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      let code = `HTTP ${response.status}`;
      try {
        const detail = await response.json() as { detail?: { code?: string; message?: string } };
        if (detail?.detail) code = `${detail.detail.code ?? code}: ${detail.detail.message ?? ''}`;
      } catch { /* non-JSON error body — keep the HTTP code */ }
      console.error('[Email] gateway error:', code);
      return { ok: false, error: `email-king gateway: ${code}` };
    }
    return { ok: true };
  } catch (error) {
    console.error('[Email] failed:', error);
    return { ok: false, error: `email request failed: ${String(error)}` };
  }
}

/**
 * Fan an alert out to every configured channel: Slack always; email for
 * outage-level alerts (critical/recovery) when the email-king gateway is
 * configured. Channels are independent — one failing never blocks the other.
 */
export async function dispatchAlert(db: D1Database, data: SlackAlertData): Promise<void> {
  const [slack, email] = await Promise.all([
    sendSlackAlert(db, data),
    EMAIL_LEVELS.has(data.level) ? sendEmailAlert(db, data) : Promise.resolve({ ok: true } satisfies EmailSendResult),
  ]);
  // Errors already console.error'd inside the senders; results are for
  // callers that want them (tests / future telemetry). Log a summary line
  // for the email path so cron traces show both channels.
  if (!slack.ok) console.error('[dispatch] Slack channel failed:', slack.error);
  if (!email.ok) console.error('[dispatch] Email channel failed:', email.error);
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
 * Get the global silence period from database settings.
 *
 * @param db - D1 database for fetching settings
 * @returns Silence period in seconds (default: 3600 = 1 hour)
 */
export async function getSilencePeriod(db: D1Database): Promise<number> {
  const settings = await getAllSettings(db);
  return settings.silence_period_seconds;
}
