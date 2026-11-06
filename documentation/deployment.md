# Deployment & Operations — watch-dog

> Last verified: 2026-11-06（07-ALL-IN-ONE cycle；D36 README parity 讀此欄位）
> 記錄 IS（現狀）。部署政策見全域 CLAUDE.md（直接部署 prod 允許；ship.sh 概念在本 repo 為 portability-smoke）。

## 環境矩陣

| 環境 | 帳號 | D1 | KV/R2 | URL | 隔離 |
|---|---|---|---|---|---|
| dev（本機） | — | 本機模擬（`wrangler dev` 內建 `.wrangler/state`） | 無 | `http://localhost:8789`（`./dev-tunnel.sh`；Network IP 以 `ip -4 addr` 為準） | 純本機，零雲端資源 |
| prod | helperp@gmail.com（單一 CF 帳號） | `DB` → `watch-dog-db`（id `2b2ec8c6-87bf-4005-98b9-56658bbda493`，模式 B prod-in-repo） | 無 | `https://watch-dog.helperp.workers.dev` | 單一共享部署（無 preview env——wrangler.jsonc 無 `[env]` 區塊） |

Cron：`*/1 * * * *`（偵測引擎＋scheduler hub tick；Free 額度計條數不計頻率）。

## 部署指令

```bash
# 0.（建議）部署前本地驗證
make ci                        # tsc + eslint + 雙 pool 測試 + §L/§M python guard
bash scripts/portability-smoke.sh   # fresh-clone 可重建煙霧測試

# 1. D1 migration（部署「前」——見下節順序）
npx wrangler d1 execute watch-dog-db --remote --file=src/db.sql

# 2. 部署
npm run deploy                 # = wrangler deploy --minify

# 3. 部署後驗證（見下節清單）
```

Build gate＝`make build`（`wrangler deploy --dry-run --outdir dist`——本專案無獨立 build step）。

## Secrets 與變數

完整清單＋rotation 風險＝`documentation/variables.md`（SSoT 鏡像；合約真源 `.portability.toml [secrets]`）。

| 名稱 | 用途 | scope | 設定指令 |
|---|---|---|---|
| `ADMIN_ACCOUNT`／`ADMIN_PASSWORD` | admin Basic Auth 帳密成對 | server | `wrangler secret put <NAME>`（file-sourced） |
| `CF_USAGE_API_TOKEN` | GET /api/cf-usage Bearer | server | 同上 |
| `OPS_CONTROL_HOST_TOKEN`（optional） | ops-control 互監心跳 | server | 同上（值源＝ops-control 域 A） |
| `TRIGGER_TOKEN`（optional） | POST /api/engine/trigger | server | 同上（與 rn1g env 檔同步） |
| `ISSUES_INGEST_TOKEN`（optional） | CF Automations webhook | server | 同上（與 CF dashboard 同值） |
| `WINDMILL_TOKEN`（optional） | Windmill 處置車道 | server | 同上（與 rn4g-1 variables 同步） |

Vars（非機密）：`OPS_CONTROL_HEARTBEAT_URL`（committed wrangler.jsonc）。Deploy-time shell 憑證（不入 worker）：`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`（`.env`，secrets-archive env.7z 備份）。

## Migration 順序

1. `src/db.sql`（冪等 `CREATE TABLE IF NOT EXISTS`）——**部署前**對 remote D1 執行：`npx wrangler d1 execute watch-dog-db --remote --file=src/db.sql`
2. `wrangler deploy`（部署後）
3. 原則：schema 變更一律 additive（新表/新欄），舊代碼可跑新 schema → 先 migration 後部署永遠安全
4. 本 cycle（2026-11-06）新增：`login_failures` 表（admin 失敗計數；缺表＝限流靜默失效——**部署後必驗**，見下節）

## 回滾程序

```bash
# Worker 回滾（上一個 deployment）
npx wrangler rollback

# Migration backout：不回滾——schema 變更 additive 且冪等（CREATE IF NOT EXISTS），
# 舊代碼相容新 schema；回滾 worker 即可，D1 表留著無害（login_failures 空表零成本）。
```

## 部署後驗證

- [ ] `curl -s https://watch-dog.helperp.workers.dev/api/status` → 200（JSON projects 陣列）
- [ ] `curl -sI https://watch-dog.helperp.workers.dev/api/status | grep -iE "x-frame|nosniff|referrer|strict-trans"` → 四行皆在（N1 secureHeaders）
- [ ] `npx wrangler d1 execute watch-dog-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='login_failures'"` → 有列（N2 migration 已套用）
- [ ] 瀏覽器開 `/`：dashboard 雙 Tab 渲染、htmx 30s 輪詢無 console error（CDN script 載入正常）
- [ ] 瀏覽器開 `/admin`（帳密）：200 且頁面互動正常；故意錯密碼一次 → 401（計數路徑活著）
- [ ] 1-2 分鐘後 `watch-dog:self-health` 的 `last_seen` 推進（cron 活著——dashboard 或 `wrangler d1 execute ... "SELECT last_seen FROM checks WHERE id='watch-dog:self-health'"`）

## 維運 Runbook

- **即時 log**：`npx wrangler tail`（錯誤過濾 `--format pretty` 後 grep）
- **手動觸發引擎**（cron 疑似卡住時）：`curl -X POST .../api/engine/trigger -H "Authorization: Bearer <TRIGGER_TOKEN>"`
- **D1 查詢**：`npx wrangler d1 execute watch-dog-db --remote --command "..."`
- **本地起服務**：`DEV_PORT=8789 ./dev-tunnel.sh`（+`ngrok` 參數開 tunnel；`stop` 停止）
- **admin 排障**：忘記密碼 → 重新 `wrangler secret put ADMIN_ACCOUNT/ADMIN_PASSWORD`；IP 被鎖（429）→ 等 15 分視窗過期或 `DELETE FROM login_failures WHERE ip = '<ip>'`
- **secret 輪替**：改值 → `wrangler secret put` → 更新 `secrets-archive/SECRETS.md` → `bash secrets-archive/seal.sh` → commit（跨服務共用者見 variables.md 同步面）
- **換帳號 runbook（模式 B prod-in-repo 必備，09 §1.2）**：①新帳號建 D1（`wrangler d1 create watch-dog-db`）②替換 wrangler.jsonc `database_id` ③`wrangler d1 execute --remote --file=src/db.sql` ④重設全部 secrets（上表）⑤`npm run deploy` ⑥跑「部署後驗證」清單 ⑦受盡服務的 WATCHDOG_URL 不變（workers.dev 名稱同）則 client 零改動
- **額度紀律**：動 D1/KV 前讀全域 CLAUDE.md「Cloudflare 免費額度紀律」（帳號級後爆型；本檔歷史事故見 wrangler.jsonc 註解）
