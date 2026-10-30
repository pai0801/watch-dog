// tests/issues.test.ts
// Issues 收集器（WATCHDOG-015, 2026-10-31）：ingest 三事件（triggered/
// resolved/復發）、fingerprint 去重、maintenance 靜音、Windmill claim
// 語義、attempt 保險絲、skipped→escalated、heartbeat 引導、觀察頁渲染。

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import { resetDb, seedProject, setSlackSettings } from './utils';

const E = env as unknown as import('../src/types').AppBindings;
const DB = E.DB;
const BASE = 'https://watch-dog.test';
const INGEST_H = { 'cf-webhook-auth': 'test-issues-ingest-token', 'Content-Type': 'application/json' };
const WINDMILL_H = { Authorization: 'Bearer test-windmill-token', 'Content-Type': 'application/json' };

const nowSec = () => Math.floor(Date.now() / 1000);

let slackBodies: string[] = [];

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
  slackBodies = [];
  network.use(
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      slackBodies.push(await request.text());
      return HttpResponse.json({ ok: true });
    })
  );
});

/** CF generic-webhook payload（Notifications schema，workers observability 形狀）。 */
const cfPayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Workers Issues',
  text: 'Worker topreview-hotel threw exceptions',
  data: {
    account: { id: 'acc123', name: 'pai-alpha111' },
    episode: { id: 'ep-1', summary: 'TypeError: fetch failed at line 3' },
    status: 'PENDING',
  },
  ts: nowSec(),
  account_id: 'acc123',
  policy_id: 'pol-1',
  policy_name: 'issues-automation',
  alert_type: 'workers_observability_alert',
  alert_correlation_id: 'corr-abc-001',
  alert_event: 'ALERT_STATE_EVENT_START',
  ...overrides,
});

