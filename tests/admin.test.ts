// tests/admin.test.ts
// Admin gate tests: Basic Auth, CSRF header requirement, token masking,
// and the destructive endpoints sitting behind the gate.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { network } from './network';
import {
  DB,
  getProject,
  getSetting,
  resetDb,
  seedCheck,
  seedProject,
  setSetting,
  setSlackSettings,
  TEST_SLACK,
} from './utils';

const ADMIN_PASSWORD = 'test-admin-token';
const basic = (password: string) => `Basic ${btoa(`admin:${password}`)}`;
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

beforeEach(async () => {
  await resetDb();
});

describe('GET /admin — Basic Auth gate', () => {
  it('rejects unauthenticated access with a WWW-Authenticate challenge', async () => {
    const res = await SELF.fetch('http://localhost/admin');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic realm="watch-dog-admin"');
  });

  it('rejects a wrong password', async () => {
    const res = await SELF.fetch('http://localhost/admin', {
      headers: { Authorization: basic('wrong-password') },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct password (any username)', async () => {
    const res = await SELF.fetch('http://localhost/admin', {
      headers: { Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Admin Dashboard');
  });

  it('never echoes the stored Slack token into the page', async () => {
    await setSetting('slack_api_token', TEST_SLACK.api_token);
    await setSetting('slack_channel_critical', TEST_SLACK.channel_critical);

    const res = await SELF.fetch('http://localhost/admin', {
      headers: { Authorization: basic(ADMIN_PASSWORD) },
    });
    const html = await res.text();

    expect(html).not.toContain(TEST_SLACK.api_token); // full secret must not appear
    expect(html).toContain('••••••••1234'); // masked hint instead
    expect(html).toContain(TEST_SLACK.channel_critical); // non-secrets still prefilled
  });
});

describe('admin mutations — CSRF guard', () => {
  it('blocks mutating requests without an XHR marker header (even with auth)', async () => {
    const res = await SELF.fetch('http://localhost/admin/settings/slack', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'channel_critical=C_NEW',
    });
    expect(res.status).toBe(403);
  });

  it('blocks mutations without auth even with the header', async () => {
    const res = await SELF.fetch('http://localhost/admin/settings/slack', {
      method: 'POST',
      headers: { ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'channel_critical=C_NEW',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /admin/settings/slack', () => {
  it('saves settings and keeps the stored token when the field is empty', async () => {
    await setSetting('slack_api_token', TEST_SLACK.api_token);

    const res = await SELF.fetch('http://localhost/admin/settings/slack', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'api_token=&channel_critical=C_NEW&channel_success=C_S&channel_warning=C_W&channel_info=C_I&silence_period_seconds=1800',
    });
    expect(res.status).toBe(200);

    expect(await getSetting('slack_api_token')).toBe(TEST_SLACK.api_token); // untouched
    expect(await getSetting('slack_channel_critical')).toBe('C_NEW');
    expect(await getSetting('silence_period_seconds')).toBe('1800');
  });

  it('rotates the token when a new value is submitted', async () => {
    await setSetting('slack_api_token', TEST_SLACK.api_token);

    const res = await SELF.fetch('http://localhost/admin/settings/slack', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'api_token=xoxb-rotated-9999&channel_critical=C&channel_success=C&channel_warning=C&channel_info=C&silence_period_seconds=3600',
    });
    expect(res.status).toBe(200);
    expect(await getSetting('slack_api_token')).toBe('xoxb-rotated-9999');
  });
});

describe('admin project/check management', () => {
  beforeEach(async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
  });

  it('DELETE /admin/projects/:id requires the XHR marker (CSRF guard covers destructive verbs)', async () => {
    const res = await SELF.fetch('http://localhost/admin/projects/svc', {
      method: 'DELETE',
      headers: { Authorization: basic(ADMIN_PASSWORD) }, // no X-Requested-With
    });
    expect(res.status).toBe(403);
    expect(await getProject('svc')).not.toBeNull(); // nothing was deleted
  });

  it('DELETE /admin/projects/:id removes the project, checks and logs', async () => {
    await DB.prepare("INSERT INTO logs (check_id, status, created_at) VALUES ('svc:health', 'ok', 0)").run();

    const res = await SELF.fetch('http://localhost/admin/projects/svc', {
      method: 'DELETE',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Deleted')).toBe('true');

    expect(await getProject('svc')).toBeNull();
    const logs = await DB.prepare("SELECT COUNT(*) AS n FROM logs WHERE check_id LIKE 'svc:%'").first<{ n: number }>();
    expect(logs?.n).toBe(0);
  });

  it('DELETE /admin/checks/:id removes a single check', async () => {
    const res = await SELF.fetch('http://localhost/admin/checks/svc:health', {
      method: 'DELETE',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR },
    });
    expect(res.status).toBe(200);
    expect(await DB.prepare('SELECT * FROM checks WHERE id = ?').bind('svc:health').first()).toBeNull();
    expect(await getProject('svc')).not.toBeNull(); // project survives
  });

  it('POST /admin/projects/:id/maintenance mutes and unmutes', async () => {
    const on = await SELF.fetch('http://localhost/admin/projects/svc/maintenance', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'enabled=true&duration=600',
    });
    expect(on.status).toBe(200);
    expect((await on.json<{ maintenance_mode: boolean }>()).maintenance_mode).toBe(true);

    const off = await SELF.fetch('http://localhost/admin/projects/svc/maintenance', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'enabled=false',
    });
    expect((await off.json<{ maintenance_mode: boolean }>()).maintenance_mode).toBe(false);
  });

  it('POST /admin/projects/new creates a project with a default self check', async () => {
    const res = await SELF.fetch('http://localhost/admin/projects/new', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'project_id=new-proj&display_name=New+Proj&token=abcdef1234567890abcdef',
    });
    expect(res.status).toBe(200);

    const project = await getProject('new-proj');
    expect(project?.display_name).toBe('New Proj');
    const self = await DB.prepare('SELECT * FROM checks WHERE id = ?').bind('new-proj:self').first();
    expect(self).not.toBeNull();
  });

  it('POST /admin/projects/new rejects a weak token (<16 chars, server-side #17)', async () => {
    const res = await SELF.fetch('http://localhost/admin/projects/new', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'project_id=weak-proj&display_name=Weak&token=short',
    });
    expect(res.status).toBe(200); // htmx fragment convention: errors render as HTML
    const text = await res.text();
    expect(text).toContain('at least 16 characters');
    expect(await getProject('weak-proj')).toBeNull();
  });

  it('POST /admin/projects/new rejects a project_id outside the safe charset (stored-XSS hardening)', async () => {
    const evilId = "a' || alert(1) || '";
    const res = await SELF.fetch('http://localhost/admin/projects/new', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        project_id: evilId,
        display_name: 'Evil',
        token: 'abcdef1234567890abcdef',
      }).toString(),
    });
    expect(res.status).toBe(200); // htmx fragment convention: errors render as HTML
    const text = await res.text();
    expect(text).toContain('Invalid Project ID');
    expect(text).not.toContain(evilId); // the payload is never echoed back

    expect(await getProject(evilId)).toBeNull();
  });
});

