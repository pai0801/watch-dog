# Secret 依賴清單 — watch-dog

> 人類合約：這份表告訴你「動了會死在哪裡」。機讀後設資料在 `.portability.toml [secrets.meta]`；敘述性欄位只在這裡，不雙寫。
> 補齊準則見 `~/Code/rules/references/SECRETS-CONTRACT-TEMPLATE.md` 與 10-SECRETS-CONTRACT §2。
> rotate 後：設新值到雲端（`wrangler secret put <NAME>`，值 file-sourced）→ redeploy → `bash secrets-archive/seal.sh` → 更新本表「上次更換」→ git commit。

## Worker runtime secrets

| Secret 名稱 | 用途（一句話） | 來源（服務/帳號） | 被誰使用（檔案/服務） | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `ADMIN_TOKEN` | `/admin/*` Basic-Auth 密碼（username 任意） | 自產（`openssl rand -hex 24`） | `src/middleware/adminAuth.ts`、`src/lib/bindings.ts`（assertBindings fail-fast）、`wrangler.jsonc secrets.required`（Layer 1 擋部署）、`.dev.vars`（dev） | 換掉後所有已存瀏覽器 Basic 憑證即失效，重新輸入新密碼即可；設定後需 redeploy 才傳播。缺值 = 部署被擋（Layer 1）+ runtime 全站 fail-fast（Layer 2） | 2026-09-04（dev 值入庫；prod 首次部署時設定） |
| ~~`SLACK_API_TOKEN`~~（**已移除 2026-09-04**，TODO-REVIEW #7） | ~~Slack 警報發送 token 的 env fallback~~ | Slack workspace app（Bot User OAuth Token） | ~~`src/lib/bindings.ts`（trySlackApiToken）、`src/services/settings.ts`（getEnvWithFallback）~~——移除時系統**從未部署**，零部署受影響 | 現行真相源 = **D1 `settings` 表**（`/admin` 設定，`getAllSettings` 讀取），env 途徑已不存在 | env fallback 已於首次部署前移除（DB settings 值由操作者在 /admin 管理） |

## Deploy-time shell 憑證（非 worker runtime binding，不入 `[secrets].worker`）

| 名稱 | 用途 | 來源 | 被誰使用 | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler CLI 部署/管理權限（deploy 時 shell 讀 `.env`） | Cloudflare dashboard → My Profile → API Tokens | `.env` → `wrangler deploy` / `wrangler secret put` / `wrangler d1` 等指令 | 換掉後所有 wrangler 部署與管理指令失效（worker runtime 不受影響）；需同步 `.env` + `seal.sh` | **[MUST] 輪替中**：2026-09-04 發現明文洩漏於 `docs/plans/2026-02-02-watch-dog-sentinel.md:33`（detect-secrets baseline 掃描；值已 redact，git 歷史仍有）→ 於 CF dashboard 作廢舊 token、產新值進 `.env`、`bash secrets-archive/seal.sh`（見 FIX-LOG 2026-09-04 洩漏條目） |
| `CLOUDFLARE_ACCOUNT_ID`（非機密） | wrangler 帳號定位（ID，非 secret） | Cloudflare dashboard | `.env` → wrangler CLI | 同上（與 token 一組重設） | — |

## 首次部署提醒（#14258）

全新 Worker 第一次 deploy 前不能設 secret，`wrangler.jsonc secrets.required` 會擋首次部署。流程：
暫時移除 `secrets` 區塊 → `wrangler deploy` → `wrangler secret put ADMIN_TOKEN`（值 file-sourced，見 10 §6.0）→ 加回區塊 → redeploy。

**環境前置（2026-09-04 實測驗證）**：wrangler 4.129 需 **Node.js ≥ 22**——本 dev 主機 node 20.20 跑不動任何 wrangler 指令（`wrangler types`/`deploy` 都會擋）。首次部署 [MUST] 在 node ≥ 22 環境執行。**已驗證免 sudo 方案**：user-space tarball 即可——`curl -fsSLO https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz` 解壓後 `export PATH=<dir>/bin:$PATH`，在本機實測 `wrangler --version`（4.129.0 ✓）、`wrangler types`（✓）、`wrangler deploy --dry-run`（✓ 127.60 KiB bundle、D1 binding 認得）全綠——首次部署工具鏈本機已證可用，不需 nvm/容器/sudo。部署後 runtime 為 workerd，不受主機 node 版本影響。（2026-09-05 更新：主機已升級 glibc 2.39＋node 24，wrangler CLI 與 app pool 均可直接本機執行，環境限制解除。）

**CI runner 狀態（2026-09-04 發現，操作者待辦）**：self-hosted runner 目前**離線**——CI run #1（d8a6c9c，2026-09-04 03:46 UTC）至今 queued 未被拾取。且 `make ci` 含 `npm test` → `test:app` → workerd（需 host glibc ≥ 2.32；本機 2.31）：若 runner 直接跑在這台 Ubuntu 20.04 主機，app pool 同樣跑不動，需容器化 runner（glibc 較新）或升級 runner 主機。runner 離線期間，`Run Backup` step（R2 備份所有 repo）一併停擺。pre-push hook 已加環境探測（workerd 不可執行 → 降級模式 typecheck+lint+guards，大聲標示，app pool 由 CI 補全量）。（2026-09-05 更新：主機升級後 app pool 已可本機全量執行——pre-push 實測 62/62+21/21 全綠；runner 線上與否只影響 CI 記錄補全，不再影響本機驗證能力。）

**D1 前置（2026-09-05 部署嘗試發現；操作者裁定暫不建，部署暫停）**：`wrangler.jsonc` committed 的 `database_id 920a2626-0afb-4b2b-9324-85004aa10b49` 在帳號上**不存在**（API 7404）——該 id 從未對應真實 DB，首次部署前 [MUST] 先建。但 `wrangler d1 create watch-dog-db` 被帳號 D1 額度擋下：Free plan 上限（10 顆）已滿——現有 10 顆全屬其他專案（starview-bot-db／omni-bot-tenants-dev／topreview-demo-dev／topreview-dev-db／hotel-cms-dev-db／heartgui-db／starview-db／web-v01-db／starview-core_DB／neo-web-prod），逐顆查過 sqlite_master 皆有真實資料，無空殼可清。恢復部署任一解法：騰 slot（刪一顆 demo/dev DB，如 topreview-demo-dev 72KB demo 資料）／升級 Workers Paid／改用其他 CF 帳號（需該帳號 token）。恢復流程：`wrangler d1 create watch-dog-db` → 更新 `wrangler.jsonc database_id`（committed 欄位，非 secret）→ `wrangler d1 execute watch-dog-db --remote --file src/db.sql -y`（冪等 schema，4 表）→ 再走上面 #14258 首次 deploy 流程。本次嘗試已完成：push 3646782 ✓、CF token 驗證 ✓（paipeter 帳號）。
