# Secret 依賴清單 — watch-dog

> 人類合約：這份表告訴你「動了會死在哪裡」。機讀後設資料在 `.portability.toml [secrets.meta]`；敘述性欄位只在這裡，不雙寫。
> 補齊準則見 `~/Code/rules/references/SECRETS-CONTRACT-TEMPLATE.md` 與 10-SECRETS-CONTRACT §2。
> rotate 後：設新值到雲端（`wrangler secret put <NAME>`，值 file-sourced）→ redeploy → `bash secrets-archive/seal.sh` → 更新本表「上次更換」→ git commit。

## Worker runtime secrets

| Secret 名稱 | 用途（一句話） | 來源（服務/帳號） | 被誰使用（檔案/服務） | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `ADMIN_ACCOUNT` | `/admin/*` Basic-Auth 帳號（與 ADMIN_PASSWORD 成對驗證，2026-09-05 起取代單一 ADMIN_TOKEN） | 操作者自訂 | `src/middleware/adminAuth.ts`、`src/lib/bindings.ts`、`wrangler.jsonc secrets.required`、`.env`/`.dev.vars`（本地） | 與 ADMIN_PASSWORD 一組重設；換值後瀏覽器需重新輸入。缺值 = 部署被擋（Layer 1）+ runtime fail-fast（Layer 2） | **2026-09-05 首次設定**（值來自操作者 `.env`，file-sourced pipe，agent 未經手值） |
| `ADMIN_PASSWORD` | `/admin/*` Basic-Auth 密碼 | 操作者自產（建議 `openssl rand -hex 24`） | 同上 | 同上（與 ADMIN_ACCOUNT 一組） | **2026-09-05 首次設定**（同上） |
| ~~`ADMIN_TOKEN`~~（**已移除 2026-09-05**——由上兩項成對取代） | ~~`/admin` Basic-Auth 單一密碼（username 忽略）~~ | ~~自產~~ | ~~`src/middleware/adminAuth.ts` 等~~ | worker secret 已刪除；歷史部署流程見 FIX-LOG 2026-09-05 條目 | 已移除 |
| ~~`SLACK_API_TOKEN`~~（**已移除 2026-09-04**，TODO-REVIEW #7） | ~~Slack 警報發送 token 的 env fallback~~ | Slack workspace app（Bot User OAuth Token） | ~~`src/lib/bindings.ts`（trySlackApiToken）、`src/services/settings.ts`（getEnvWithFallback）~~——移除時系統**從未部署**，零部署受影響 | 現行真相源 = **D1 `settings` 表**（`/admin` 設定，`getAllSettings` 讀取），env 途徑已不存在 | env fallback 已於首次部署前移除（DB settings 值由操作者在 /admin 管理） |

## Deploy-time shell 憑證（非 worker runtime binding，不入 `[secrets].worker`）

| 名稱 | 用途 | 來源 | 被誰使用 | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler CLI 部署/管理權限（deploy 時 shell 讀 `.env`） | Cloudflare dashboard → My Profile → API Tokens | `.env` → `wrangler deploy` / `wrangler secret put` / `wrangler d1` 等指令 | 換掉後所有 wrangler 部署與管理指令失效（worker runtime 不受影響）；需同步 `.env` + `seal.sh` | **2026-09-05 帳號切換**：`.env` 現為 **helperp@gmail.com** 帳號 token（操作者提供，首次部署用它完成）——prod 資源全在 helperp 帳號。舊 **paipeter** 帳號 token 的明文洩漏（`docs/plans/2026-02-02-watch-dog-sentinel.md:33`，git 歷史仍有）[MUST] 確認已於 dashboard 作廢；`env.7z` 內封存的是舊值，`.env` 切換後 [MUST] `seal.sh` re-seal（操作者，需 master 密碼） |
| `CLOUDFLARE_ACCOUNT_ID`（非機密） | wrangler 帳號定位（ID，非 secret） | Cloudflare dashboard | `.env` → wrangler CLI | 同上（與 token 一組重設） | 2026-09-05 起 = helperp 帳號 `8fdbf0eee4f313e95f30e901141d9758`（prod 所在） |

## 首次部署提醒（#14258）

