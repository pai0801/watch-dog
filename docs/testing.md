# Admin Dashboard Testing Checklist

Manual testing checklist for `/admin` page at https://watch-dog.helperp.workers.dev/admin

> Core behavior (auth gate, CSRF, token masking, alerting state machine, cron)
> is covered by the automated suite — run `npm test`. This checklist is the
> manual UI pass on top.

## Authentication (Basic Auth)
- [ ] Visiting `/admin` without credentials shows a browser Basic Auth prompt
- [ ] Wrong password is rejected (401, prompt reappears)
- [ ] Correct `ADMIN_TOKEN` password (any username) opens the dashboard
- [ ] Mutating actions without `X-Requested-With`/`X-HX-Request` are blocked (403) — cross-site form POSTs cannot pass the CSRF guard

## Tab Switching
- [ ] Settings/Projects/Checks buttons switch tabs correctly
- [ ] Active tab shows primary button style
- [ ] Inactive tabs show outline secondary style

## Settings Tab
- [ ] Slack API Token field shows a mask (`••••••••1234`), never the stored token
- [ ] Saving with the token field empty keeps the existing token
- [ ] Saving with a new token rotates it
- [ ] Channel fields display current values
- [ ] Silence Period field displays current value
- [ ] Save Settings button submits without page reload
- [ ] Success message appears after saving
- [ ] Values persist after save

## Projects Tab
- [ ] Projects list displays in table format
- [ ] Project columns: Display Name, Project ID, Checks, Maintenance Until, Actions
- [ ] New Project button opens modal
- [ ] Delete button shows confirmation dialog
- [ ] After deletion, page redirects to /admin
- [ ] Maintenance mode toggle works

## Checks Tab
- [ ] Project filter dropdown shows all projects
- [ ] "所有專案" (All Projects) option shows all project cards
- [ ] Project cards display as interactive HTML (not escaped text)
- [ ] Arrow icon (▶) changes to (▼) when clicked
- [ ] Clicking project card expands/collapses checks table
- [ ] Project status badge shows correct color (green=ok, orange=error, red=dead)
- [ ] Checks table displays: Name, Type, Interval, Grace, Threshold, Cooldown, Status, Monitor, Actions
- [ ] Monitor checkbox toggles without page reload
- [ ] Delete button shows confirmation dialog with check name
- [ ] After deletion, page redirects to /admin

## Alpine.js Functionality
- [ ] Tab switching uses Alpine.js state (x-show)
- [ ] Project filter uses x-model for two-way binding
- [ ] Project cards use x-data for local expanded state
- [ ] x-cloak prevents flash of unstyled content

## HTMX Functionality
- [ ] Save Settings uses hx-post for form submission
- [ ] Delete buttons use hx-delete with confirmation
- [ ] Monitor checkbox uses hx-post with hx-swap="none"
- [ ] X-Deleted header triggers page redirect

## Mobile Responsiveness
- [ ] Tables are scrollable on small screens
- [ ] Buttons remain clickable on touch devices
- [ ] Modal fits within viewport on mobile

## Browser Compatibility
- [ ] Chrome/Edge: All features work
- [ ] Firefox: All features work
- [ ] Safari: All features work

### Scheduler Hub（2026-10-19，D28 Proposed → 實作後改 Verified）

自動化覆蓋在 `tests/schedules.test.ts`（app pool，workerd 全保真），`npm test` 即跑：

- **簽名純函數**：`signScheduleHeader` 含 RFC 4231 known-answer test（KAT）——
  `t=<fired_at>,v1=<hex>`、v1 = HMAC-SHA256(secret, `fired_at.schedule_id.scheduled_at`)。
- **due 引擎**：fire + next_run_at 前推（at-most-once）、skip 未到期與 paused、
  失敗不重錘（等滿一個 interval）、retry_count=1 當場補一次、連敗跨越
  alert_after_failures 發 Slack warning、alert_after_failures=0 不發、
  batch cap 20（fire）與 5（alert）、fetch-throw catch 分支。
- **註冊 API（/api/schedules）**：auth trio（無 token 401／錯 token 403／未知 project 404；成功路徑由建立測試覆蓋 200）、
  欄位驗證（name/callback_url/project_id）、numeric fail-loud（"60"/true → 400）、
  clamps（interval 1–10080、retry 0–1、alert 0–100）、ownership 404（跨 project）、
  PUT/DELETE、同 project name 衝突 409。
- **admin 唯讀**：GET /admin/schedules 401（未認證）、secret 永不出現在任何回應、
  排序＋paused 可見。
- **cron wiring**：scheduled handler 端到端 fire；不變式①隔離——scheduler 回呼失敗
  不破壞 fail-dead dead-check（雙釘測試）。

狀態：**Verified**——全部已實作並有測試（217 passing）。
