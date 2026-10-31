// src/services/issues.ts
// Issues collector state machine (2026-10-31, WATCHDOG-015).
//
// 信號迴路：CF Workers Issues Automations → generic webhook → POST
// /api/ingest/issues（本模組 ingestIssue）。Payload = Cloudflare
// Notifications 標準 schema（name/text/data/ts/account_id/alert_type/
// alert_correlation_id/alert_event）；secret 走 cf-webhook-auth header。
//
// 任務迴路：Windmill（rn4g-1 VPS）GET /api/windmill/issues → claim →
// 處置 → feedback write-back（本模組 claimIssue / feedbackIssue）。
//
// 保險絲（防「閉環變飛輪」）：
//   ① 同一 fingerprint 自動處理上限 MAX_AUTO_ATTEMPTS 次，超過 → escalated
//     （critical 警報 + email，人工接手，Windmill 不得再碰）。
//   ② claim 時自動把映射 project 設 maintenance（MAINT_WINDOW_SEC）——
//     修復部署自產的異常不再回流自己的佇列（自吞噬循環解）。
//
// Invariant ①（fail-dead）：本模組完全不在 cron 偵測路徑上；ingest 掛了
// 只影響 issue 收集，心跳死亡偵測照常運轉。

import { D1Database } from '@cloudflare/workers-types';
import type { Check, IngestedIssue, Issue, Project } from '../types';
import { sendSlackAlert } from './alert';
import type { AlertLevel } from './alert';
import { processCheckResult } from './logic';

/** 自動處理嘗試上限（同一 episode；resolved 後歸零重新計數）。 */
export const MAX_AUTO_ATTEMPTS = 2;

/** Claim 時自動設定的 maintenance 窗口（45 分鐘，覆蓋修復部署 + 收斂觀察）。 */
export const MAINT_WINDOW_SEC = 2700;

/** Windmill claim 洩漏回收：claimed 超過此秒數未被 feedback → 視同可重認領
 * （Windmill crash 後 issue 不會卡死在 claimed）。 */
export const CLAIM_STALE_SEC = 1800;

/** Raw payload 截斷（僅存 DB 診斷用，不進公開頁面）。 */
const PAYLOAD_MAX = 8000;

/** feedback message 截斷。 */
const DETAIL_MAX = 2000;

/** —— Slack 告警（複用既有 channels/cooldown 基礎設施） —— */

interface IssueAlertInput {
  issue: Issue;
  level: AlertLevel;
  title: string;
  message: string;
  emailWorthy?: boolean;
}

const sendIssueAlert = (db: D1Database, { issue, level, title, message, emailWorthy }: IssueAlertInput) =>
  sendSlackAlert(db, {
    checkId: `issue:${issue.fingerprint}`,
    projectName: issue.project_id ?? issue.script_name ?? '未映射 script',
    checkName: 'CF Issue',
    level,
    title,
    message,
    url: '/issues',
    metadata: {
      script: issue.script_name ?? '(unknown)',
      attempts: issue.attempt_count,
      state: issue.state,
    },
    emailWorthy,
  });

/** —— Payload 解析（tolerant：欄位缺漏不拒收，降級記錄） —— */

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Parse a CF generic-webhook payload (Notifications schema) into the
 * collector's canonical shape. Returns null only when the body isn't a JSON
 * object at all — a malformed-but-object payload is still recorded (title
 * degrades to `text`/`name`) so the observation page never silently drops
 * events. Exact `data` sub-fields for Issues automations are documented
 * varyingly across alert types; key candidates are tried in order and the
 * full raw payload is kept in DB for later verification against live data.
 */
