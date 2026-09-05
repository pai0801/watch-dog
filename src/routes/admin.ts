// src/routes/admin.ts
// Admin dashboard routes. Every route here sits behind the Basic-Auth gate
// (see middleware/adminAuth.ts) — the token-auth public API lives in api.ts.

import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import type { AppBindings, Check, Project } from '../types';
import { adminAuth } from '../middleware/adminAuth';
import { escapeLikePattern, isValidProjectId } from '../lib/validate';
import { getAllSettings, updateSlackSettings, updateSetting } from '../services/settings';
import { sendSlackAlert, type AlertLevel } from '../services/alert';
import { setMaintenance } from '../services/maintenance';
import { Layout } from '../views/layout';
import { AdminPage, type AdminProject } from '../views/adminViews';
import { ErrorState } from '../views/dashboard';

const admin = new Hono<{ Bindings: AppBindings }>();

// All admin routes require Basic Auth (password = ADMIN_TOKEN secret).
admin.use('*', adminAuth);

/**
 * GET /admin
 * Admin dashboard for managing settings, projects, and checks
 */
admin.get('/admin', async (c) => {
  const db = c.env.DB;

  try {
    // Get all settings
    const settings = await getAllSettings(db);

    // Get all projects
    const projectsResult = await db
      .prepare('SELECT * FROM projects ORDER BY display_name')
      .all<Project>();
    const projects = projectsResult.results;

    // Get all checks
    const checksResult = await db
      .prepare('SELECT * FROM checks ORDER BY project_id, name')
      .all<Check>();
    const checks = checksResult.results;

    // Group checks by project and calculate project status
    const projectsWithChecks: AdminProject[] = projects.map((project) => {
      const projectChecks = checks.filter((check) => check.project_id === project.id);
      // Calculate project status based on worst check status
      let projectStatus: 'ok' | 'error' | 'dead' = 'ok';
      for (const check of projectChecks) {
        if (check.status === 'dead') {
          projectStatus = 'dead';
          break;
        } else if (check.status === 'error' && projectStatus === 'ok') {
          projectStatus = 'error';
        }
      }
      return {
        ...project,
        checks: projectChecks,
        projectStatus,
      };
    });

    return c.html(Layout({ title: 'Admin - Watch-Dog Sentinel', content: AdminPage(settings, projects, projectsWithChecks) }));
  } catch (error) {
    console.error('Admin error:', error);
    return c.html(
      Layout({ title: 'Admin - Watch-Dog Sentinel', content: ErrorState('Error loading admin', 'Unable to fetch data. Please try again.') })
    );
  }
});

/**
 * POST /admin/settings/slack
 * Save Slack settings. An empty api_token field keeps the stored token.
 */
admin.post('/admin/settings/slack', async (c) => {
  const db = c.env.DB;

  try {
    const body = await c.req.parseBody();
    const {
      api_token,
      channel_critical,
      channel_success,
      channel_warning,
      channel_info,
      silence_period_seconds,
    } = body;

    // Update Slack settings and check for success
    const slackSuccess = await updateSlackSettings(db, {
      // Empty field = keep the existing token (the form never echoes it back)
      api_token: (api_token as string) || '',
      channel_critical: channel_critical as string,
      channel_success: channel_success as string,
      channel_warning: channel_warning as string,
      channel_info: channel_info as string,
    });

    if (!slackSuccess) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem; margin-bottom: 1rem;">
          Failed to save Slack settings. Please try again.
        </div>
      `);
    }

    // Update silence period separately and check for success
    const silenceSuccess = await updateSetting(db, 'silence_period_seconds', silence_period_seconds as string);

    if (!silenceSuccess) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem; margin-bottom: 1rem;">
          Failed to save silence period. Please try again.
        </div>
      `);
    }

    // Return success message with HTMX redirect
    return c.html(html`
      <div style="padding: 1rem; background: #2ecc71; color: white; border-radius: 0.5rem; margin-bottom: 1rem;">
        Settings saved successfully!
      </div>
      <script>htmx.trigger(document.body, 'reloadAdmin'); setTimeout(() => htmx.ajax('GET', '/admin', {target: 'body', swap: 'outerHTML'}), 500);</script>
    `);
  } catch (error) {
    console.error('Settings save error:', error);
    return c.html(html`
      <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem; margin-bottom: 1rem;">
        Error saving settings. Please try again.
      </div>
    `);
  }
});