describe('public dashboard', () => {
  it('GET / renders without auth but has no maintenance mute buttons', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });

    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Test Project'); // display name is rendered
    // The public dashboard must not expose maintenance controls anymore
    expect(html).not.toContain('hx-post="/api/maintenance/');
  });
});

describe('admin feature round 2026-09-05 — slack-test / token lifecycle / logs', () => {
  beforeEach(async () => {
    await resetDb();
    await setSlackSettings();
  });

  const postForm = (url: string, body: string) =>
    SELF.fetch(`http://localhost${url}`, {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('POST /admin/settings/slack-test delivers to the level channel and reports ok', async () => {
    let posted = '';
    network.use(http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      posted = await request.text();
      return HttpResponse.json({ ok: true });
    }));

    const res = await postForm('/admin/settings/slack-test', 'level=critical');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
    expect(posted).toContain(TEST_SLACK.channel_critical);
  });

  it('POST /admin/settings/slack-test surfaces Slack API errors as ok:false', async () => {
    network.use(http.post('https://slack.com/api/chat.postMessage', () =>
      HttpResponse.json({ ok: false, error: 'channel_not_found' })));

    const res = await postForm('/admin/settings/slack-test', 'level=warning');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; error?: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('channel_not_found');
  });

  it('POST /admin/settings/slack-test reports unconfigured token instead of silently passing', async () => {
    await DB.prepare('DELETE FROM settings').run();

    const res = await postForm('/admin/settings/slack-test', 'level=recovery');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; error?: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not configured');
  });

  it('POST /admin/settings/slack-test rejects an invalid level (400)', async () => {
    const res = await postForm('/admin/settings/slack-test', 'level=info');
    expect(res.status).toBe(400);
  });

  it('GET /admin/generate-token returns a 48-hex token (enroll.sh-equivalent)', async () => {
    const res = await SELF.fetch('http://localhost/admin/generate-token', {
      headers: { Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('POST /admin/projects/:id/rotate-token rotates — old token 403, new token works', async () => {
    await seedProject({ id: 'svc', token: 'old-token-1234567890abcdef' });

    const res = await SELF.fetch('http://localhost/admin/projects/svc/rotate-token', {
      method: 'POST',
      headers: { Authorization: basic(ADMIN_PASSWORD), ...XHR },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const match = text.match(/[0-9a-f]{48}/);
    if (!match) throw new Error(`no token revealed in fragment: ${text.slice(0, 120)}`);
    const newToken = match[0];
    expect(await getProject('svc')).toMatchObject({ token: newToken });

    // the revealed-once fragment is behind the auth gate
    expect(text).toContain('只顯示這一次');

    const configWith = (token: string) =>
      SELF.fetch('http://localhost/api/config', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'svc', display_name: 'Svc', checks: [] }),
      });
    expect((await configWith('old-token-1234567890abcdef')).status).toBe(403);
    expect((await configWith(newToken)).status).toBe(200);
  });

  it('GET /admin/logs filters by project, respects limit, requires auth', async () => {
    await seedProject({ id: 'a', token: 'tok-a-1234567890' });
    await seedProject({ id: 'b', token: 'tok-b-1234567890' });
    for (let i = 0; i < 3; i++) {
      await DB.prepare("INSERT INTO logs (check_id, status, latency, message, created_at) VALUES ('a:hb', 'ok', 10, 'm', ?)")
        .bind(1700000000 + i)
        .run();
    }
    await DB.prepare("INSERT INTO logs (check_id, status, created_at) VALUES ('b:hb', 'ok', 1700000000)").run();

    const unauth = await SELF.fetch('http://localhost/admin/logs');
    expect(unauth.status).toBe(401);

    const res = await SELF.fetch('http://localhost/admin/logs?project=a&limit=2', {
      headers: { Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('a:hb');
    expect(text).not.toContain('b:hb');
    expect((text.match(/<tr>/g) ?? []).length).toBe(2); // limit honored
  });

  it('GET /admin/logs escapes LIKE wildcards in the project prefix', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedProject({ id: 'svc-2', token: 'tok-1234567891' });
    await DB.prepare("INSERT INTO logs (check_id, status, created_at) VALUES ('svc:hb', 'ok', 1700000000)").run();
    await DB.prepare("INSERT INTO logs (check_id, status, created_at) VALUES ('svc-2:hb', 'ok', 1700000000)").run();

    const res = await SELF.fetch('http://localhost/admin/logs?project=svc', {
      headers: { Authorization: basic(ADMIN_PASSWORD) },
    });
    const text = await res.text();
    expect(text).toContain('svc:hb');
    expect(text).not.toContain('svc-2:hb'); // anchored on `project:` — no sibling bleed
  });
});
