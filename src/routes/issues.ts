// src/routes/issues.ts
// Issues collector + Windmill remediation lane routes (2026-10-31).
//
// 兩個獨立靜態 Bearer secret（皆 optional wiring，缺 → fail-closed 503）：
// - ISSUES_INGEST_TOKEN：CF generic webhook 走 cf-webhook-auth header
//   （Notifications 標準機制）；Authorization Bearer 同值也收（curl 手測用）。
// - WINDMILL_TOKEN：Windmill（rn4g-1）pull / claim / feedback / heartbeat。
//
// Mount 順序：本檔在 adminRoutes 之前（同 trigger.ts 規則——admin 的
// app-wide Basic Auth gate 不得攔住機器對機器端點）。

import { Hono } from 'hono';
import type { AppBindings, Issue, Project } from '../types';
import { extractProjectToken, timingSafeEqual } from '../lib/auth';
import {
  claimIssue,
  feedbackIssue,
  ingestIssue,
  listClaimableIssues,
  parseCfWebhook,
  reportIssue,
  windmillHeartbeat,
  type FeedbackStatus,
} from '../services/issues';
import { IssuesContent } from '../views/issues';
import { Layout } from '../views/layout';

const issues = new Hono<{ Bindings: AppBindings }>();

// ============================================================================
// 信號迴路 — POST /api/ingest/issues（CF Issues Automations → 這裡）
// ============================================================================

