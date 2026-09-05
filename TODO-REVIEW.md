# TODO-REVIEW — 存量債清單（新舊債分流）

> 依 `~/Code/rules/14-DESIGN-PRINCIPLES.md` §3/§5：本清單約束「**新 code 怎麼落地**」，
> 既有違反在此流動，[NEVER] 借規則之名在 build 變更裡順手重構。
> 產生時機：2026-09-04 框架採用輪（rules/CLAUDE.md Steps 1–7）存量複本盤點。
> 每輪 architecture review（14 §6 閉環）後更新狀態；已清償項目的處置細節記於 FIX-LOG，
> 表列 row 保留為歷史記錄（劃線不改寫，供日後回溯盤點結論）。

## 舊債（存量，排程處理）

> 2026-09-04 末輪狀態：16 項舊債全數清償、零未償（#1–#6 docs/CSS；#9–#16 見 88b0a3c / 3ad4bf7；
> #7 見 042c8d2＋末輪收斂；#8 見 f4b47cd）。#17/#18 為 2026-09-05 首次部署後線上實測發現的新債，同日清償。
> 表列 row 保留為歷史記錄，處置細節見各 commit 與 FIX-LOG 條目。

| # | 位置 | 違反/偏離 | 處置建議 | 狀態 |
|---|---|---|---|---|
| 1 | `src/views/layout.ts` CSS | ~~`.status-badge` 定義兩次＋不平衡巢狀 `@media`~~ | 去重為單一定義；`@media` 括號平衡修復（295 區塊少一個關閉、364 巢狀後多兩個） | **已清償 2026-09-04**（本輪） |
| 2 | `01-CLAUDE.md` §9 表格主體 | ~~框架範本殘留~~ | 表格改寫為 watch-dog 真實邊界（routes/services/views/cron 分層 + per-project scoping 規則） | **已清償 2026-09-04**（本輪） |
| 3 | `01-CLAUDE.md` §7 i18n | ~~無 N/A 注記~~ | 裁定 declined（單操作者工具）→ §7 加 N/A 注記 | **已清償 2026-09-04**（本輪） |
| 4 | `01-CLAUDE.md` §8 R2 規範 | ~~無注記~~ | §8 加 N/A 注記（無 R2/KV binding） | **已清償 2026-09-04**（本輪） |
| 5 | `01-CLAUDE.md` §10 SEO 鐵三角 | ~~無注記~~ | §10 加 N/A 注記（noindex 監控工具） | **已清償 2026-09-04**（本輪） |
| 6 | `01-CLAUDE.md` §14 UI 設計原則 | ~~無注記~~ | 標 legacy accepted；新頁面遵循 §14 精神 | **已清償 2026-09-04**（本輪） |
| 7 | `src/services/settings.ts` env-fallback（`SLACK_*` 環境變數）與 `.dev.vars.example` 的 `SLACK_*` | ~~雙真相來源：DB `settings` 表為主、env 為 legacy fallback（`.portability.toml` 已列 `optional_worker`）~~ | ~~標 deprecated；訂移除時機~~ → **首次部署前移除**（系統從未部署，零部署受影響）：`getEnvWithFallback` 刪除（DB 單一真相源，`getAllSettings` 單一匯出名）、`trySlackApiToken`/`OPTIONAL_BINDING_KEYS` 清空、`Env` 型別 `SLACK_*` 欄位刪除、`.portability.toml optional_worker = []`、`.dev.vars.example`/SECRETS.md 同步 | **已清償 2026-09-04**（042c8d2＋末輪收斂，見 FIX-LOG） |
| 8 | `src/routes/api.ts` legacy `X-Project-Token` header | ~~新舊並存的接受面~~ | 跨 repo 盤點零使用者 → 移除（f4b47cd，Bearer-only；測試改 401 拒絕鎖死） | **已清償 2026-09-04**（f4b47cd） |
| 9 | `src/index.ts` `assertBindings` 包裝層 | 無 app-pool 直接單元測試（§I guard 驗證接線存在，非執行路徑行為） | ~~補 workerd-pool 測試~~ → `tests/bindings.test.ts`（fetch entry throw + 單元層；app pool 待 CI runner 恢復後補驗） | **已清償 2026-09-04**（88b0a3c） |
| 10 | `tests/guards/portability.test.ts::§B` `scanPrepareArg` | ~~deslop 實測漏攔四向量~~ | 主規則「.prepare( 引數非字面值開頭即違規」＋四向量 fixture 鎖定（D38）；SQL 算術誤報以引號貼鄰樣式排除 | **已清償 2026-09-04**（88b0a3c） |
| 11 | `tests/guards/portability.test.ts::§A` src 掃描 | ~~regex 只抓帶引號鍵形態~~ | 加無引號鍵樣式 `\bKEY\s*=\s*['"\`]\S`（帶/無引號鍵雙形態） | **已清償 2026-09-04**（88b0a3c） |
| 12 | `tests/guards/portability.test.ts::§G` | ~~只鎖 manifest→wrangler 單向~~ | 補反向：wrangler `secrets.required` ⊆ manifest worker | **已清償 2026-09-04**（88b0a3c） |
| 13 | `.secrets.baseline` | ~~無任何持續 hook 跑它~~ | CI workflow 加 baseline freshness step（ENGINEERING_GUIDE §5.2）；本機裝 detect-secrets 1.5.0（--user） | **已清償 2026-09-04**（3ad4bf7） |
| 14 | D5/§E import 掃描（`framework.test.ts` / `portability.test.ts`） | ~~`from 'cloudflare:workers'` 只配單引號~~ | pattern 改 `['"]` 兩引號 | **已清償 2026-09-04**（88b0a3c） |
| 15 | `secrets-archive/pre-commit-check.sh` §1b 值級掃描 | ~~行本位 grep 漏多行 JSONC~~ | 改 `grep -zE` 全文比對；多行 JSONC 注入證明 FAIL→還原綠（D38） | **已清償 2026-09-04**（88b0a3c） |
| 16 | `AGENTS.md` = `CLAUDE.md` 內文逐字複製（80 行） | ~~無機械驗證~~ | framework.test.ts 加 guard：兩檔 body（首個 `## ` 起）不一致即紅 | **已清償 2026-09-04**（88b0a3c） |
| 17 | `src/routes/api.ts` `PUT /api/config` | ~~API 層不驗 project token 強度——「至少 16 字元」只在 admin UI client-side~~ | 註冊封閉化：`PUT /api/config` 未知 project 回 404（建立只走 `/admin`）；`POST /admin/projects/new` 加 server-side `token.length >= 16`（api/admin 測試 +2） | **已清償 2026-09-05**（closed registration 輪） |
| 18 | `src/routes/api.ts` 註冊面 | ~~開放註冊＋無 rate limit——知道 URL 者可建立垃圾 project；更嚴重：建 check 不發 pulse → 判死警報打進操作者 Slack（警報通道虐待）~~ | 註冊封閉化後未認證寫入面歸零——垃圾/虐待專案建立現需 admin 憑證；admin 面 brute-force 由既有 Basic Auth + timingSafeEqual 姿態涵蓋 | **已清償 2026-09-05**（隨 #17 一併消除） |

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
