// src/views/adminViews.ts
// HTML builders for the /admin dashboard.
//
// Security notes:
// - The Slack API token is NEVER echoed back into HTML. The form field is
//   left empty with a masked placeholder; submitting an empty field keeps
//   the stored value (see services/settings.ts).
// - Same contract for the CF account API tokens (cf_accounts.api_token):
//   masked display only, empty form field = keep stored, never echoed.

import { html, raw } from 'hono/html';
import type { Check, Project } from '../types';
import type { AllSettings } from '../services/settings';
import { METRICS, type CfAccount } from '../services/cfUsage';

export type AdminProject = Project & {
  checks: Check[];
  projectStatus: 'ok' | 'error' | 'dead';
};

/** Row of today's cf_usage_state snapshot (subset of columns; PK prefix read). */
export interface CfUsageStateRow {
  account_id: string;
  metric: string;
  value: number;
  projected_eod: number | null;
  alerted_level: number;
}

/** Everything the CF 用量 tab renders, gathered by GET /admin. */
export interface AdminCfData {
  accounts: CfAccount[];
  usageToday: CfUsageStateRow[];
  dayUtc: string;
}

/** "1179 B" / "12.3 KiB" / "1.0 GiB" for the *_bytes storage gauges. */
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** Byte gauges get human units; everything else is a plain count. */
const fmtMetricValue = (metric: string, n: number): string =>
  metric.endsWith('_bytes') ? fmtBytes(n) : n.toLocaleString();

/** Mask a secret for display: keep only the last 4 characters. */
export function maskToken(token: string): string {
  if (!token) return '';
  return `••••••••${token.slice(-4)}`;
}

/**
 * Full admin dashboard content (settings / projects / checks / logs / CF usage tabs).
 */
