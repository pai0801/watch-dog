# architecture.md — 產品概觀 + 信任邊界（D26 核心集）

> 產出：07-ALL-IN-ONE cycle 2026-11-06（03 §5a）。記錄 IS（現狀），非 SHOULD BE。
> 揮發性數值（測試數、表數等）不寫死於此（D37）——見 CLAUDE.md／guard 測試輸出。

## 產品概觀 + 假設

**watch-dog 是被動式 dead-service 監控哨兵（Dead Man's Switch）＋排程觸發樞紐（scheduler hub）＋ CF Issues 收集器**，三功能共用單一 Worker：

1. **服務監控**：受監服務定期上報 pulse；**pulse 停了＝服務死了**（絕非主動健康檢查——不變式①）。Cron 每分鐘掃描逾期 → Slack／email 警報。
2. **Cron 觸發**：受監服務註冊回呼 URL；每分鐘 tick 到期即 POST 喚醒（HMAC 簽名）——對方不必佔自己的 CF cron slot。
3. **Issues 收集器**：CF Workers Issues Automations webhook 推入異常 → 分診狀態機 → Windmill（rn4g-1）認領自動處置；`GET /issues` 公開觀察頁。

**隱含前提（assumptions）**：

- 單操作者系統（專案不變式②）：非多租戶、封閉註冊（project 由操作者經 `/admin` 建立）；資料隔離＝per-project token scoping。
- 受信 outbound 對象（Slack／email-king／CF API／ops-control／註冊的 callback URL）皆操作者設定。
- workers.dev 單一部署（`watch-dog.helperp.workers.dev`），無 Custom Domain、無 preview env。
- 警報通道容量可用（Slack/email）；偵測語義優先於一切附加功能（不變式①：scheduler hub／cf-usage／cross-monitor 的故障絕不拖垮 fail-dead 偵測）。

## 技術棧

| 層 | 技術 | 備註 |
|---|---|---|
| Runtime | Cloudflare Workers（workerd），cron `*/1 * * * *` | wrangler.jsonc |
| Framework | Hono 4（routing/middleware＋hono/html server-rendered 視圖＋htmx 輪詢） | 無 Astro/Svelte/SPA/client bundle |
| 資料庫 | Cloudflare D1，**原生 prepared statements（無 ORM）** | SQL 全靜態字面值＋`.bind()`（不變式③，guard §B 鎖定）；無 KV/R2 |
| 測試 | Vitest 4＋@cloudflare/vitest-plugin（app pool workerd 全保真）＋Node guards pool | npm test 雙 pool |
| Lint | ESLint 10 flat config | `no-explicit-any` error（不變式④預算 0） |
| 部署 | `npm run deploy`（wrangler deploy --minify）；build gate＝`make build`（deploy --dry-run） | |

Schema 真源＝`src/db.sql`（`CREATE TABLE IF NOT EXISTS` 冪等）；D1 無跨語句 transaction——併發正確性全靠 SQL 層 CAS（`src/services/logic.ts:4` 註解）。

## 端到端 auth 流（無 session）

無 session/cookie/JWT——每請求靜態鑑權因子：

- **Project token**（Bearer）：token 即身分。驗證＝`timingSafeEqual`（`src/lib/auth.ts:19`，UTF-8 byte-length 先比）；scope 衍生見 `permissions.md`。
- **Admin Basic Auth**：`ADMIN_ACCOUNT`/`ADMIN_PASSWORD` 帳密成對（`src/middleware/adminAuth.ts`）；非 GET 另需 `HX-Request` marker（CSRF guard）；缺 secret → 503 fail-closed。
- **靜態 Bearer secret 端點**（cf-usage／trigger／issues ingest／windmill）：各自專用 secret，缺 → 503 fail-closed（**缺配置絕不等於開放**）。
- 詳細角色×資源矩陣 → `permissions.md`。

## 信任邊界（trust boundaries）