export function parseCfWebhook(raw: unknown): IngestedIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const data = (typeof body.data === 'object' && body.data !== null ? body.data : {}) as Record<string, unknown>;
  const episode = (typeof data.episode === 'object' && data.episode !== null ? data.episode : {}) as Record<string, unknown>;
  const config = (typeof data.config === 'object' && data.config !== null ? data.config : {}) as Record<string, unknown>;

  const alertType = asString(body.alert_type);
  const accountId = asString(body.account_id);
  const episodeId = asString(episode.id);

  // Fingerprint: alert_correlation_id groups related alerts (the documented
  // purpose of the field). Fallback keeps determinism without it.
  const correlation = asString(body.alert_correlation_id);
  const fingerprint = (correlation ?? `${alertType ?? 'unknown'}:${accountId ?? ''}:${episodeId ?? asString(body.name) ?? 'no-id'}`).slice(0, 200);

  // Event kind: ALERT_STATE_EVENT_END = the alert episode ended = resolved.
  // Tolerant match — non-string or unseen values default to triggered
  // (fail-loud beats silently dropping an active issue).
  const alertEvent = asString(body.alert_event) ?? '';
  const kind: 'triggered' | 'resolved' = /_END\b|RESOLV|RECOVER/i.test(alertEvent) ? 'resolved' : 'triggered';

  const title = (asString(episode.summary) ?? asString(body.text) ?? asString(body.name) ?? 'CF Issue').slice(0, 500);

  const scriptName =
    asString(data.scriptName) ??
    asString(data.script_name) ??
    asString(data.script) ??
    asString(data.worker) ??
    asString(config.name) ??
    asString(data.service);

  return {
    fingerprint,
    kind,
    title,
    scriptName,
    accountId,
    alertType,
    payloadJson: JSON.stringify(body).slice(0, PAYLOAD_MAX),
  };
}

/** —— 事件史 helper —— */