export const AdminPage = (
  settings: AllSettings,
  projects: Project[],
  projectsWithChecks: AdminProject[],
  cf: AdminCfData,
) => html`
<div class="admin-dashboard" x-data="{ openTab: 'settings' }">
  <header style="margin-bottom: 2rem; border-bottom: 1px solid #333; padding-bottom: 1rem;">
    <div class="admin-header-row" style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h1 style="margin: 0;">Admin Dashboard</h1>
        <p style="margin: 0.25rem 0 0 0; color: #888;">Manage settings, projects, and checks</p>
      </div>
      <a href="/" class="outline secondary">Back to Dashboard</a>
    </div>
    <nav class="admin-tabs-nav" style="margin-top: 1rem; display: flex; gap: 0.5rem;">
      <button
        @click="openTab = 'settings'"
        :class="openTab === 'settings' ? 'primary' : 'outline secondary'"
      >Settings</button>
      <button
        @click="openTab = 'projects'"
        :class="openTab === 'projects' ? 'primary' : 'outline secondary'"
      >Projects</button>
      <button
        @click="openTab = 'checks'"
        :class="openTab === 'checks' ? 'primary' : 'outline secondary'"
      >Checks</button>
      <button
        @click="openTab = 'logs'"
        :class="openTab === 'logs' ? 'primary' : 'outline secondary'"
      >Logs</button>
      <button
        @click="openTab = 'cf-usage'"
        :class="openTab === 'cf-usage' ? 'primary' : 'outline secondary'"
      >CF 用量</button>
    </nav>
  </header>

  <!-- Settings Tab -->
  <div x-show="openTab === 'settings'" x-cloak>
    <h2>Slack Settings</h2>
    <form hx-post="/admin/settings/slack" hx-swap="outerHTML">
      <div class="admin-settings-grid grid">
        <label>
          API Token
          <input
            type="text"
            name="api_token"
            value=""
            autocomplete="off"
            placeholder="${settings.api_token ? maskToken(settings.api_token) : 'xoxb-...'}"
          />
          <small>${settings.api_token ? `留空 = 保留現有 token(${maskToken(settings.api_token)})` : '尚未設定 token'}</small>
        </label>
        <label>
          Critical Channel
          <input
            type="text"
            name="channel_critical"
            value="${settings.channel_critical}"
            placeholder="#alerts-critical"
            required
          />
        </label>
        <label>
          Success Channel
          <input
            type="text"
            name="channel_success"
            value="${settings.channel_success}"
            placeholder="#alerts-success"
            required
          />
        </label>
        <label>
          Warning Channel
          <input
            type="text"
            name="channel_warning"
            value="${settings.channel_warning}"
            placeholder="#alerts-warning"
            required
          />
        </label>
        <label>
          Info Channel
          <input
            type="text"
            name="channel_info"
            value="${settings.channel_info}"
            placeholder="#alerts-info"
            required
          />
        </label>
        <label>
          Silence Period (seconds)
          <input
            type="number"
            name="silence_period_seconds"
            value="${settings.silence_period_seconds}"
            min="0"
            step="60"
            required
          />
        </label>
      </div>
      <button type="submit" class="primary">Save Settings</button>
    </form>

    <h2 style="margin-top: 2rem;">Email Alerts（email-king gateway）</h2>
    <p><small><b>critical（服務中斷）與 recovery</b> 經 email-king gateway 寄信；warning 僅 Slack（信箱留給真中斷）。Token 向操作者索取（email-king consumer token）。</small></p>
    <form hx-post="/admin/settings/email" hx-swap="outerHTML">
      <div class="admin-settings-grid grid">
        <label>
          Gateway URL
          <input
            type="text"
            name="email_gateway_url"
            value="${settings.email_gateway_url}"
            placeholder="https://ek-gw.96321478.xyz/api/v1/send"
          />
        </label>
        <label>
          API Token
          <input
            type="text"
            name="email_api_token"
            value=""
            autocomplete="off"
            placeholder="${settings.email_api_token ? maskToken(settings.email_api_token) : 'email-king consumer token'}"
          />
          <small>${settings.email_api_token ? `留空 = 保留現有 token（${maskToken(settings.email_api_token)}）` : '尚未設定 token'}</small>
        </label>
        <label>
          收件人（Alerts Inbox）
          <input
            type="email"
            name="email_recipient"
            value="${settings.email_recipient}"
            placeholder="you@example.com"
          />
        </label>
      </div>
      <button type="submit" class="primary">Save Email Settings</button>
    </form>

    <div style="margin-top: 1.5rem; border-top: 1px solid #333; padding-top: 1rem;">
      <h3>測試警報</h3>
      <p><small>送一通真實訊息到對應頻道，當場驗證 token／頻道路由（成敗顯示於右側）。</small></p>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <button type="button" class="outline secondary"
          hx-post="/admin/settings/slack-test" hx-vals='{"level":"critical"}'
          hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
          hx-on::after-request="const r=event.detail.xhr.responseJSON; document.getElementById('slack-test-result').textContent = r.ok ? '✓ 已送達（critical 頻道）' : '✗ ' + (r.error || 'failed')"
        >🚨 Test Critical</button>
        <button type="button" class="outline secondary"
          hx-post="/admin/settings/slack-test" hx-vals='{"level":"warning"}'
          hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
          hx-on::after-request="const r=event.detail.xhr.responseJSON; document.getElementById('slack-test-result').textContent = r.ok ? '✓ 已送達（warning 頻道）' : '✗ ' + (r.error || 'failed')"
        >⚠️ Test Warning</button>
        <button type="button" class="outline secondary"
          hx-post="/admin/settings/slack-test" hx-vals='{"level":"recovery"}'
          hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
          hx-on::after-request="const r=event.detail.xhr.responseJSON; document.getElementById('slack-test-result').textContent = r.ok ? '✓ 已送達（success 頻道）' : '✗ ' + (r.error || 'failed')"
        >✅ Test Recovery</button>
        <span id="slack-test-result" style="color: #aaa;"></span>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; flex-wrap: wrap;">
        <button type="button" class="outline secondary"
          hx-post="/admin/settings/email-test"
          hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
          hx-on::after-request="const r=event.detail.xhr.responseJSON; document.getElementById('email-test-result').textContent = r.ok ? '✓ 測試郵件已寄出（收件匣查看）' : '✗ ' + (r.error || 'failed')"
        >📧 Test Email</button>
        <span id="email-test-result" style="color: #aaa;"></span>
      </div>
    </div>
  </div>

  <!-- Projects Tab -->
  <div x-show="openTab === 'projects'" x-cloak>
    <div class="admin-tab-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2>Projects</h2>
      <button
        hx-post="/admin/projects/new-dialog"
        hx-target="#modal-container"
        hx-swap="innerHTML"
        class="primary"
      >New Project</button>
    </div>
    <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
      <table class="admin-projects-table striped">
        <thead>
          <tr>
            <th>Display Name</th>
            <th>Project ID</th>
            <th>Token</th>
            <th>Checks</th>
            <th>Maintenance Until</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${raw(projectsWithChecks.map(p => html`
            <tr>
              <td>${p.display_name}</td>
              <td><code>${p.id}</code></td>
              <td><code>${maskToken(p.token)}</code></td>
              <td>${p.checks.length}</td>
              <td>${p.maintenance_until > 0 ? new Date(p.maintenance_until * 1000).toLocaleString() : 'Not in maintenance'}</td>
              <td style="white-space: nowrap;">
                <button
                  hx-post="/admin/projects/${p.id}/rotate-token"
                  hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                  hx-target="#modal-container"
                  hx-swap="innerHTML"
                  hx-confirm="輪替 token？舊 token 立即失效，client 專案需同步更新 env。"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Rotate Token</button>
                <button
                  hx-post="/admin/projects/${p.id}/maintenance"
                  hx-vals='{"enabled": true, "duration": 3600}'
                  hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                  hx-confirm="Mute alerts for this project for 1 hour?"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Mute 1h</button>
                <button
                  hx-post="/admin/projects/${p.id}/maintenance"
                  hx-vals='{"enabled": false}'
                  hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                  hx-swap="none"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Unmute</button>
                <button
                  hx-delete="/admin/projects/${p.id}"
                  hx-confirm="Are you sure? This will delete the project and all its checks."
                  hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                  hx-on::after-request="if(this.getResponseHeader('X-Deleted') === 'true') window.location.href='/admin'"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Delete</button>
              </td>
            </tr>
          `).join(''))}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Checks Tab -->
  <div x-show="openTab === 'checks'" x-cloak x-data="{ filterProject: 'all' }">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2 style="margin: 0;">All Checks</h2>
      <select x-model="filterProject" style="padding: 0.5rem;">
        <option value="all">所有專案</option>
        ${raw(projects.map(p => html`<option value="${p.id}">${p.display_name}</option>`).join(''))}
      </select>
    </div>

    <div class="checks-list">
      ${raw(projectsWithChecks
        .map((p) => {
          const statusOrder: Record<string, number> = { dead: 3, error: 2, ok: 1 };
          const sortedChecks = [...p.checks].sort((a, b) => (statusOrder[b.status] ?? 0) - (statusOrder[a.status] ?? 0));
          // Never interpolate ids into JS-valued attributes (x-show etc.):
          // hono/html entity-escapes, but the browser decodes entities back
          // before Alpine evaluates the attribute as an expression. Ids ride
          // in a data attribute instead and the expression reads $el.
          return html`<div class="checks-card-wrapper" x-data="{ expanded: false }" data-project="${p.id}" x-show="filterProject === 'all' || filterProject === $el.dataset.project">
      <div
        @click="expanded = !expanded"
        style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: #2a2a2a; cursor: pointer; border-left: 4px solid ${p.projectStatus === 'dead' ? '#e74c3c' : p.projectStatus === 'error' ? '#f39c12' : '#2ecc71'};"
      >
        <div style="display: flex; align-items: center; gap: 1rem;">
          <span x-text="expanded ? '▼' : '▶'" style="font-size: 1.5rem;"></span>
          <div>
            <div style="font-weight: bold;">${p.display_name}</div>
            <small style="color: #888;">${p.checks.length} checks</small>
          </div>
        </div>
        <span class="status-badge ${p.projectStatus}">${p.projectStatus.toUpperCase()}</span>
      </div>

      <div class="checks-expanded-content" x-show="expanded" style="padding: 0 1rem 1rem 1rem; background: #1a1a1a;">
        <table class="checks-table striped" style="font-size: 0.8rem; width: 100%; min-width: max-content;">
            <thead>
              <tr>
                <th>Check Name</th>
                <th>Type</th>
                <th>Interval</th>
                <th>Grace</th>
                <th>Threshold</th>
                <th>Cooldown</th>
                <th>Status</th>
                <th>Monitor</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${raw(sortedChecks.map((check) => html`
                <tr>
                  <td>${check.display_name || check.name}</td>
                  <td>${check.type}</td>
                  <td>${check.interval}s</td>
                  <td>${check.grace}s</td>
                  <td>${check.threshold}</td>
                  <td>${check.cooldown}s</td>
                  <td>
                    <span class="status-badge ${check.status}">${check.status}</span>
                  </td>
                  <td style="text-align: center;">
                    <input
                      type="checkbox"
                      ${check.monitor ? 'checked' : ''}
                      hx-post="/admin/checks/${check.id}/toggle"
                      hx-vals='{"monitor": ${check.monitor ? 0 : 1}}'
                      hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                      hx-swap="none"
                    />
                  </td>
                  <td>
                    <button
                      hx-delete="/admin/checks/${check.id}"
                      hx-confirm="確認刪除檢查「${check.display_name || check.name}」？此操作無法復原。"
                      hx-headers='{"X-Requested-With": "XMLHttpRequest"}'
                      hx-on::after-request="if(this.getResponseHeader('X-Deleted') === 'true') window.location.href='/admin'"
                      class="outline secondary"
                      style="font-size: 0.7rem;"
                    >Delete</button>
                  </td>
                </tr>
              `).join(''))}
            </tbody>
          </table>
      </div>
    </div>`;
        })
        .join(''))}
    </div>
  </div>

  <!-- Logs Tab -->
  <div x-show="openTab === 'logs'" x-cloak>
    <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;">
      <h2 style="margin: 0;">Pulse Logs（7 天保留）</h2>
      <select name="project" hx-get="/admin/logs" hx-trigger="change" hx-target="#logs-body" hx-swap="outerHTML" hx-include="[name='limit']" style="padding: 0.5rem;">
        <option value="">全部專案</option>
        ${raw(projects.map(p => html`<option value="${p.id}">${p.display_name}</option>`).join(''))}
      </select>
      <select name="limit" style="padding: 0.5rem;">
        <option value="50">50 筆</option>
        <option value="100">100 筆</option>
        <option value="200">200 筆</option>
      </select>
      <button type="button" class="outline secondary" hx-get="/admin/logs" hx-target="#logs-body" hx-swap="outerHTML" hx-include="[name='project'],[name='limit']">Refresh</button>
    </div>
    <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
      <table class="checks-table striped" style="font-size: 0.8rem; width: 100%; min-width: max-content;">
        <thead>
          <tr>
            <th>Time</th>
            <th>Check</th>
            <th>Status</th>
            <th>Latency (ms)</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody id="logs-body" hx-get="/admin/logs" hx-trigger="load" hx-include="[name='project'],[name='limit']">
          <tr><td colspan="5" style="color: #888;">載入中…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- CF Usage Tab -->
  <div x-show="openTab === 'cf-usage'" x-cloak>
    <div class="admin-tab-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
      <h2 style="margin: 0;">CF 帳號用量（每 30 分鐘輪詢）</h2>
      <div style="display: flex; gap: 0.5rem; align-items: center;">
        <span id="cf-run-result" style="color: #aaa; font-size: 0.85rem;"></span>
        <button type="button" class="primary"
          hx-post="/admin/cf-usage/run"
          hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
          hx-on::after-request="const r=event.detail.xhr.responseJSON; document.getElementById('cf-run-result').textContent = 'polled=' + r.polled + ' recorded=' + r.recorded + ' alerts=' + r.alertsSent + (r.failures.length ? ' ✗ ' + r.failures.map(f => f.label + ': ' + f.error).join('; ') : ' ✓')"
        >▶ 立即輪詢</button>
      </div>
    </div>
    <p><small>額度以 UTC 日計（台北 08:00 重置）。已用 ≥60% 警告（Slack）、≥80% 危險（Slack＋email）、速率投影預估今日超額 → 警告。token 僅需 Account→Analytics: Read。</small></p>

    ${raw(cf.accounts.length === 0
      ? html`<p style="color: #888;">尚未 onboard 任何 CF 帳號——展開下方「新增帳號」表單開始（輪詢在零帳號時自動休眠）。</p>`
      : html`
    <h3>今日用量快照（UTC 資料日 ${cf.dayUtc}）</h3>
    <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
      <table class="checks-table striped" style="font-size: 0.8rem; width: 100%; min-width: max-content;">
        <thead>
          <tr>
            <th>帳號</th>
            <th>指標</th>
            <th>已用</th>
            <th>配額</th>
            <th>%</th>
            <th>預估 EOD</th>
            <th>告警</th>
          </tr>
        </thead>
        <tbody>
          ${raw(cf.accounts.map((a) => {
            const metricOrder = Object.keys(METRICS);
            const rows = cf.usageToday
              .filter((u) => u.account_id === a.account_id)
              .sort((x, y) => metricOrder.indexOf(x.metric) - metricOrder.indexOf(y.metric));
            if (rows.length === 0) {
              return html`<tr><td>${a.label}</td><td colspan="6" style="color: #888;">尚無資料——下輪 poll 或按「▶ 立即輪詢」</td></tr>`;
            }
            return rows.map((u) => {
              const def = METRICS[u.metric];
              const quota = def ? (def.quotas[a.plan] ?? 0) : 0;
              const pct = quota > 0 ? u.value / quota : null;
              const pctColor = pct !== null && pct >= 0.8 ? '#e74c3c' : pct !== null && pct >= 0.6 ? '#f39c12' : 'inherit';
              return html`<tr>
                <td>${a.label}</td>
                <td>${def ? def.label : u.metric}</td>
                <td>${fmtMetricValue(u.metric, u.value)}</td>
                <td>${quota > 0 ? fmtMetricValue(u.metric, quota) : '—'}</td>
                <td style="color: ${pctColor}; font-weight: ${pct !== null && pct >= 0.6 ? 'bold' : 'normal'};">${pct !== null ? `${Math.round(pct * 100)}%` : '—'}</td>
                <td>${u.projected_eod !== null ? fmtMetricValue(u.metric, u.projected_eod) : '—'}</td>
                <td>${u.alerted_level === 2 ? '🔴 已發危險' : u.alerted_level === 1 ? '🟠 已發警告' : ''}</td>
              </tr>`;
            }).join('');
          }).join(''))}
        </tbody>
      </table>
    </div>

    <h3 style="margin-top: 2rem;">帳號</h3>
    <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
      <table class="admin-projects-table striped">
        <thead>
          <tr>
            <th>Label</th>
            <th>Account ID</th>
            <th>Token</th>
            <th>Plan</th>
            <th>Enabled</th>
            <th>Last OK</th>
            <th>Last Error</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${raw(cf.accounts.map((a) => html`
            <tr>
              <td>${a.label}</td>
              <td><code>${a.account_id}</code></td>
              <td><code>${maskToken(a.api_token)}</code></td>
              <td>${a.plan}</td>
              <td style="text-align: center;">
                <input
                  type="checkbox"
                  ${a.enabled ? 'checked' : ''}
                  hx-post="/admin/cf-usage/accounts/${a.account_id}/toggle"
                  hx-vals='{"enabled": ${a.enabled ? 0 : 1}}'
                  hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
                  hx-swap="none"
                />
              </td>
              <td>${a.last_ok_at > 0 ? new Date(a.last_ok_at * 1000).toLocaleString() : '—'}</td>
              <td>${a.last_error ? a.last_error.slice(0, 120) : '✓'}</td>
              <td style="white-space: nowrap;">
                <button
                  hx-get="/admin/cf-usage/accounts/${a.account_id}/edit"
                  hx-target="#modal-container"
                  hx-swap="innerHTML"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Edit</button>
                <button
                  hx-delete="/admin/cf-usage/accounts/${a.account_id}"
                  hx-confirm="刪除帳號「${a.label}」？其用量狀態 rows 一併刪除。"
                  hx-headers='{"X-Requested-With":"XMLHttpRequest"}'
                  hx-on::after-request="if(this.getResponseHeader('X-Deleted') === 'true') window.location.href='/admin'"
                  class="outline secondary"
                  style="font-size: 0.75rem;"
                >Delete</button>
              </td>
            </tr>
          `).join(''))}
        </tbody>
      </table>
    </div>`)}

    <details style="margin-top: 1.5rem;">
      <summary style="cursor: pointer; color: #aaa;">＋ 新增帳號</summary>
      <form hx-post="/admin/cf-usage/accounts" hx-swap="outerHTML" style="margin-top: 1rem;">
        <div class="admin-settings-grid grid">
          <label>
            Account ID
            <input type="text" name="account_id" required pattern="[0-9a-f]{32}" placeholder="8fdbf0ee…" autocomplete="off" />
            <small>32 位十六進位 CF account tag（form 的 pattern 只是提示，server 端再驗）</small>
          </label>
          <label>
            Label
            <input type="text" name="label" required placeholder="Helperp prod" />
          </label>
          <label>
            API Token（Analytics Read）
            <input type="text" name="api_token" autocomplete="off" placeholder="watch-dog-usage-…" />
            <small>僅需 Account→Analytics: Read 權限；建立後不可查回，忘了就重 mint</small>
          </label>
          <label>
            Plan
            <select name="plan">
              <option value="free" selected>free</option>
              <option value="paid">paid</option>
            </select>
          </label>
        </div>
        <button type="submit" class="primary">儲存帳號</button>
      </form>
    </details>
  </div>

  <!-- Modal Container -->
  <div id="modal-container"></div>
</div>
`;
