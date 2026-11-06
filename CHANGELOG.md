# Changelog — watch-dog

> 格式：New / Improved / Fixed / Breaking 以**使用者利益**開頭（D32）；每條 Fixed 攜帶 `(locked: D##)` 或 `(human: 理由)` tag（D17）。
> 歷史（2026-11-06 前）無 CHANGELOG——重大 user-facing 變更以下方「未分段歷史」段回填索引，細節以 git log 為準。

## 2026-11-06 — 07-ALL-IN-ONE 全量收斂輪

### FRAMEWORK-SYNC（§1.5 對帳記錄）

- 吸納 rules repo 更新（ab6129a＋62de285）：07 新增 §1.5 FRAMEWORK-SYNC／DEP-HEALTH／SEC-REVIEW 三掛點；`references/DEPENDENCY-HEALTH.md`＋`SECURITY-REVIEW.md` 首次入庫；registry 擴至 D39（D37 volatile-number SSoT／D38 non-vacuous／D39 dead-param 由前輪已入）。
- `references/GUARD-TEMPLATES.md` fast-forward 採 rules 版（帶入 D20 freshness 條款＋D17 範例；本地原為嚴格子集，零適配損失）。
- `01-CLAUDE.md` MANUAL 分歧＝專案棧適配，保留（Hono 單 Worker/D1 原生/無 Astro 棧表）。
- 專案調整決定：`npm run build` 框架指令映射為本專案 `make build`（wrangler dry-run；無獨立 build step 的 Worker 專案）。

### New

- **接手者現在有一份能照做部署、回滾、排障的維運手冊**——`documentation/deployment.md`（D35 七 section：環境矩陣/部署指令/Secrets/Migration/回滾/部署後驗證/Runbook＋換帳號 runbook）。(locked: D35)
- **專案的架構、資料流、權限矩陣、變數盤點、測試地圖首次成文檔集**——`documentation/` 核心集 5 份（D26；每條 rule 附 code cite 供 D27 parity 驗證）。(locked: D26)
- **admin 面不再暴露於無限密碼猜測**——Basic Auth 失敗計數鎖定（20 次/15 分/IP，D1 跨 isolate；鎖定後免寫入不燒額度；計數故障 fail-open 不鎖死操作者）。(locked: SEC-1a)

### Improved

- **所有頁面與 API 回應現在帶安全 headers 基準**（X-Frame-Options DENY/nosniff/Referrer-Policy/HSTS＋COOP/CORP）——admin 頁不再可被 iframe clickjacking。(locked: SEC-1d)
- **受監服務的接入文件不再誤導**——`docs/development.md` 全面校正（admin 帳密成對指引/結構樹補 12+ 檔/Node 22+/封閉註冊措辭）；`docs/api.md` 補齊 issues 收集器家族 8 端點與外部觸發源（原自稱完整但缺整個家族）。(locked: D16)
- **文檔幽靈引用絕跡**——歷史檔歸檔（6 檔移 `docs/plans/`）、2 個無關孤兒檔刪除（git 可回溯）。

### Fixed

- **依賴層安全通告清零**——hono floor `^4.11.7 → ^4.13.16`（GHSA-q5qw-h33p-qvwr serveStatic 任意檔案存取、GHSA-88fw-hqm2-52qc CORS 反射、basicAuth/bearerAuth timing hardening；本專案前二者不可達但升級封堵）；`npm audit --omit=dev` 歸零。(locked: DEP-P0)
- **照舊文檔設定 admin 必失敗的坑移除**——`wrangler.jsonc` 首部署註解與 `scripts/bootstrap.sh` 提示改為 `ADMIN_ACCOUNT`/`ADMIN_PASSWORD` 成對（原寫已除役的 `ADMIN_TOKEN`）。(locked: D16)
- **過時 ADMIN_TOKEN 註解殘留清除**（src/routes/admin.ts、src/lib/bindings.ts）。(locked: D16)

### Security

- SEC-REVIEW 五項首輪基線（方法論 `references/SECURITY-REVIEW.md`）：1a admin 限流 GAP→**已修**（上 New 條）；1b session N/A（無 session/cookie）；1c CSRF/CSPRNG PASS；1d headers GAP→**已修**；1e 隨修復補測試鎖定。Medium 以下逐卡見 TODO-REVIEW N10-N13。

### Dependencies

| 套件 | 動作 | 理由 |
|---|---|---|
| hono | `^4.11.7 → ^4.13.16` | P0 direct HIGH×2（皆不可達）＋timing hardening；DEP-HEALTH §2 安全批次 |
| （P2 major：typescript 7 / msw 3 / @msw/cloudflare 0.2） | 逐卡 defer | [NEVER] 安全批次混 major；見 TODO-REVIEW N14 |

### Guard 接線（本輪新增）

- tests/guards/ 新增：D16（文檔 code-path drift）、D17（fix→lock tag）、D26/D28（documentation 集/測試地圖）、D27（intent-parity 結構驗證）、D29（ship-check gate）、D30/D31（retro/pre-mortem）、D32（release-notes）、D33（acceptance）、D35/D36（deployment/README parity）、D37（volatile-number SSoT）——D38 violation-injection 證明隨附。

---

## 未分段歷史（2026-09-04 框架採用 → 2026-11-05，索引）

> 133 commits 未有 CHANGELOG；user-facing 大項回填索引（doc-drift 閘門，getkm 048227214ba1）。細節＝各 commit 與 FIX-LOG。

- **排程觸發樞紐上線**（2026-10-19，scheduler hub）：受監服務可註冊回呼 URL，watch-dog 到期 POST 喚醒（HMAC 簽名），不必自佔 CF cron slot；cron 放回每分鐘。
- **跨帳號互監**（2026-10-23/24，cross-monitor）：watch-dog 每分鐘向 ops-control（獨立帳號）發心跳——watch-dog 自己死掉時有人訂告；fetch piggyback 免疫 CF cron dispatch 抖動；rn1g VPS cron 成為第二觸發源（POST /api/engine/trigger）。
- **CF Issues 收集器＋Windmill 處置閉環**（2026-10-31，WATCHDOG-015/016）：CF Workers 異常 webhook 推進 watch-dog 分診（零代碼接入）→ Windmill 認領自動處置（雙保險絲）；服務也可經 `POST /api/issues/report` 自評掛號。
- **CF 用量監控深化**：逐資源明細（d1/kv/r2 分項）＋對外唯讀用量 API（`GET /api/cf-usage` Bearer）＋Pages 手動別名＋KV writes/reads 拆分維度（q-order 10-29 KV 燒穿事故的精確偵測器）。
- **D1 額度結構性瘦身**（2026-11-03/04，WATCHDOG-020/OPSCONT-006）：ok-pulse log 小時採樣（~30k rows/day → ~1.4k）；engine 心跳 5 分鐘 gate＋piggyback 300s。
- **客戶端指南實戰淬煉**：毒丸類分級判準、寧缺勿濫原則（email-king 接入實戰）。
