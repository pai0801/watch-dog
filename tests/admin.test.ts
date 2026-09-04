// tests/admin.test.ts
// Admin gate tests: Basic Auth, CSRF header requirement, token masking,
// and the destructive endpoints sitting behind the gate.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  DB,
  getProject,
  getSetting,
  resetDb,
  seedCheck,
  seedProject,
  setSetting,
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
