// src/routes/admin.ts
// Admin dashboard routes. Every route here sits behind the Basic-Auth gate
// (see middleware/adminAuth.ts) — the token-auth public API lives in api.ts.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppBindings, Check, Project } from '../types';
import { adminAuth } from '../middleware/adminAuth';
import { escapeLikePattern, isValidProjectId } from '../lib/validate';
import { getAllSettings, updateSlackSettings, updateSetting } from '../services/settings';
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
        <input type="text" name="token" placeholder="Generate secure token" required minlength="16" />
        <small>At least 16 characters</small>
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

    // Create the project
    await db.prepare(`
      INSERT INTO projects (id, token, display_name, maintenance_until, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).bind(
      project_id,
      token,
      display_name,
      now
    ).run();

    // Create a default self-check for the project
    const checkId = `${project_id}:self`;
    await db.prepare(`
      INSERT INTO checks (
        id, project_id, name, display_name, type,
        interval, grace, threshold, cooldown,
        last_seen, status, failure_count, last_alert_at, last_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok', 0, 0, NULL)
    `).bind(
      checkId,
      project_id,
      'self',
      'Self Health',
      'heartbeat',
      300,
      60,
      1,
      900
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