const ingest = async (payload: Record<string, unknown>, headers: Record<string, string> = INGEST_H) => {
  const res = await SELF.fetch(`${BASE}/api/ingest/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const windmill = async (path: string, init: RequestInit = {}) => {
  const res = await SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...WINDMILL_H, ...((init.headers as Record<string, string>) ?? {}) },
  });
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const getIssueRow = async (fingerprint: string) =>
  DB.prepare('SELECT * FROM issues WHERE fingerprint = ?').bind(fingerprint).first<Record<string, unknown>>();

describe('POST /api/ingest/issues — auth', () => {
  it('503 fail-closed when ISSUES_INGEST_TOKEN wiring is absent (route-level)', async () => {
    const { default: issuesApp } = await import('../src/routes/issues');
    const res = await issuesApp.request('https://watch-dog.test/api/ingest/issues', {
      method: 'POST',
      headers: { 'cf-webhook-auth': 'anything' },
    }, { DB: E.DB } as unknown as import('../src/types').AppBindings);
    expect(res.status).toBe(503);
  });

  it('401 with wrong / missing secret, 200 via cf-webhook-auth header', async () => {
    expect((await ingest(cfPayload(), { 'cf-webhook-auth': 'wrong' })).res.status).toBe(401);
    expect((await ingest(cfPayload(), { 'Content-Type': 'application/json' })).res.status).toBe(401);
    // Bearer 同值也收（curl 手測路徑）
    expect((await ingest(cfPayload(), { Authorization: 'Bearer test-issues-ingest-token' })).res.status).toBe(200);
    expect((await ingest(cfPayload())).res.status).toBe(200);
  });

  it('400 on non-object JSON body', async () => {
    const res = await SELF.fetch(`${BASE}/api/ingest/issues`, {
      method: 'POST',
      headers: INGEST_H,
      body: '"just a string"',
    });
    expect(res.status).toBe(400);
  });
});

describe('ingest — 信號迴路', () => {
  it('triggered creates open issue + warning alert + audit event', async () => {
    const { res, body } = await ingest(cfPayload());
    expect(res.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.state).toBe('open');

    const row = await getIssueRow('corr-abc-001');
    expect(row).not.toBeNull();
    expect(row!['script_name']).toBeNull(); // payload 未帶 script 欄位 → 降級 null
    expect(row!['title']).toBe('TypeError: fetch failed at line 3');
    expect(row!['attempt_count']).toBe(0);

    expect(slackBodies.length).toBe(1);
    expect(slackBodies[0]).toContain('CF Issue 開啟');

    const events = await DB
      .prepare('SELECT * FROM issue_events WHERE event = ?')
      .bind('cf-triggered')
      .all<Record<string, unknown>>();
    expect(events.results.length).toBe(1);
  });

  it('duplicate triggered is deduped (changed=false, no second alert)', async () => {
    await ingest(cfPayload());
    const { body } = await ingest(cfPayload()); // e.g. CF retry
    expect(body.changed).toBe(false);
    expect(slackBodies.length).toBe(1);
    const count = await DB.prepare('SELECT COUNT(*) AS n FROM issues').first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('resolved closes any state, resets attempts, sends recovery only when alerted', async () => {
    await ingest(cfPayload());
    // 模擬已嘗試一次自動處理
    await DB.prepare("UPDATE issues SET attempt_count = 1 WHERE fingerprint = ?").bind('corr-abc-001').run();

    const { body } = await ingest(cfPayload({ alert_event: 'ALERT_STATE_EVENT_END' }));
    expect(body.state).toBe('resolved');
    const row = await getIssueRow('corr-abc-001');
    expect(row!['attempt_count']).toBe(0);
    expect(row!['resolved_at']).not.toBeNull();
    // 開啟時告警過（1 封）→ recovery 第 2 封
    expect(slackBodies.length).toBe(2);
    expect(slackBodies[1]).toContain('已解決');
  });

  it('regression after resolve opens a NEW episode (attempt reset + re-alert)', async () => {
    await ingest(cfPayload());
    await ingest(cfPayload({ alert_event: 'ALERT_STATE_EVENT_END' }));
    const { body } = await ingest(cfPayload()); // 復發
    expect(body.state).toBe('open');
    const row = await getIssueRow('corr-abc-001');
    expect(row!['attempt_count']).toBe(0);
    expect(row!['state']).toBe('open');
    // 開啟(1) + recovery(2) + 復發(3)
    expect(slackBodies.length).toBe(3);
  });

  it('maintenance on the mapped project mutes the trigger alert', async () => {
    await seedProject({ id: 'topreview-hotel', token: 'tok-hotel-12345678', maintenance_until: nowSec() + 600 });
    await DB.prepare('INSERT INTO issue_map (script_name, project_id) VALUES (?, ?)')
      .bind('topreview-hotel-worker', 'topreview-hotel').run();

    await ingest(cfPayload({
      alert_correlation_id: 'corr-maint-1',
      data: {
        account: { id: 'acc123', name: 'x' },
        episode: { id: 'ep-m', summary: 'boom during deploy' },
        scriptName: 'topreview-hotel-worker',
        status: 'PENDING',
      },
    }));

    const row = await getIssueRow('corr-maint-1');
    expect(row!['project_id']).toBe('topreview-hotel');
    expect(row!['alerted']).toBe(0);
    expect(slackBodies.length).toBe(0); // 部署窗口靜音
  });
});

describe('Windmill API — 任務迴路', () => {
  const setupOpen = async (fingerprint = 'corr-w-1', script?: string) => {
    await ingest(
      cfPayload({
        alert_correlation_id: fingerprint,
        data: {
          account: { id: 'a', name: 'x' },
          episode: { id: 'e', summary: `issue ${fingerprint}` },
          ...(script ? { scriptName: script } : {}),
          status: 'PENDING',
        },
      })
    );
    const row = await getIssueRow(fingerprint);
    return row!['id'] as number;
  };

  it('auth: 401 wrong token; heartbeat route 200s and bootstraps the automation check', async () => {
    expect((await windmill('/api/windmill/issues', { headers: { Authorization: 'Bearer wrong' } })).res.status).toBe(401);

    const hb = await windmill('/api/windmill/heartbeat', { method: 'POST' });
    expect(hb.res.status).toBe(200);
    const check = await DB.prepare('SELECT * FROM checks WHERE id = ?').bind('automation:windmill-pulse').first<Record<string, unknown>>();
    expect(check).not.toBeNull();
    expect(nowSec() - (check!['last_seen'] as number)).toBeLessThan(10);

    // 第二次心跳照常（bootstrap 冪等）
    expect((await windmill('/api/windmill/heartbeat', { method: 'POST' })).res.status).toBe(200);
  });

  it('list returns only claimable issues; claim marks + counts attempt + sets maintenance', async () => {
    await seedProject({ id: 'proj-x', token: 'tok-xxx-1234567890' });
    await DB.prepare('INSERT INTO issue_map (script_name, project_id) VALUES (?, ?)').bind('worker-x', 'proj-x').run();
    const id = await setupOpen('corr-w-1', 'worker-x');
    await ingest(cfPayload({ alert_correlation_id: 'corr-w-2' })); // 未映射也 open

    const list = await windmill('/api/windmill/issues');
    expect(list.body.count).toBe(2);

    const claim = await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    expect(claim.res.status).toBe(200);
    expect((claim.body.issue as Record<string, unknown>)['state']).toBe('claimed');

    const row = await getIssueRow('corr-w-1');
    expect(row!['claimed_by']).toBe('windmill');
    expect(row!['claimed_at']).not.toBeNull();
    expect(row!['attempt_count']).toBe(1);

    // Fuse ②：映射 project 自動進 maintenance
    const proj = await DB.prepare('SELECT maintenance_until FROM projects WHERE id = ?').bind('proj-x').first<Record<string, unknown>>();
    expect((proj!['maintenance_until'] as number)).toBeGreaterThan(nowSec() + 2000);

    // Live lease 內不得重複 claim（防雙跑）
    const dup = await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    expect(dup.res.status).toBe(409);
  });

  it('feedback done → done; escalated/resolved 不再出現在 claimable list', async () => {
    const id = await setupOpen('corr-w-2');
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    const fb = await windmill(`/api/windmill/issues/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ status: 'done', message: 'deployed fix #12' }),
    });
    expect(fb.res.status).toBe(200);
    expect(fb.body.state).toBe('done');

    const list = await windmill('/api/windmill/issues');
    expect(list.body.count).toBe(0);
  });

  it('保險絲①：failed 兩次後第三次 claim 被擋並 escalate（critical + email）', async () => {
    const id = await setupOpen('corr-fuse');
    slackBodies = []; // 清掉 ingest 的 warning

    // 嘗試 1：claim → failed → open（可重試）
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    let fb = await windmill(`/api/windmill/issues/${id}/feedback`, { method: 'POST', body: JSON.stringify({ status: 'failed' }) });
    expect(fb.body.state).toBe('open');

    // 嘗試 2：claim → failed → escalate（attempt=2 達上限）
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    fb = await windmill(`/api/windmill/issues/${id}/feedback`, { method: 'POST', body: JSON.stringify({ status: 'failed', message: 'fix did not converge' }) });
    expect(fb.body.state).toBe('escalated');

    const row = await getIssueRow('corr-fuse');
    expect(row!['state']).toBe('escalated');
    expect(row!['escalated_at']).not.toBeNull();
    expect(slackBodies.length).toBe(1);
    expect(slackBodies[0]).toContain('人工接手');

    // escalated 不得再被認領
    const claim = await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    expect(claim.res.status).toBe(409);
  });

  it('skipped → escalated（自動化不接 = 需要人工的訊號）', async () => {
    const id = await setupOpen('corr-skip');
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    const fb = await windmill(`/api/windmill/issues/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ status: 'skipped', message: 'unmapped project' }),
    });
    expect(fb.body.state).toBe('escalated');
    expect(slackBodies.some((b) => b.includes('跳過'))).toBe(true);
  });

  it('stale claim（Windmill crash）30 分鐘後可重認領', async () => {
    const id = await setupOpen('corr-stale');
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    // 模擬認領後 Windmill 掛掉：claimed_at 拉回 40 分鐘前
    await DB.prepare('UPDATE issues SET claimed_at = ? WHERE id = ?').bind(nowSec() - 2400, id).run();

    const reclaim = await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    expect(reclaim.res.status).toBe(200);
    const row = await getIssueRow('corr-stale');
    expect(row!['attempt_count']).toBe(2); // 重認領計入保險絲
  });

  it('feedback rejects non-claimed states and invalid status values', async () => {
    const id = await setupOpen('corr-fb-guard');
    // open（未 claim）→ 409
    expect((await windmill(`/api/windmill/issues/${id}/feedback`, { method: 'POST', body: JSON.stringify({ status: 'done' }) })).res.status).toBe(409);
    await windmill(`/api/windmill/issues/${id}/claim`, { method: 'POST' });
    expect((await windmill(`/api/windmill/issues/${id}/feedback`, { method: 'POST', body: JSON.stringify({ status: 'bogus' }) })).res.status).toBe(400);
  });
});

describe('GET /issues — 待處理 log 觀察頁', () => {
  it('renders publicly with the claim mark and state badges', async () => {
    await ingest(cfPayload({ alert_correlation_id: 'corr-page-1' }));
    const res = await SELF.fetch(`${BASE}/issues`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('TypeError: fetch failed at line 3');
    expect(html).toContain('待處理');
    expect(html).toContain('Windmill');
  });
});
