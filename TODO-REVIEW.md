# TODO-REVIEW — 存量債清單（新舊債分流）

> 依 `~/Code/rules/14-DESIGN-PRINCIPLES.md` §3/§5：本清單約束「**新 code 怎麼落地**」，
> 既有違反在此流動，[NEVER] 借規則之名在 build 變更裡順手重構。
> 產生時機：2026-09-04 框架採用輪（rules/CLAUDE.md Steps 1–7）存量複本盤點。
> 每輪 architecture review（14 §6 閉環）後更新狀態；全數清償或裁定 N/A 的項目移入 FIX-LOG。

## 舊債（存量，排程處理）

| # | 位置 | 違反/偏離 | 處置建議 | 狀態 |
|---|---|---|---|---|
| 1 | `src/views/layout.ts`（`<style>` 內 `.status-badge` 系列定義**兩次**，另 `.checks-table` 相關規則有不平衡的巢狀 `@media`） | 14 §2.4 複本漂移（同一規則兩份，改一份漏一份的典型溫床） | CSS 去重合併為單一定義；順帶修 `@media` 巢狀錯位 | open |
| 2 | `01-CLAUDE.md` §9 表格主體（Astro frontscript / Svelte hydration / BEM CSS 列） | 框架範本殘留——watch-dog 無 Astro/Svelte（§9 頂部已加 watch-dog 適配注記，表格本體未改寫） | 將表格改寫為 watch-dog 真實邊界（route/service/view 分層）或整段標 N/A | open |
| 3 | `01-CLAUDE.md` §7 i18n | watch-dog UI 字串硬編英文，無 `t('key')`；單操作者內部工具 | 裁定：declined（單操作者工具，i18n 無受眾）→ 在 §7 加 N/A 注記 | open |
| 4 | `01-CLAUDE.md` §8 R2 規範 | 本專案無 R2 binding | 在 §8 加 N/A 注記（保留通用禁止事項） | open |
| 5 | `01-CLAUDE.md` §10 SEO 鐵三角 | dashboard/admin 為 noindex 監控工具，非公開內容站 | 在 §10 加 N/A 注記 | open |
| 6 | `01-CLAUDE.md` §14 UI 設計原則 | §14 偏好 Tailwind + OKLCH；watch-dog 實際 Pico.css + custom CSS（現存 UI） | 標註既有 UI 為 legacy accepted；新頁面遵循 §14 精神（不重造既有 UI） | open |
| 7 | `src/services/settings.ts` env-fallback（`SLACK_*` 環境變數）與 `.dev.vars.example` 的 `SLACK_*` | 雙真相來源：DB `settings` 表為主、env 為 legacy fallback（`.portability.toml` 已列 `optional_worker`） | 標 deprecated；訂移除時機（e.g. 兩個專案遷移到 DB settings 後刪 fallback 代碼） | open |
| 8 | `src/routes/api.ts` legacy `X-Project-Token` header | 新舊並存的接受面（Bearer 為主）；舊客戶端相依 | 盤點仍在用 legacy header 的上報端，全數遷移後移除 | open |
| 9 | `src/index.ts` `assertBindings` 包裝層 | 無 app-pool 直接單元測試（§I guard 驗證接線存在，非執行路徑行為） | 補一個「缺 ADMIN_TOKEN 時 fetch 回 500」的 workerd-pool 測試 | open |

## 複本盤點確認非債項（避免重複調查）

- `logs` 表增長：已有 7 天保留清除（`src/cron.ts` `DELETE FROM logs WHERE created_at < ?`）+ `idx_logs_check_id` 索引（`src/db.sql`）。
- SQL 全靜態字面值 + `.bind()` 參數化；`as any` 預算 0（guard 鎖定）。
- 專案 token 比對用 `timingSafeEqual`（`src/routes/api.ts`），無時序攻擊面。

## 本輪已清償（2026-09-04 採用輪，記錄用）

- `as any` 20 → 0（19 處 Hono JSX 冗餘 cast 拔除、1 處改 `.all<T>()` 泛型）。
- `noUnusedLocals/Parameters` 開啟，清 6 處死碼（cron/dashboard/tests）。
- wrangler 4.61.1 → 4.129.0（`secrets.required` 在 4.61 schema 不存在 = Layer 1 安慰劑）+ `@cloudflare/workers-types` ^5。
- `alert.ts` Slack blocks 補最小結構型別（`SlackBlock`）；`adminAuth.ts` useless assignment 修正。
- `docs/plans/2026-02-02-watch-dog-sentinel.md:33` 現役 token 明文洩漏 redact（輪替由操作者執行，見 `secrets-archive/SECRETS.md`）。