| 邊界 | 機制 | 位置 |
|---|---|---|
| 匿名公開面（`/`、`/issues`、`/cf-usage/detail`、`/api/status*`） | 原始碼級資訊截斷：token／account_id（32-hex）永不 SELECT 進回應；錯誤文字截 200 字元 | `src/routes/api.ts:382`、`src/routes/dashboard.ts:58`、`src/services/cfUsage.ts:284` |
| Project token 面 | 常數時間比對＋404/403 語義設計（封閉註冊 404；ownership mismatch 404 防存在性 oracle） | `src/lib/auth.ts`、`src/routes/schedules.ts:45` |
| Admin 面 | Basic Auth＋XHR marker CSRF＋JSON-only body 415 | `src/middleware/adminAuth.ts`、`src/routes/admin.ts:29` |
| 機器對機器 secret 面 | fail-closed 503＋timingSafeEqual | `src/routes/trigger.ts:33`、`src/routes/issues.ts:37` |
| Outbound（Slack/email-king/CF API/ops-control/scheduler callback） | 全 timeout＋try/catch 永不拋；callback https-only＋HMAC 簽名 | `src/services/alert.ts`、`src/services/scheduler.ts:65` |
| 啟動邊界 | `assertBindings` 只在 fetch 路徑 fail-loud；scheduled 刻意繞過（cron 缺 admin secret 也要繼續告警） | `src/lib/bindings.ts:9`、`src/index.ts:42` |

## Known-risks（每條附 code cite）

1. **公開端點無 rate limit**（`/cf-usage/detail` label probing 等）——單操作者系統＋per-isolate 快取可接受；label 輸入有 100 字元上限（`src/routes/dashboard.ts:33`）。緩解現況＝額度與記憶體影響有限，無 brute-force 值得保護的匿名面。
2. **Mount 順序是承重牆**：admin 的 app-wide Basic Auth gate 會吃掉後掛路由——日後新增 public route 若掛在 adminRoutes 之後會被誤鎖（`src/index.ts:26` 註解；TODO-REVIEW #27 待收窄為 `/admin/*`）。
3. **Piggyback 心跳掩蓋 failure class**：fetch-path piggyback 會讓「cron 死但 fetch 活」的狀態看起來心跳新鮮（operator decision 2026-10-23，`src/services/crossMonitor.ts:57` 註解明示取捨）。
4. **CF REST 名稱刷新單頁假設**：D1/KV 資源 >100 個時 replace-set 會誤刪（`src/services/cfResources.ts` 註解；單操作者帳號規模遠低於此）。
5. **D1 額度是帳號級後爆型**：歷史事故（logs 全表掃描 ~4M rows/day）已根治（`idx_logs_created_at`＋hourly gate）；額度紀律見全域 CLAUDE.md（動 D1 前查餘量）。
6. **無 KV/R2/快取層**：快取僅 per-isolate Map（TTL 300s）——isolate 重生即失效，屬可接受之 best-effort。

## Related Documents（D26 索引）

| 文檔 | 用途 |
|---|---|
| `documentation/flows.md` | 負載承重流程（pulse／偵測／scheduler／issues／cf-usage／心跳） |
| `documentation/permissions.md` | 角色×資源矩陣、scope 衍生、deny cases |
| `documentation/variables.md` | 環境變數/secret 盤點＋pre-go-live checklist |
| `documentation/tests.md` | 測試地圖（3 section，D28） |
| `documentation/deployment.md` | 部署與維運（D35 七 section） |
| `docs/api.md` | API 端點契約（對外） |
| `docs/client-guide.md` | 受監服務接入指南 |
| `docs/development.md` | 開發環境設置 |
| `docs/testing.md` | 測試指南 |
| `docs/WINDMILL-CONTRACT.md` | Windmill 處置車道契約 |
| `docs/usage.md` | CF 用量 API 使用說明 |
| `01-CLAUDE.md` | 專案規則（SSoT） |

條件文檔判定：email 寄送能力存在（email-king gateway）但屬警報通道的一部分，流程記於 flows.md（不單獨 emails.md）；**cron.md 能力存在**（每分鐘 engine tick）→ 併入 flows.md 偵測流（此註記即 D26 條件文檔聲明）；seo.md N/A（noindex 監控工具，無 public indexable 內容站）；automation.md N/A（無 LLM/agent 能力——Windmill 是外部系統，契約見 docs/WINDMILL-CONTRACT.md）。