/**
 * POST /admin/settings/slack-test
 * Fire a test alert through the real alert chain (settings → Slack API) and
 * report delivery success/failure — closing the "unverified until a real
 * incident" gap. Level must be one the router actually maps to a channel.
 */
admin.post('/admin/settings/slack-test', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const level = body.level as string;

  if (level !== 'critical' && level !== 'warning' && level !== 'recovery') {
    return c.json({ ok: false, error: 'invalid level (critical | warning | recovery)' }, 400);
  }

  const result = await sendSlackAlert(db, {
    checkId: 'admin:test-alert',
    projectName: 'Watch-Dog Admin',
    checkName: 'Test Alert',
    level: level as AlertLevel,
    title: `測試警報（${level}）`,
    message: '由管理界面發出的測試警報——驗證 Slack 路由設定，可安全忽略。',
    metadata: { Level: level, Source: '/admin → Settings → 測試警報' },
  });
  return c.json(result);
});

/** Cryptographically random project token (48 hex chars, same as openssl rand -hex 24). */
function generateProjectToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * GET /admin/generate-token
 * Random token for the New Project dialog's generate button.
 */
admin.get('/admin/generate-token', (c) => {
  return c.json({ token: generateProjectToken() });
});

/**
 * POST /admin/projects/:projectId/rotate-token
 * Rotate a project's token. The new value is shown exactly once (htmx
 * fragment into the modal container) — same reveal-once model as enroll.sh.
 */
