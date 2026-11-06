# permissions.md — 角色、範圍、矩陣（D26 核心集）

> 產出：07-ALL-IN-ONE cycle 2026-11-06（03 §5a）。
> 本專案為**單操作者系統、非多租戶**（專案不變式②）：部署＝單一共享部署，資料隔離＝ per-project token scoping；admin＝Basic Auth 單操作者。無 session/cookie/角色資料庫——所有鑑權因子都是靜態 secret 或 DB token，逐請求驗證。
> 每條 rule 附 code cite（D27 intent-parity 依據）。

## Roles / 鑑權因子（actors）

| Role | 憑證 | 備註 |
|---|---|---|
| 匿名訪客 | 無 | 公開唯讀面 |
| Project（受監服務） | Bearer project token（DB `projects.token`，64-hex 級） | token 即身分；`timingSafeEqual` 常數時間比對（`src/lib/auth.ts:19`） |
| Operator（admin） | Basic Auth（`ADMIN_ACCOUNT`/`ADMIN_PASSWORD`） | 單操作者；`src/middleware/adminAuth.ts` |
| CF Issues webhook | `cf-webhook-auth` header ＝ `ISSUES_INGEST_TOKEN`（Bearer 同值也收） | CF Notifications 標準機制（`src/routes/issues.ts:34`） |
| Windmill（rn4g-1） | Bearer ＝ `WINDMILL_TOKEN` | 處置車道（`src/routes/issues.ts:128`） |
| 外部觸發源（rn1g） | Bearer ＝ `TRIGGER_TOKEN` | 第二引擎觸發（`src/routes/trigger.ts:30`） |
| CF 用量 consumer | Bearer ＝ `CF_USAGE_API_TOKEN` | 對外唯讀 API（`src/routes/api.ts:510`） |
| ops-control（受信 outbound） | watch-dog 持 `OPS_CONTROL_HOST_TOKEN` 發 heartbeat | 跨帳號互監（`src/services/crossMonitor.ts`） |

## scope 衍生處（where scope derived）

- **token → project_id**：兩條路徑——(a) body 帶 `project_id`：先 SELECT project 再 timingSafeEqual token（`src/lib/auth.ts:58` `authenticateProject`）；(b) 純 token 反查（`SELECT * FROM projects WHERE token = ?`，`src/routes/api.ts:281`）。兩者都先驗 token 再放行任何 project-scoped 寫入。
- **check 歸屬**：check id ＝ `{project_id}:{name}`（`src/routes/api.ts:131`）——寫入路徑以 composite key 綁死 project 歸屬。
- **schedule 歸屬**：`loadOwnedSchedule` 驗 project token 後再驗 `schedule.project_id === projectId`，mismatch → 404（無跨 project 存在性 oracle，`src/routes/schedules.ts:45`）。
- 無 role/claim 查表：鑑權因子本身（哪個 secret）決定角色，middleware/handler 逐一靜態指明。

## Resource × Operation × Role 矩陣

| Endpoint | Operation | 匿名 | Project token | Admin | 專用 secret |
|---|---|---|---|---|---|
| `GET /`、`GET /issues`、`GET /cf-usage/detail` | 讀 | ✅ 唯讀（`src/routes/dashboard.ts:50`、`src/routes/issues.ts:234`） | ✅ | ✅ | — |
| `GET /api/status`、`GET /api/status/:projectId` | 讀 | ✅ 唯讀（**永不回傳 token**，`src/routes/api.ts:382`） | ✅ | ✅ | — |
| `PUT /api/config` | 寫（project 自身 config） | ❌ 401 | ✅（**註冊封閉**：未知 project 404，`src/routes/api.ts:74`） | —（經 /admin 建） | — |
| `POST /api/pulse` | 寫（心跳） | ❌ 401/403（`src/routes/api.ts:248`） | ✅ | — | — |
| `POST /api/maintenance/:projectId` | 寫（靜音） | ❌（`src/routes/api.ts:334`） | ✅ 自身 | — | — |
| `POST /api/issues/report` | 寫（掛號） | ❌ | ✅（token 反查 project，`src/routes/issues.ts:78`） | — | — |
| `/api/schedules*`（GET/POST/PUT/DELETE） | 讀/寫（自身排程） | ❌ | ✅ 自身（owner 檢查） | 觀察唯讀（`GET /admin/schedules`，`src/routes/admin.ts:1158`） | — |
| `GET /api/cf-usage` | 讀 | ❌ 401 fail-closed（`src/routes/api.ts:514`） | ❌ | — | ✅ `CF_USAGE_API_TOKEN` |
| `POST /api/engine/trigger` | 寫（跑引擎 tick） | ❌（`src/routes/trigger.ts:30`） | ❌ | — | ✅ `TRIGGER_TOKEN`（缺→503） |
| `POST /api/ingest/issues` | 寫（webhook 掛號） | ❌ 401（`src/routes/issues.ts:34`） | ❌ | — | ✅ `ISSUES_INGEST_TOKEN`（缺→503） |
| `/api/windmill/*`（list/heartbeat/claim/feedback） | 讀/寫（處置車道） | ❌ 401（`src/routes/issues.ts:152`） | ❌ | — | ✅ `WINDMILL_TOKEN`（缺→503） |
| `/admin`、`/admin/*`（settings/logs/projects/checks/cf-usage/schedules 全部管理端點） | 全部 | ❌ 401（adminAuth `use('*')`，`src/routes/admin.ts:22`） | ❌ | ✅ | — |

**Mount 順序承重牆**：api/schedules/trigger/issues 必須 mount 在 adminRoutes 之前（admin 的 app-wide Basic Auth gate 會吃掉後掛的公開路由）——`src/index.ts:26-38` 註明；TODO-REVIEW #27（收窄為 `/admin/*`）待排程。

**Admin CSRF**：htmx 表單要求 `HX-Request` header（瀏覽器跨站表單不會帶）＋ JSON body 端點掛 `rejectJsonBody`（form-encoded cross-site POST → 415 fail-loud）——`src/routes/admin.ts:114` 起。

## 資料層保護分類

無 RLS（D1 無 row-level security 機制）；全部 **code-enforced**：

- project 隔離：所有 project-scoped 查詢 WHERE 帶 `project_id`（經 token 解析，非使用者輸入直通）。
- 32-hex resource id 洩漏防護：公開面（首頁/fragment/API）永不 SELECT/渲染 `account_id`（`src/routes/dashboard.ts:58`、`src/routes/api.ts:464`）；錯誤路徑訊息截 200 字元。
- token 洩漏防護：`/api/status` 回應剝除 `token` 欄位；admin 視圖 mask 尾 4 碼；Slack/email 憑證（D1 settings 表）永不回顯。

## Known deny cases（expect-deny 測試錨點）

- 錯 token → 403（`Invalid token for project`）；缺 header → 401；未知 project `PUT /api/config` → 404（封閉註冊）。
- 跨 project 存取 schedule → 404（存在性遮蔽）。
- 未設 optional secret 的端點 → 503 fail-closed（**缺配置 ≠ 開放**）。
- admin 無 Basic 憑證 → 401；JSON 端點收 form-encoded → 415。