const logEvent = (db: D1Database, issueId: number, event: string, actor: 'cf-issues' | 'windmill' | 'fuse' | 'report', detail: Record<string, unknown>) =>
  db
    .prepare('INSERT INTO issue_events (issue_id, event, actor, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(issueId, event, actor, JSON.stringify(detail).slice(0, DETAIL_MAX), Math.floor(Date.now() / 1000))
    .run();

const getIssue = (db: D1Database, id: number) =>
  db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<Issue>();

const mapProject = async (db: D1Database, scriptName: string | null): Promise<string | null> => {
  if (!scriptName) return null;
  const row = await db
    .prepare('SELECT project_id FROM issue_map WHERE script_name = ?')
    .bind(scriptName)
    .first<{ project_id: string }>();
  return row?.project_id ?? null;
};

const inMaintenance = async (db: D1Database, projectId: string | null): Promise<boolean> => {
  if (!projectId) return false;
  const row = await db
    .prepare('SELECT maintenance_until FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ maintenance_until: number }>();
  return (row?.maintenance_until ?? 0) > Math.floor(Date.now() / 1000);
};

/** —— 信號迴路：ingest —— */

export interface IngestResult {
  issueId: number;
  /** 狀態是否有變（false = 重複事件去重吸收） */
  changed: boolean;
  state: Issue['state'];
}

/**
 * Ingest one parsed CF webhook event. Dedup by fingerprint; regressions
 * (issue fires again after resolve) open a NEW episode with attempt counter
 * reset — the 2-attempt fuse is per-episode, not per-fingerprint-forever.
 */
export async function ingestIssue(db: D1Database, ing: IngestedIssue): Promise<IngestResult> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare('SELECT * FROM issues WHERE fingerprint = ?')
    .bind(ing.fingerprint)
    .first<Issue>();

  if (!existing) {
    const projectId = await mapProject(db, ing.scriptName);
    const res = await db
      .prepare(`
        INSERT INTO issues (
          fingerprint, account_id, script_name, project_id, title, alert_type,
          state, attempt_count, alerted, last_event, payload, first_seen, last_seen
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      `)
      .bind(
        ing.fingerprint, ing.accountId, ing.scriptName, projectId, ing.title, ing.alertType,
        ing.kind === 'resolved' ? 'resolved' : 'open',
        ing.kind, ing.payloadJson, now, now
      )
      .run();
    const issueId = res.meta.last_row_id;
    const fresh = await getIssue(db, issueId);
    // Late-arriving resolved (first event we see is the END) = record only,
    // no alert. Fresh trigger = warning alert unless the project is in
    // maintenance (deploy-window noise).
    if (fresh && ing.kind === 'triggered' && !(await inMaintenance(db, fresh.project_id))) {
      await sendIssueAlert(db, {
        issue: fresh,
        level: 'warning',
        title: 'CF Issue 開啟',
        message: ing.title,
      });
      await db.prepare('UPDATE issues SET alerted = 1 WHERE id = ?').bind(issueId).run();
      fresh.alerted = 1;
    }
    await logEvent(db, issueId, `cf-${ing.kind}`, 'cf-issues', { title: ing.title, projectId });
    return { issueId, changed: true, state: fresh?.state ?? 'open' };
  }

  // Existing issue — refresh volatile fields first.
  const projectId = existing.project_id ?? (await mapProject(db, ing.scriptName));
  await db
    .prepare(`
      UPDATE issues SET last_seen = ?, last_event = ?, payload = ?, title = ?,
        script_name = COALESCE(?, script_name), project_id = COALESCE(?, project_id)
      WHERE id = ?
    `)
    .bind(now, ing.kind, ing.payloadJson, ing.title, ing.scriptName, projectId, existing.id)
    .run();

  if (ing.kind === 'resolved') {
    // Resolved closes ANY state (open/claimed/done/escalated) and resets the
    // episode: attempts and alerted go back to zero. Recovery notice only
    // when the operator was actually told about this episode.
    const wasAlerted = existing.alerted === 1;
    await db
      .prepare(`
        UPDATE issues SET state = 'resolved', resolved_at = ?, attempt_count = 0,
          alerted = 0, escalated_at = NULL, claimed_at = NULL, claimed_by = NULL
        WHERE id = ?
      `)
      .bind(now, existing.id)
      .run();
    if (wasAlerted) {
      const updated = await getIssue(db, existing.id);
      if (updated) {
        await sendIssueAlert(db, {
          issue: updated,
          level: 'recovery',
          title: 'CF Issue 已解決',
          message: ing.title,
        });
      }
    }
    await logEvent(db, existing.id, 'cf-resolved', 'cf-issues', { prevState: existing.state });
    return { issueId: existing.id, changed: true, state: 'resolved' };
  }

  // Triggered on an existing row.
  if (existing.state === 'resolved' || existing.state === 'done') {
    // Regression: CF re-fired after a resolve (or we marked done and CF
    // disagrees) → new episode, counters reset, alert again.
    await db
      .prepare(`
        UPDATE issues SET state = 'open', attempt_count = 0, alerted = 0,
          resolved_at = NULL, escalated_at = NULL, claimed_at = NULL, claimed_by = NULL
        WHERE id = ?
      `)
      .bind(existing.id)
      .run();
    const updated = await getIssue(db, existing.id);
    if (updated && !(await inMaintenance(db, updated.project_id))) {
      await sendIssueAlert(db, {
        issue: updated,
        level: 'warning',
        title: 'CF Issue 復發（新 episode）',
        message: ing.title,
      });
      await db.prepare('UPDATE issues SET alerted = 1 WHERE id = ?').bind(existing.id).run();
    }
    await logEvent(db, existing.id, 'cf-regressed', 'cf-issues', { prevState: existing.state });
    return { issueId: existing.id, changed: true, state: 'open' };
  }

  if (existing.state === 'escalated') {
    // Fuse already tripped — operator knows. Record the event, stay put
    // (Windmill must NOT get another crack via re-open).
    await logEvent(db, existing.id, 'cf-triggered', 'cf-issues', { note: 'escalated, no-op', prevState: 'escalated' });
    return { issueId: existing.id, changed: false, state: 'escalated' };
  }

  // open / claimed duplicate trigger — dedup: event noted, no state change,
  // no re-alert (CF retries + threshold crossings must not spam).
  await logEvent(db, existing.id, 'cf-triggered', 'cf-issues', { note: 'dedup', prevState: existing.state });
  return { issueId: existing.id, changed: false, state: existing.state };
}

/** —— 來源 B：服務自評分級的主動掛號（WATCHDOG-016，2026-10-31） ——
 *
 * CF Issues（來源 A）的三盲區由這條通道補：handled error（接住降級回 200）、
 * 業務異常（回 200 但行為不對）、服務級高頻/低頻判斷。與來源 A 同一個
 * 狀態機、同一個 Windmill 車道、同一個觀察頁；audit trail 靠 actor='report'
 * 區分（不加 schema 欄位）。
 *
 * 分級責任在服務端（指引見 docs/client-guide.md）：什麼讓它拋（CF 抓）、
 * 什麼 console.error（CF 抓）、什麼掛號（handled+業務異常）、什麼不上報。
 * 服務端必須先聚合再掛號——同款錯誤自 throttle，不 raw 轟（重複掛號在
 * 這裡被 fingerprint 去重吸收，但濫用仍會洗版觀察頁 last_seen）。
 */

export interface ReportIssueInput {
  /** 問題標題（必填，≤500） */
  title: string;
  /** warning（預設）→ warning 頻道；critical → critical 頻道＋email */
  severity?: 'warning' | 'critical';
  /** 服務自訂去重鍵（≤200）；缺省 = report:{project_id}:{title} */
  fingerprint?: string;
  /** 詳情（截 2000，進 audit 與 payload） */
  message?: string;
  /** 服務內的 check 名（選填，診斷關聯用） */
  checkName?: string;
}

/**
 * 掛號一筆服務自評異常。語義與 ingestIssue 的 triggered 路徑同構：
 * 新指紋 → open＋警報（maintenance 靜音同構）；重複 → 去重不重警；
 * resolved/done 後再掛 → regression 開新 episode（attempt 歸零）；
 * escalated → 維持人工狀態不再打擾。
 */
export async function reportIssue(
  db: D1Database,
  project: Project,
  input: ReportIssueInput
): Promise<IngestResult> {
  const now = Math.floor(Date.now() / 1000);
  const title = input.title.slice(0, 500);
  const severity = input.severity === 'critical' ? 'critical' : 'warning';
  const message = (input.message ?? '').slice(0, 2000);
  const fingerprint = (input.fingerprint ?? `report:${project.id}:${title}`).slice(0, 200);
  const payloadJson = JSON.stringify({
    source: 'report',
    severity,
    title,
    message,
    check_name: input.checkName ?? null,
    project_id: project.id,
  }).slice(0, PAYLOAD_MAX);

  const existing = await db
    .prepare('SELECT * FROM issues WHERE fingerprint = ?')
    .bind(fingerprint)
    .first<Issue>();

  const alerted = async (issue: Issue, level: 'warning' | 'critical') => {
    if (await inMaintenance(db, issue.project_id)) return;
    await sendIssueAlert(db, {
      issue,
      level,
      title: level === 'critical' ? '服務掛號 critical 異常' : '服務掛號 warning 異常',
      message: `${title}${message ? ` — ${message}` : ''}`,
      emailWorthy: level === 'critical' || undefined,
    });
    await db.prepare('UPDATE issues SET alerted = 1 WHERE id = ?').bind(issue.id).run();
  };

  if (!existing) {
    const res = await db
      .prepare(`
        INSERT INTO issues (
          fingerprint, account_id, script_name, project_id, title, alert_type,
          state, attempt_count, alerted, last_event, payload, first_seen, last_seen
        )
        VALUES (?, NULL, ?, ?, ?, 'service_report', 'open', 0, 0, 'triggered', ?, ?, ?)
      `)
      .bind(fingerprint, input.checkName ?? null, project.id, title, payloadJson, now, now)
      .run();
    const issueId = res.meta.last_row_id;
    const fresh = await getIssue(db, issueId);
    if (fresh) await alerted(fresh, severity);
    await logEvent(db, issueId, 'report', 'report', { severity, title, attempt: 'new' });
    return { issueId, changed: true, state: 'open' };
  }

  // 既有 issue：更新詮釋資料（title/message 可能帶最新上下文）
  await db
    .prepare('UPDATE issues SET last_seen = ?, title = ?, payload = ? WHERE id = ?')
    .bind(now, title, payloadJson, existing.id)
    .run();

  if (existing.state === 'resolved' || existing.state === 'done') {
    await db
      .prepare(`
        UPDATE issues SET state = 'open', attempt_count = 0, alerted = 0,
          resolved_at = NULL, escalated_at = NULL, claimed_at = NULL, claimed_by = NULL
        WHERE id = ?
      `)
      .bind(existing.id)
      .run();
    const updated = await getIssue(db, existing.id);
    if (updated) await alerted(updated, severity);
    await logEvent(db, existing.id, 'report-regressed', 'report', { prevState: existing.state, severity });
    return { issueId: existing.id, changed: true, state: 'open' };
  }

  if (existing.state === 'escalated') {
    await logEvent(db, existing.id, 'report', 'report', { note: 'escalated, no-op', prevState: 'escalated' });
    return { issueId: existing.id, changed: false, state: 'escalated' };
  }

  // open / claimed 重複掛號——去重吸收，不重警
  await logEvent(db, existing.id, 'report', 'report', { note: 'dedup', prevState: existing.state, severity });
  return { issueId: existing.id, changed: false, state: existing.state };
}

/** Issues available for Windmill: open, plus claims leaked past the lease
 *  (Windmill crash recovery — a claimed issue must never strand forever). */
/** —— 任務迴路：Windmill pull / claim / feedback —— */

export async function listClaimableIssues(db: D1Database): Promise<Issue[]> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(`
      SELECT * FROM issues
      WHERE state = 'open'
         OR (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)
      ORDER BY first_seen ASC LIMIT 20
    `)
    .bind(now - CLAIM_STALE_SEC)
    .all<Issue>();
  return result.results;
}