全新 Worker 第一次 deploy 前不能設 secret，`wrangler.jsonc secrets.required` 會擋首次部署。流程：
暫時移除 `secrets` 區塊 → `wrangler deploy` → `wrangler secret put ADMIN_TOKEN`（值 file-sourced，見 10 §6.0）→ 加回區塊 → redeploy。

**環境前置（2026-09-04 實測驗證）**：wrangler 4.129 需 **Node.js ≥ 22**——本 dev 主機 node 20.20 跑不動任何 wrangler 指令（`wrangler types`/`deploy` 都會擋）。首次部署 [MUST] 在 node ≥ 22 環境執行。**已驗證免 sudo 方案**：user-space tarball 即可——`curl -fsSLO https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz` 解壓後 `export PATH=<dir>/bin:$PATH`，在本機實測 `wrangler --version`（4.129.0 ✓）、`wrangler types`（✓）、`wrangler deploy --dry-run`（✓ 127.60 KiB bundle、D1 binding 認得）全綠——首次部署工具鏈本機已證可用，不需 nvm/容器/sudo。部署後 runtime 為 workerd，不受主機 node 版本影響。（2026-09-05 更新：主機已升級 glibc 2.39＋node 24，wrangler CLI 與 app pool 均可直接本機執行，環境限制解除。）

**CI runner 狀態（2026-09-04 發現，操作者待辦）**：self-hosted runner 目前**離線**——CI run #1（d8a6c9c，2026-09-04 03:46 UTC）至今 queued 未被拾取。且 `make ci` 含 `npm test` → `test:app` → workerd（需 host glibc ≥ 2.32；本機 2.31）：若 runner 直接跑在這台 Ubuntu 20.04 主機，app pool 同樣跑不動，需容器化 runner（glibc 較新）或升級 runner 主機。runner 離線期間，`Run Backup` step（R2 備份所有 repo）一併停擺。pre-push hook 已加環境探測（workerd 不可執行 → 降級模式 typecheck+lint+guards，大聲標示，app pool 由 CI 補全量）。（2026-09-05 更新：主機升級後 app pool 已可本機全量執行——pre-push 實測 62/62+21/21 全綠；runner 線上與否只影響 CI 記錄補全，不再影響本機驗證能力。）

**D1 前置（2026-09-05 部署嘗試發現；同日以帳號切換解決，見下段）**：`wrangler.jsonc` 原 committed 的 `database_id 920a2626-0afb-4b2b-9324-85004aa10b49` 在 paipeter 帳號上**不存在**（API 7404）——該 id 從未對應真實 DB。paipeter 帳號 `d1 create` 又被 Free plan 額度擋（10 顆上限全屬其他專案：starview-bot-db／omni-bot-tenants-dev／topreview-demo-dev／topreview-dev-db／hotel-cms-dev-db／heartgui-db／starview-db／web-v01-db／starview-core_DB／neo-web-prod，逐顆查過皆有真實資料）。**操作者裁定改用 helperp@gmail.com 帳號**（`.env` 換值）——舊帳號端本 session 未建成任何資源，無需清理。

## 首次部署完成記錄（2026-09-05，helperp 帳號）

- **D1**：`watch-dog-db`（APAC），`database_id 2b2ec8c6-87bf-4005-98b9-56658bbda493`（已更新進 `wrangler.jsonc`）；schema 8 queries 冪等套用（4 表）。
- **Worker**：https://watch-dog.helperp.workers.dev ，cron `* * * * *` 已啟動，version `5d08ce4e-22d0-421b-8f46-7f1bbaea6c5d`（--minify 68.27 KiB）。
- **ADMIN_TOKEN**：#14258 流程設定（暫移 secrets 區塊 → deploy → secret put file-sourced → 加回）；`wrangler secret list` 確認。
- **線上驗證**：dashboard 200／`/admin` 無憑證 401／`POST /api/pulse` 無 token 401／`/api/status` 200（D1 讀路徑）；e2e 煙霧：config 註冊 → pulse → status 驗 `last_seen` 寫入／`is_stale=false` → 測試資料已 DELETE 清除（projects:0）。
- **操作者後續**：① `/admin` 設定 Slack 頻道（現為零專案零警報的安全空態；alert 鏈在 Slack token 未設時不發送）；② `env.7z` re-seal（`.env` 已切 helperp 憑證，封存內容過時）；③ 確認舊 paipeter token 已於 dashboard 作廢（洩漏 git 歷史仍在）。
