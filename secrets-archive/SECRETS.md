# Secret 依賴清單 — watch-dog

> 人類合約：這份表告訴你「動了會死在哪裡」。機讀後設資料在 `.portability.toml [secrets.meta]`；敘述性欄位只在這裡，不雙寫。
> 補齊準則見 `~/Code/rules/references/SECRETS-CONTRACT-TEMPLATE.md` 與 10-SECRETS-CONTRACT §2。
> rotate 後：設新值到雲端（`wrangler secret put <NAME>`，值 file-sourced）→ redeploy → `bash secrets-archive/seal.sh` → 更新本表「上次更換」→ git commit。

## Worker runtime secrets

| Secret 名稱 | 用途（一句話） | 來源（服務/帳號） | 被誰使用（檔案/服務） | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `ADMIN_TOKEN` | `/admin/*` Basic-Auth 密碼（username 任意） | 自產（`openssl rand -hex 24`） | `src/middleware/adminAuth.ts`、`src/lib/bindings.ts`（assertBindings fail-fast）、`wrangler.jsonc secrets.required`（Layer 1 擋部署）、`.dev.vars`（dev） | 換掉後所有已存瀏覽器 Basic 憑證即失效，重新輸入新密碼即可；設定後需 redeploy 才傳播。缺值 = 部署被擋（Layer 1）+ runtime 全站 fail-fast（Layer 2） | 2026-09-04（dev 值入庫；prod 首次部署時設定） |
| `SLACK_API_TOKEN`（optional，legacy） | Slack 警報發送 token——**D1 settings 表為主**（/admin 設定），env 值僅在 DB 設定為空時 fallback | Slack workspace app（Bot User OAuth Token） | `src/lib/bindings.ts`（trySlackApiToken）、`src/services/settings.ts`（getEnvWithFallback） | 換掉後僅影響「DB 未設定而依賴 env fallback」的部署——正規做法是在 /admin 重新設定 DB settings；兩處同值時替換需同步 | 未輪替（legacy fallback） |

## Deploy-time shell 憑證（非 worker runtime binding，不入 `[secrets].worker`）

| 名稱 | 用途 | 來源 | 被誰使用 | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler CLI 部署/管理權限（deploy 時 shell 讀 `.env`） | Cloudflare dashboard → My Profile → API Tokens | `.env` → `wrangler deploy` / `wrangler secret put` / `wrangler d1` 等指令 | 換掉後所有 wrangler 部署與管理指令失效（worker runtime 不受影響）；需同步 `.env` + `seal.sh` | **[MUST] 輪替中**：2026-09-04 發現明文洩漏於 `docs/plans/2026-02-02-watch-dog-sentinel.md:33`（detect-secrets baseline 掃描；值已 redact，git 歷史仍有）→ 於 CF dashboard 作廢舊 token、產新值進 `.env`、`bash secrets-archive/seal.sh`（見 FIX-LOG 2026-09-04 洩漏條目） |
| `CLOUDFLARE_ACCOUNT_ID`（非機密） | wrangler 帳號定位（ID，非 secret） | Cloudflare dashboard | `.env` → wrangler CLI | 同上（與 token 一組重設） | — |

## 首次部署提醒（#14258）

全新 Worker 第一次 deploy 前不能設 secret，`wrangler.jsonc secrets.required` 會擋首次部署。流程：
暫時移除 `secrets` 區塊 → `wrangler deploy` → `wrangler secret put ADMIN_TOKEN`（值 file-sourced，見 10 §6.0）→ 加回區塊 → redeploy。

**環境前置（2026-09-04 實測）**：wrangler 4.129 需 **Node.js ≥ 22**——本 dev 主機 node 20.20 跑不動任何 wrangler 指令（`wrangler types`/`deploy` 都會擋）。首次部署 [MUST] 在 node ≥ 22 環境執行（nvm/容器皆可）；部署後 runtime 為 workerd，不受主機 node 版本影響。CI（self-hosted 同機）的 `make ci` 不含 wrangler 呼叫，不受影響。