export type ClaimResult =
  | { ok: true; issue: Issue }
  | { ok: false; status: 404 | 409; error: string; issue?: Issue };

/** Claim an issue for remediation. Enforces the attempt fuse (①) and sets
 *  the maintenance window on the mapped project (②). Idempotency: only
 *  'open' (or stale-claimed) rows are claimable — a live claim returns 409
 *  so two pollers can never double-run the same issue. */
export async function claimIssue(db: D1Database, issueId: number): Promise<ClaimResult> {
  const now = Math.floor(Date.now() / 1000);
  const issue = await getIssue(db, issueId);
  if (!issue) return { ok: false, status: 404, error: 'issue not found' };

  if (issue.state === 'claimed' && issue.claimed_at !== null && issue.claimed_at >= now - CLAIM_STALE_SEC) {
    return { ok: false, status: 409, error: 'already claimed (live lease)', issue };
  }
  if (issue.state !== 'open' && issue.state !== 'claimed') {
    return { ok: false, status: 409, error: `not claimable from state ${issue.state}`, issue };
  }

  const nextAttempt = issue.attempt_count + 1;
  if (nextAttempt > MAX_AUTO_ATTEMPTS) {
    // Fuse ①: automation had its chances — hand to the human, loudly.
    await db
      .prepare("UPDATE issues SET state = 'escalated', escalated_at = ?, last_seen = ? WHERE id = ?")
      .bind(now, now, issueId)
      .run();
    const escalated = await getIssue(db, issueId);
    if (escalated) {
      await sendIssueAlert(db, {
        issue: escalated,
        level: 'critical',
        title: `自動處理達上限（${MAX_AUTO_ATTEMPTS} 次）——人工接手`,
        message: issue.title,
        emailWorthy: true,
      });
    }
    await logEvent(db, issueId, 'escalated', 'fuse', { attempt: nextAttempt, reason: 'max-attempts' });
    return { ok: false, status: 409, error: `max auto attempts (${MAX_AUTO_ATTEMPTS}) reached — escalated to human`, issue: escalated ?? issue };
  }

  await db
    .prepare(`
      UPDATE issues SET state = 'claimed', claimed_at = ?, claimed_by = 'windmill',
        attempt_count = ?, last_seen = ?
      WHERE id = ?
    `)
    .bind(now, nextAttempt, now, issueId)
    .run();

  // Fuse ②: mute the mapped project while remediation deploys — the fix's
  // own error noise must not feed back into this queue.
  if (issue.project_id) {
    await db
      .prepare('UPDATE projects SET maintenance_until = ? WHERE id = ?')
      .bind(now + MAINT_WINDOW_SEC, issue.project_id)
      .run();
  }

  const claimed = await getIssue(db, issueId);
  await logEvent(db, issueId, issue.state === 'claimed' ? 'reclaimed-stale' : 'claimed', 'windmill', {
    attempt: nextAttempt,
    maintUntil: issue.project_id ? now + MAINT_WINDOW_SEC : null,
  });
  return { ok: true, issue: claimed ?? issue };
}