issues.post('/api/ingest/issues', async (c) => {
  // CF generic webhook 把 secret 放 cf-webhook-auth header（官方機制）；
  // Bearer 同值也收，方便 curl 手測。兩者任一命中即可。
  const expected = c.env.ISSUES_INGEST_TOKEN;
  if (!expected) {
    return c.json({ error: 'issues ingest disabled (ISSUES_INGEST_TOKEN not set)' }, 503);
  }
  const headerToken =
    c.req.header('cf-webhook-auth') ??
    (() => {
      const auth = c.req.header('Authorization') ?? '';
      return auth.startsWith('Bearer ') ? auth.slice(7) : '';
    })();
  if (!headerToken || !timingSafeEqual(headerToken, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const ingested = parseCfWebhook(raw);
  if (!ingested) {
    // 非 object body——記不下任何東西，明確拒絕（CF 不送這種，人類才會）。
    return c.json({ error: 'payload must be a JSON object' }, 400);
  }

  try {
    const result = await ingestIssue(c.env.DB, ingested);
    return c.json({ ok: true, issue_id: result.issueId, changed: result.changed, state: result.state });
  } catch (error) {
    console.error('issues ingest error:', error);
    return c.json({ error: 'ingest failed' }, 500);
  }
});

// ============================================================================
// 來源 B — POST /api/issues/report（服務自評分級的主動掛號，WATCHDOG-016）
// 認證同 /api/pulse：project token（token 即身分，project 由 token 反查）。
// ============================================================================

issues.post('/api/issues/report', async (c) => {
  const token = extractProjectToken(c);
  if (!token) {
    return c.json({ error: 'Missing Authorization header (use: Authorization: Bearer {token})' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return c.json({ error: 'Missing required field: title' }, 400);
  const severity = body.severity;
  if (severity !== undefined && severity !== 'warning' && severity !== 'critical') {
    return c.json({ error: "severity must be 'warning' | 'critical'" }, 400);
  }

  const project = await c.env.DB
    .prepare('SELECT * FROM projects WHERE token = ?')
    .bind(token)
    .first<Project>();
  if (!project) return c.json({ error: 'Invalid token' }, 403);

  try {
    const result = await reportIssue(c.env.DB, project, {
      title,
      severity,
      fingerprint: typeof body.fingerprint === 'string' && body.fingerprint.trim() ? body.fingerprint.trim() : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      checkName: typeof body.check_name === 'string' ? body.check_name : undefined,
    });
    return c.json({
      ok: true,
      issue_id: result.issueId,
      changed: result.changed,
      state: result.state,
    });
  } catch (error) {
    console.error('issues report error:', error);
    return c.json({ error: 'report failed' }, 500);
  }
});

// ============================================================================
// 任務迴路 — Windmill API（WINDMILL_TOKEN）
// ============================================================================

/** Windmill claim 前置：驗 WINDMILL_TOKEN，回應已寫好則直接回傳。 */
const windmillAuth = (c: { env: AppBindings; req: { header(name: string): string | undefined } }) => {
  const expected = c.env.WINDMILL_TOKEN;
  if (!expected) return { status: 503 as const };
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return timingSafeEqual(token, expected) ? { status: 200 as const } : { status: 401 as const };
};

const toWindmillIssue = (issue: Issue) => ({
  id: issue.id,
  fingerprint: issue.fingerprint,
  script_name: issue.script_name,
  project_id: issue.project_id,
  title: issue.title,
  alert_type: issue.alert_type,
  state: issue.state,
  attempt_count: issue.attempt_count,
  max_auto_attempts: 2,
  first_seen: issue.first_seen,
  last_seen: issue.last_seen,
  claimed_at: issue.claimed_at,
  payload: issue.payload,
});

issues.get('/api/windmill/issues', async (c) => {
  const auth = windmillAuth(c);
  if (auth.status !== 200) {
    return c.json({ error: auth.status === 503 ? 'windmill API disabled (WINDMILL_TOKEN not set)' : 'unauthorized' }, auth.status);
  }
  try {
    const list = await listClaimableIssues(c.env.DB);
    return c.json({ ok: true, count: list.length, issues: list.map(toWindmillIssue) });
  } catch (error) {
    console.error('windmill list error:', error);
    return c.json({ error: 'list failed' }, 500);
  }
});

issues.post('/api/windmill/heartbeat', async (c) => {
  const auth = windmillAuth(c);
  if (auth.status !== 200) {
    return c.json({ error: auth.status === 503 ? 'windmill API disabled (WINDMILL_TOKEN not set)' : 'unauthorized' }, auth.status);
  }
  try {
    await windmillHeartbeat(c.env.DB);
    return c.json({ ok: true });
  } catch (error) {
    console.error('windmill heartbeat error:', error);
    return c.json({ error: 'heartbeat failed' }, 500);
  }
});

issues.post('/api/windmill/issues/:id/claim', async (c) => {
  const auth = windmillAuth(c);
  if (auth.status !== 200) {
    return c.json({ error: auth.status === 503 ? 'windmill API disabled (WINDMILL_TOKEN not set)' : 'unauthorized' }, auth.status);
  }
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid issue id' }, 400);

  try {
    const result = await claimIssue(c.env.DB, id);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error, issue: result.issue ? toWindmillIssue(result.issue) : undefined }, result.status);
    }
    return c.json({ ok: true, issue: toWindmillIssue(result.issue) });
  } catch (error) {
    console.error('windmill claim error:', error);
    return c.json({ error: 'claim failed' }, 500);
  }
});

issues.post('/api/windmill/issues/:id/feedback', async (c) => {
  const auth = windmillAuth(c);
  if (auth.status !== 200) {
    return c.json({ error: auth.status === 503 ? 'windmill API disabled (WINDMILL_TOKEN not set)' : 'unauthorized' }, auth.status);
  }
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid issue id' }, 400);

  let body: { status?: string; message?: string };
  try {
    body = await c.req.json<{ status?: string; message?: string }>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const status = body.status;
  if (status !== 'done' && status !== 'failed' && status !== 'skipped') {
    return c.json({ error: "status must be 'done' | 'failed' | 'skipped'" }, 400);
  }

  try {
    const result = await feedbackIssue(c.env.DB, id, status as FeedbackStatus, body.message);
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, state: result.state });
  } catch (error) {
    console.error('windmill feedback error:', error);
    return c.json({ error: 'feedback failed' }, 500);
  }
});

// ============================================================================
// 待處理 log 觀察頁 — GET /issues（公開唯讀，同首頁方針：只顯示
// title/狀態/認領標記等詮釋資料，raw payload 留在 DB）
// ============================================================================

issues.get('/issues', async (c) => {
  const db = c.env.DB;
  const isHtmx = c.req.header('HX-Request');

  try {
    const result = await db
      .prepare('SELECT * FROM issues ORDER BY last_seen DESC LIMIT 100')
      .all<Issue>();
    const rows = result.results;
    const counts = {
      open: rows.filter((r) => r.state === 'open').length,
      claimed: rows.filter((r) => r.state === 'claimed').length,
      escalated: rows.filter((r) => r.state === 'escalated').length,
      done: rows.filter((r) => r.state === 'done').length,
      resolved: rows.filter((r) => r.state === 'resolved').length,
    };
    const content = IssuesContent(rows, counts);
    // htmx 輪詢換 fragment；整頁帶 Layout shell。
    if (isHtmx) return c.html(content);
    return c.html(Layout({ title: '待處理 log — Watch-Dog Sentinel', content }));
  } catch (error) {
    console.error('issues page error:', error);
    return c.json({ error: 'failed to load issues' }, 500);
  }
});

export default issues;
