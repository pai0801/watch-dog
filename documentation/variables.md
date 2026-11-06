# variables.md — 環境變數與 secret 盤點（D26 核心集）

> 產出：07-ALL-IN-ONE cycle 2026-11-06（03 §5a）。
> 真源：`.portability.toml`（[secrets] 合約）＋ `wrangler.jsonc` ＋程式碼。本表為文件鏡像，衝突時以上述真源為準。
> D37：揮發性數值（secret 個數等）不寫死，見 `.portability.toml` 即時內容。

## Worker runtime secrets（`wrangler secret put`，域 B）

| Name | used-by | scope | source | rotation | risk |
|---|---|---|---|---|---|
| `ADMIN_ACCOUNT` | `src/middleware/adminAuth.ts`（Basic Auth 帳號） | server | 操作者自訂（2026-09-05 起帳密成對） | 與 `ADMIN_PASSWORD` 成對輪替 | admin 面存取憑證 |
| `ADMIN_PASSWORD` | `src/middleware/adminAuth.ts` | server | 操作者自產 | 同上 | 同上 |
| `CF_USAGE_API_TOKEN` | `src/routes/api.ts`（GET /api/cf-usage Bearer 驗證） | server | `openssl rand -hex 32`（2026-09-12） | 對外用量 API 讀取憑證；輪替需同步所有 consumer | 跨專案 machine consumer 讀 CF 用量 |

以上三者列 `wrangler.jsonc` `secrets.required`（Layer 1 部署期驗證）＝ `.portability.toml [secrets].worker` ＝ `src/lib/bindings.ts REQUIRED_BINDING_KEYS`（三方同步，guard §F/§G 鎖定）。

## Optional worker secrets（缺 → 對應功能 fail-closed/degraded，核心哨兵不受影響）

| Name | used-by | scope | source | rotation | risk |
|---|---|---|---|---|---|
| `OPS_CONTROL_HOST_TOKEN` | `src/services/crossMonitor.ts`（向 ops-control 發 heartbeat 的 Bearer） | server | ops-control 自產（watch-dog 為消費方） | 破壞性輪替：兩 repo 域 A/B 同步（見 .portability.toml meta） | 跨服務互監失效（靜默跳過） |
| `TRIGGER_TOKEN` | `src/routes/trigger.ts`（POST /api/engine/trigger） | server | `openssl rand -hex 24`（2026-10-24）；rn1g 端 env 檔同步 | 兩處同步（wrangler secret put + scp env 檔） | 缺 → 端點 503 fail-closed |
| `ISSUES_INGEST_TOKEN` | `src/routes/issues.ts`（POST /api/ingest/issues，CF webhook `cf-webhook-auth` header） | server | `openssl rand -hex 24`（2026-10-31）；CF Automations webhook 目的地同值 | 兩處同步（CF dashboard + wrangler secret put） | 缺 → 端點 503 fail-closed |
| `WINDMILL_TOKEN` | `src/routes/issues.ts`（/api/windmill/* 車道） | server | `openssl rand -hex 24`（2026-10-31）；rn4g-1 Windmill variables 同值 | 兩處同步 | 缺 → 端點 503 fail-closed |

## [vars]（非機密，committed `wrangler.jsonc`）

| Name | used-by | scope | source | rotation | risk |
|---|---|---|---|---|---|
| `OPS_CONTROL_HEARTBEAT_URL` | `src/cron.ts`（engine heartbeat gate）＋ `src/services/crossMonitor.ts` | server | `https://ops-control.travelplus.cc`（Custom Domain——Worker→workers.dev fetch 被 1042 擋） | 隨 ops-control 網域變更 | 非 token，無機密性 |

## 非 runtime 憑證（deploy-time shell，不入 worker 合約）

`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（`.env`，secrets-archive env.7z 備份）——wrangler deploy 用，非 worker binding（alliance-member 先例，見 `secrets-archive/SECRETS.md`）。

## 歷史（已移除，非現役）

- `ADMIN_TOKEN`：2026-09-05 起被帳密成對模型取代。
- `SLACK_API_TOKEN` env fallback：2026-09-04 移除——Slack/email 憑證現源 = D1 `settings` 表（`/admin` 設定，`src/services/settings.ts`），DB 值永不回顯（`src/views/adminViews.ts` maskToken）。

## 無 client-side secret 確認

本專案無 client bundle（server-rendered hono/html 視圖＋htmx；無 Astro/Svelte/SPA）。所有 secret 只在 worker runtime 存取；dashboard/admin HTML 不渲染任何 secret 值（admin 面板僅渲染 `maskToken` 尾 4 碼，`src/views/adminViews.ts:39`）。

## pre-go-live checklist

- [x] 每個 secret 在 `.portability.toml [secrets]` 有 name+meta（權威清單）
- [x] `wrangler.jsonc secrets.required` 與 manifest 同步（guard §G）
- [x] `assertBindings`（`src/lib/bindings.ts`）涵蓋 required 全集（guard §F）；optional 走 try* accessor
- [x] 值 [MUST] file-sourced（`wrangler secret put` < file）；agent 不經手明文
- [x] 域 A 備份：`secrets-archive/env.7z`（AES-256，master 密碼在密碼管理器＋離線備份）
- [ ] `CLOUDFLARE_API_TOKEN` 檔案洩漏輪替（`docs/plans/2026-02-02` 已 redact——**操作者待辦**：CF dashboard 輪替＋更新 SECRETS.md，見 FIX-LOG）