export type FeedbackStatus = 'done' | 'failed' | 'skipped';

export type FeedbackResult =
  | { ok: true; state: Issue['state'] }
  | { ok: false; status: 404 | 409; error: string };

/** Windmill write-back. done → done；failed → open（重試）或 escalated
 *  （fuse）；skipped → escalated（「自動化不接」本身就是需要人工的訊號）。 */
export async function feedbackIssue(
  db: D1Database,
  issueId: number,
  status: FeedbackStatus,
  message: string | undefined
): Promise<FeedbackResult> {
  const now = Math.floor(Date.now() / 1000);
  const issue = await getIssue(db, issueId);
  if (!issue) return { ok: false, status: 404, error: 'issue not found' };
  if (issue.state !== 'claimed') {
    return { ok: false, status: 409, error: `feedback requires claimed state, got ${issue.state}` };
  }

  if (status === 'done') {
    await db
      .prepare("UPDATE issues SET state = 'done', last_seen = ? WHERE id = ?")
      .bind(now, issueId)
      .run();
    await logEvent(db, issueId, 'feedback', 'windmill', { status, message });
    return { ok: true, state: 'done' };
  }

  if (status === 'failed') {
    if (issue.attempt_count >= MAX_AUTO_ATTEMPTS) {
      await db
        .prepare("UPDATE issues SET state = 'escalated', escalated_at = ?, last_seen = ? WHERE id = ?")
        .bind(now, now, issueId)
        .run();
      const escalated = await getIssue(db, issueId);
      if (escalated) {
        await sendIssueAlert(db, {
          issue: escalated,
          level: 'critical',
          title: `自動修復失敗（${issue.attempt_count} 次）——人工接手`,
          message: message ?? issue.title,
          emailWorthy: true,
        });
      }
      await logEvent(db, issueId, 'escalated', 'fuse', { status, message, attempt: issue.attempt_count });
      return { ok: true, state: 'escalated' };
    }
    // Attempts remain → back to open for the next poll cycle.
    await db
      .prepare("UPDATE issues SET state = 'open', claimed_at = NULL, claimed_by = NULL, last_seen = ? WHERE id = ?")
      .bind(now, issueId)
      .run();
    await logEvent(db, issueId, 'feedback', 'windmill', { status, message, retry: true });
    return { ok: true, state: 'open' };
  }

  // skipped — automation declines this class of issue.
  await db
    .prepare("UPDATE issues SET state = 'escalated', escalated_at = ?, last_seen = ? WHERE id = ?")
    .bind(now, now, issueId)
    .run();
  const escalated = await getIssue(db, issueId);
  if (escalated) {
    await sendIssueAlert(db, {
      issue: escalated,
      level: 'warning',
      title: 'Windmill 跳過此 issue——人工檢視',
      message: message ?? issue.title,
    });
  }
  await logEvent(db, issueId, 'escalated', 'windmill', { status, message, reason: 'skipped' });
  return { ok: true, state: 'escalated' };
}