admin.post('/admin/projects/:projectId/rotate-token', async (c) => {
  const db = c.env.DB;
  const projectId = c.req.param('projectId');

  const project = await db
    .prepare('SELECT id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<Project>();
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const token = generateProjectToken();
  await db.prepare('UPDATE projects SET token = ? WHERE id = ?').bind(token, projectId).run();

  return c.html(html`
<div x-data="{ open: true }" x-show="open" style="position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;">
  <div class="modal-dialog" @click.outside="closeModal()" style="background: #242424; padding: 2rem; border-radius: 0.5rem; max-width: 560px; width: 100%;">
    <h3>Token 已輪替 — ${projectId}</h3>
    <p>新 token（<strong>只顯示這一次</strong>）：</p>
    <p><code style="word-break: break-all;">${token}</code></p>
    <p><small>舊 token 已立即失效。請：① 更新 client 專案的 env／secrets；② 同步本機 <code>docs/tokens.local.md</code>（<code>scripts/enroll.sh</code> 的清單不會自動更新）。</small></p>
    <button type="button" class="outline secondary" @click="closeModal()">關閉</button>
  </div>
  <script>
    function closeModal() {
      const container = document.getElementById('modal-container');
      if (container) {
        container.innerHTML = '';
      }
    }
  </script>
</div>
  `);
});

/** Minimal shape of a logs row (written by services/logic.ts writeLog). */
interface LogRow {
  check_id: string;
  status: string;
  latency: number | null;
  message: string | null;
  created_at: number;
}

/**
 * GET /admin/logs?project=&check=&limit=
 * Recent pulse history (logs keep 7 days via cron). Returns a <tbody> fragment
 * for the htmx Logs tab. check_id is `${projectId}:${name}` — project filter
 * matches the `project:` prefix with the id escaped.
 */
admin.get('/admin/logs', async (c) => {
  const db = c.env.DB;
  const project = c.req.query('project') ?? '';
  const check = c.req.query('check') ?? '';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);

  let rows: LogRow[];
  if (check) {
    rows = (await db
      .prepare('SELECT * FROM logs WHERE check_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(check, limit)
      .all<LogRow>()).results;
  } else if (project) {
    rows = (await db
      .prepare("SELECT * FROM logs WHERE check_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
      .bind(`${escapeLikePattern(project)}:%`, limit)
      .all<LogRow>()).results;
  } else {
    rows = (await db
      .prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all<LogRow>()).results;
  }

  return c.html(html`
<tbody>
  ${raw(rows.length === 0 ? html`<tr><td colspan="5" style="color:#888;">（沒有記錄——7 天保留期內無 pulse）</td></tr>` :
    rows.map((r) => html`
    <tr>
      <td>${new Date(r.created_at * 1000).toLocaleString()}</td>
      <td><code>${r.check_id}</code></td>
      <td><span class="status-badge ${r.status === 'ok' ? 'ok' : r.status === 'dead' ? 'dead' : 'error'}">${r.status}</span></td>
      <td>${r.latency ?? '—'}</td>
      <td>${r.message ?? ''}</td>
    </tr>`).join(''))}
</tbody>
  `);
});

/**
 * POST /admin/projects/:projectId/maintenance
 * Mute/unmute a project from the admin UI (same semantics as /api/maintenance).
 */
admin.post('/admin/projects/:projectId/maintenance', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const projectId = c.req.param('projectId');

  try {
    const project = await db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind(projectId)
      .first<Project>();

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    // Accept both form-encoded (htmx hx-vals) and JSON bodies
    let body: { enabled?: boolean | string; duration?: number | string } = {};
    try {
      body = await c.req.parseBody() as typeof body;
    } catch {
      body = await c.req.json< typeof body>();
    }

    const result = await setMaintenance(db, project, body, now);
    return c.json({ success: true, project_id: projectId, ...result });
  } catch (error) {
    console.error('Admin maintenance error:', error);
    return c.json({ error: 'Invalid request' }, 400);
  }
});

/**
 * DELETE /admin/projects/:projectId
 * Delete a project and all its checks
 */
admin.delete('/admin/projects/:projectId', async (c) => {
  const db = c.env.DB;
  const projectId = c.req.param('projectId');

  try {
    // Delete all checks for this project first
    await db.prepare('DELETE FROM checks WHERE project_id = ?').bind(projectId).run();

    // Delete the project
    const projectResult = await db.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();

    // Also delete logs for this project's checks. Legacy project ids may
    // contain LIKE wildcards, so escape the id portion — but keep the
    // trailing `%` as the intentional wildcard. Anchoring on `project:`
    // avoids matching sibling projects (e.g. "svc" vs "svc-2").
    const logPattern = `${escapeLikePattern(projectId)}:%`;
    await db
      .prepare("DELETE FROM logs WHERE check_id LIKE ? ESCAPE '\\'")
      .bind(logPattern)
      .run();

    // Verify that the project was actually deleted
    if (!projectResult.success || projectResult.meta.changes === 0) {
      return c.json({ error: 'Project not found or already deleted' }, 404);
    }

    // Return JSON with custom header for HTMX to handle redirect
    c.header('X-Deleted', 'true');
    return c.json({ success: true, project_id: projectId });
  } catch (error) {
    console.error('Project delete error:', error);
    return c.json({ error: 'Failed to delete project' }, 500);
  }
});

/**
 * DELETE /admin/checks/:checkId
 * Delete a single check
 */
admin.delete('/admin/checks/:checkId', async (c) => {
  const db = c.env.DB;
  const checkId = c.req.param('checkId');

  try {
    // Delete the check
    const checkResult = await db.prepare('DELETE FROM checks WHERE id = ?').bind(checkId).run();

    // Delete logs for this check
    await db.prepare('DELETE FROM logs WHERE check_id = ?').bind(checkId).run();

    // Verify that the check was actually deleted
    if (!checkResult.success || checkResult.meta.changes === 0) {
      return c.json({ error: 'Check not found or already deleted' }, 404);
    }

    // Return JSON with custom header for HTMX to handle redirect
    c.header('X-Deleted', 'true');
    return c.json({ success: true, check_id: checkId });
  } catch (error) {
    console.error('Check delete error:', error);
    return c.json({ error: 'Failed to delete check' }, 500);
  }
});

/**
 * POST /admin/checks/:checkId/toggle
 * Toggle monitor status for a check
 */
admin.post('/admin/checks/:checkId/toggle', async (c) => {
  const db = c.env.DB;
  const checkId = c.req.param('checkId');

  try {
    const body = await c.req.parseBody();
    const monitorValue = body.monitor as string | number;
    const monitor = monitorValue === '1' || monitorValue === 1 ? 1 : 0;

    await db.prepare('UPDATE checks SET monitor = ? WHERE id = ?').bind(monitor, checkId).run();

    return c.json({ success: true, check_id: checkId, monitor });
  } catch (error) {
    console.error('Check toggle error:', error);
    return c.json({ error: 'Failed to toggle check' }, 500);
  }
});

/**
 * GET /admin/checks/:checkId/edit
 * Show edit form for a check
 */
admin.get('/admin/checks/:checkId/edit', async (c) => {
  const db = c.env.DB;
  const checkId = c.req.param('checkId');

  try {
    const check = await db
      .prepare('SELECT * FROM checks WHERE id = ?')
      .bind(checkId)
      .first<Check>();

    if (!check) {
      return c.html(html`<div>Check not found</div>`);
    }

    return c.html(html`
<div x-data="{ open: true }" x-show="open" style="position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;">
  <div @click.outside="closeModal()" style="background: #242424; padding: 2rem; border-radius: 0.5rem; max-width: 500px; width: 100%;">
    <h3>Edit Check</h3>
    <form hx-post="/admin/checks/${checkId}" hx-target="body" hx-swap="outerHTML">
      <label>
        Display Name
        <input type="text" name="display_name" value="${check.display_name || check.name}" required />
      </label>
      <label>
        Type
        <select name="type">
          <option value="heartbeat" ${check.type === 'heartbeat' ? 'selected' : ''}>Heartbeat</option>
          <option value="event" ${check.type === 'event' ? 'selected' : ''}>Event</option>
        </select>
      </label>
      <label>
        Interval (seconds)
        <input type="number" name="interval" value="${check.interval}" min="10" ${check.type === 'event' ? 'disabled' : ''} />
      </label>
      <label>
        Grace Period (seconds)
        <input type="number" name="grace" value="${check.grace}" min="0" />
      </label>
      <label>
        Threshold (consecutive failures)
        <input type="number" name="threshold" value="${check.threshold}" min="1" />
      </label>
      <label>
        Cooldown (seconds between alerts)
        <input type="number" name="cooldown" value="${check.cooldown}" min="0" />
      </label>
      <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
        <button type="submit" class="primary">Save</button>
        <button type="button" class="outline secondary" @click="closeModal()">Cancel</button>
      </div>
    </form>
  </div>
  <script>
    function closeModal() {
      const container = document.getElementById('modal-container');
      if (container) {
        container.innerHTML = '';
      }
    }
  </script>
</div>
    `);
  } catch (error) {
    console.error('Check edit error:', error);
    return c.html(html`<div>Error loading check</div>`);
  }
});

/**
 * POST /admin/checks/:checkId
 * Update a check
 */
admin.post('/admin/checks/:checkId', async (c) => {
  const db = c.env.DB;
  const checkId = c.req.param('checkId');

  try {
    const body = await c.req.parseBody();
    const {
      display_name,
      type,
      interval,
      grace,
      threshold,
      cooldown,
    } = body;

    // Parse and validate numeric inputs - use defaults if parsing fails
    const parsedInterval = interval ? Math.max(10, parseInt(interval as string, 10) || 300) : 300;
    const parsedGrace = grace ? Math.max(0, parseInt(grace as string, 10) || 60) : 60;
    const parsedThreshold = threshold ? Math.max(1, parseInt(threshold as string, 10) || 1) : 1;
    const parsedCooldown = cooldown ? Math.max(0, parseInt(cooldown as string, 10) || 900) : 900;

    // Validate type
    const validType = type === 'heartbeat' || type === 'event' ? type : 'heartbeat';

    await db.prepare(`
      UPDATE checks SET
        display_name = ?,
        type = ?,
        interval = ?,
        grace = ?,
        threshold = ?,
        cooldown = ?
      WHERE id = ?
    `).bind(
      display_name,
      validType,
      parsedInterval,
      parsedGrace,
      parsedThreshold,
      parsedCooldown,
      checkId
    ).run();

    // Redirect back to admin page
    return c.redirect('/admin');
  } catch (error) {
    console.error('Check update error:', error);
    return c.html(html`<div>Error updating check</div>`);
  }
});

/**
 * POST /admin/projects/new-dialog
 * Show new project form dialog
 */
admin.post('/admin/projects/new-dialog', async (c) => {
  return c.html(html`
<div x-data="{ open: true }" x-show="open" style="position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;">
  <div class="modal-dialog" @click.outside="closeModal()" style="background: #242424; padding: 2rem; border-radius: 0.5rem; max-width: 500px; width: 100%; max-height: 90vh; overflow-y: auto;">
    <h3>New Project</h3>
    <form hx-post="/admin/projects/new" hx-target="body" hx-swap="outerHTML">
      <label>
        Project ID
        <input type="text" name="project_id" placeholder="my-service" required pattern="[a-z0-9-]+" />
        <small>Lowercase letters, numbers, and hyphens only</small>
      </label>
      <label>
        Display Name
        <input type="text" name="display_name" placeholder="My Service" required />
      </label>
      <label>
        Token
        <div style="display:flex; gap:0.5rem;">
          <input type="text" name="token" id="new-project-token" placeholder="按「產生」或自貼" required minlength="16" style="flex:1;" />
          <button
            type="button"
            class="outline secondary"
            hx-get="/admin/generate-token"
            hx-on::after-request="document.getElementById('new-project-token').value = event.detail.xhr.responseJSON.token"
          >🎲 產生</button>
        </div>
        <small>At least 16 characters（產生 = 48 hex，與 scripts/enroll.sh 同款）</small>
      </label>
      <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
        <button type="submit" class="primary">Create</button>
        <button type="button" class="outline secondary" @click="closeModal()">Cancel</button>
      </div>
    </form>
  </div>
  <script>
    function closeModal() {
      const container = document.getElementById('modal-container');
      if (container) {
        container.innerHTML = '';
      }
    }
  </script>
</div>
  `);
});

/**
 * POST /admin/projects/new
 * Create a new project
 */
admin.post('/admin/projects/new', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  try {
    const body = await c.req.parseBody();
    const {
      project_id,
      display_name,
      token,
    } = body;

    // Validate required fields
    if (!project_id || !display_name || !token) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem;">
          Missing required fields
        </div>
      `);
    }

    // Project ids are interpolated into URLs, HTML attributes and check ids —
    // constrain the charset server-side (the form's pattern attribute is
    // client-side only and trivially bypassed).
    if (!isValidProjectId(project_id)) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem;">
          Invalid Project ID: use 1-63 chars of lowercase letters, numbers or hyphens (must start with a letter or number)
        </div>
      `);
    }

    // Check if project already exists
    const existing = await db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .bind(project_id)
      .first();

    if (existing) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem;">
          Project ID already exists
        </div>
      `);
    }

    // Server-side token strength (TODO-REVIEW #17): the form's minlength is
    // client-side only; the project token is the check's identity (pulse
    // resolves projects BY token), so it must not be guessable.
    if ((token as string).length < 16) {
      return c.html(html`
        <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem;">
          Token must be at least 16 characters (e.g. openssl rand -hex 24)
        </div>
      `);
    }

    // Create the project — and nothing else (WD-01): the old code attached
    // a `self` heartbeat check that clients never pulse, scheduling a DEAD
    // false alarm for every newly enrolled service. A project's checks are
    // exactly what its client declares via PUT /api/config.
    await db.prepare(`
      INSERT INTO projects (id, token, display_name, maintenance_until, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).bind(
      project_id,
      token,
      display_name,
      now
    ).run();

    // Redirect to admin page
    return c.redirect('/admin');
  } catch (error) {
    console.error('Project create error:', error);
    return c.html(html`
      <div style="padding: 1rem; background: #e74c3c; color: white; border-radius: 0.5rem;">
        Error creating project
      </div>
    `);
  }
});

export default admin;