/** —— 監控者迴路：Windmill heartbeat（誰看 Windmill？） —— */

/** Internal project/check ids for the remediation lane's own liveness. The
 *  check is a normal heartbeat check — Windmill stopping its poll cycle
 *  trips the SAME fail-dead machinery that guards every monitored service. */
export const WINDMILL_PROJECT_ID = 'automation';
export const WINDMILL_CHECK_ID = 'automation:windmill-pulse';

/**
 * Record one Windmill heartbeat (called on every poll cycle). Bootstrap-free:
 * the project + check rows are upserted on first call so the operator never
 * has to register them by hand. interval 180s + grace 120s → dead after ~5
 * minutes of silence.
 */
export async function windmillHeartbeat(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const project = await db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .bind(WINDMILL_PROJECT_ID)
    .first<Project>();
  if (!project) {
    // Token is never used for auth by Windmill (that's WINDMILL_TOKEN) — it
    // just satisfies the NOT NULL contract for a projects row. Random per
    // bootstrap, stored only server-side.
    const token = `internal-${crypto.randomUUID()}`;
    await db
      .prepare('INSERT INTO projects (id, token, display_name, maintenance_until, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(WINDMILL_PROJECT_ID, token, '自動處置層（Windmill rn4g-1）', now)
      .run();
  }

  const check = await db.prepare('SELECT * FROM checks WHERE id = ?').bind(WINDMILL_CHECK_ID).first<Check>();
  if (!check) {
    await db
      .prepare(`
        INSERT INTO checks (
          id, project_id, name, display_name, type, interval, grace, threshold, cooldown,
          last_seen, status, failure_count, last_alert_at, last_message, escalated, monitor
        )
        VALUES (?, ?, 'windmill-pulse', 'Windmill 輪詢心跳', 'heartbeat', 180, 120, 1, 900,
                ?, 'ok', 0, 0, NULL, 0, 1)
      `)
      .bind(WINDMILL_CHECK_ID, WINDMILL_PROJECT_ID, now)
      .run();
  }

  const fresh = await db.prepare('SELECT * FROM checks WHERE id = ?').bind(WINDMILL_CHECK_ID).first<Check>();
  const parent = await db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .bind(WINDMILL_PROJECT_ID)
    .first<Project>();
  if (fresh && parent) {
    // Full machinery: recovery alerts, dead-detection by cron, dashboard.
    await processCheckResult(db, fresh, parent, 'ok', 'Windmill poll heartbeat');
  }
}

/** —— Retention（cron 每小時，與 logs cleanup 同班車） —— */

/** resolved/done issues 消失前保留 30 天；事件史隨宿主刪除 + 自身 90 天。 */
export async function cleanupOldIssues(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("DELETE FROM issues WHERE state IN ('resolved', 'done') AND last_seen < ?")
    .bind(now - 30 * 86400)
    .run();
  await db
    .prepare('DELETE FROM issue_events WHERE issue_id NOT IN (SELECT id FROM issues)')
    .run();
  await db
    .prepare('DELETE FROM issue_events WHERE created_at < ?')
    .bind(now - 90 * 86400)
    .run();
}
