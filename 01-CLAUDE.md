# Cloudflare Stack Constitution

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。

> 強制性工程合約。[MUST]/[NEVER]/[ALWAYS] 指令不可談判。
> 違規導致管道崩潰、3.3GB VPS 磁碟耗盡或憑證洩漏。

---

## 0. 強制合規聲明

**執行任何 git/CI 命令前**，對照此表。匹配即中止，修復根本原因。

| 禁止模式 | 嚴重性 | 正確操作 |
|---|---|---|
| `git commit/push --no-verify` | CRITICAL | 修復 hook 失敗，無 flag 重新提交 |
| `git push --force` 到 main/master | BLOCKED | 改寫共用歷史、不可逆；多寫入者環境（人 + auto-commit daemon + CI runner）會互蓋。改 `git pull --rebase` 或新增 revert commit（02 §6）|
| CI 後省略 `make clean` | HIGH | 3.3GB 磁碟，每次必須清理 |
| `2>/dev/null || true` 吞噬 lint 輸出 | HIGH | 僅抑制工具不存在的情況 |
| 提交 `.env`/`*.pem`/`*.key`/`*credentials*` | CRITICAL | 取消暫存，加 `.gitignore` |

---

## 1. 技術棧宣告

> **本表是框架的「完整 Cloudflare stack」範本。複製進專案後 [MUST] 依實際棧調整**——多數消費者只用一部分（如 Hono + 原生 HTML、或純 Pages Functions + KV），[NEVER] 照搬本表假裝採用整套。
> 本檔的 **universal prohibitions（§4–§6、§13–§15）是不可談判 core**（繼承、不刪）；§1 技術棧則是你的、可調。採用模型見 `rules/CLAUDE.md` Step 2（copy + adjust + merge-sync）。
> **watch-dog 真實棧**（下表已調整）：Hono 4 單一 Worker + D1 原生 prepared statements + 每分鐘 Cron，無 Astro/Svelte/Drizzle/R2/KV。

| 技術 | 技術棧 | 版本 |
|---|---|---|
| Runtime | Cloudflare Workers / Pages | 最新 wrangler |
| Framework | Hono 4（routing/middleware + hono/html 視圖,無 Astro/Svelte） | package.json |
| Database | D1 + 原生 prepared statements（本專案未用 ORM;見 §3 注記） | D1 |
| Storage | D1（關聯） | Cloudflare 平台 |
| Testing | Vitest 4 + @cloudflare/vitest-plugin + @msw/cloudflare | Vitest 4.x |
| Linting | ESLint 10 (flat config) + custom rules | flat config |

[MUST] 寫任何程式碼前先檢查 `package.json` 的版本釘選。

---

## 2. 邊緣架構原則

**Hono 單一 Worker**（本專案無 Astro 層）：Hono middleware 處理 auth / security filtering；路由掛載於 `src/routes/`（api / admin / dashboard）。

| 規則 | 指令 |
|---|---|
| Response 修改用 service wrapper，不用 `app.use('*')` | [MUST] `withSmartCache(c, () => handler)` |
| 只有 `src/lib/runtime.ts` 可 `import from 'cloudflare:workers'` | [NEVER] 其他文件直接 import |
| 禁止 Node.js APIs (fs, path, crypto) | [NEVER] 使用 Web API 等效項 |
| 禁止 Express / tRPC | [NEVER] 使用 Hono + Astro |

---

## 3. Drizzle ORM 強制規範

> **本專案注記**：watch-dog 未使用 Drizzle —— 全部查詢用 D1 prepared
> statements（`env.DB.prepare(...).bind(...)`）。本節 Drizzle 條目僅供框架
> 相容保留;實際遵循的是「參數化查詢、禁止字串拼接 SQL、WHERE 帶 project
> 過濾」等同等規範。

| 規則 | 指令 | 說明 |
|---|---|---|
| 所有 DB 查詢透過 Drizzle query builder | [MUST] | 禁止原始 SQL 或直接 D1 binding |
| `.set()` 用 JS property name (camelCase) | [MUST] | 不是 DB column name (snake_case) |
| 所有查詢 WHERE 必須包含 tenant 過濾器 | [MUST] | storeId / slug / tenantId |
| 原始 SQL 預算只能減少 | [MUST] | 加 `eslint-disable` 註解說明原因 |
| `.astro` 文件用 astro-db-helpers 隔離 Drizzle 類型 | [ALWAYS] | 避免 `astro check` 類型衝突 |

---

## 4. 型別安全標準

| 規則 | 指令 |
|---|---|
| 禁止 `as any`（Drizzle 動態欄位除外，需 eslint-disable） | [MUST] |
| 偏好窄化介面，使用 `Record<string, T>` 或 `keyof typeof` | [ALWAYS] |
| `as unknown as ConcreteType` 優先於 `as any` | [ALWAYS] |
| 測試 mock 實作窄化介面，禁止 `{} as any` | [MUST] |

---

## 5. ESLint 執行層

模式：code review 發現問題 -> 鎖定 ESLint 規則 -> architecture guard 測試驗證。[NEVER] 只添加沒有 WRONG/RIGHT 示例的規則。

| 規則類型 | 用途 | 級別 |
|---|---|---|
| `no-restricted-imports` | 控制來源 import（如禁止直接 `cloudflare:workers`） | error |
| `no-restricted-syntax` | 禁止原始 SQL (`db.execute()`) | warn |
| `@typescript-eslint/no-explicit-any` | 類型安全 | error |
| `local/require-*` | 業務邏輯守衛（auth, PROD 保護） | error |

---

## 6. 架構守護測試

Vitest 測試掃描源碼模式違規。每個 guard 有 `MAX_*` 常數，只能隨時間減少。

| Guard 類型 | 概念 |
|---|---|
| `MAX_AS_ANY` | `as any` 計數預算 |
| `MAX_RAW_SQL` | 原始 SQL 計數預算 |
| Import 隔離 | 禁止非 runtime.ts 的 `cloudflare:workers` import |
| i18n 一致性 | locale 文件 key 跨語言完整 |

---

## 7. i18n 規範

> **watch-dog 裁定：N/A（2026-09-04，TODO-REVIEW #3）**——單操作者內部監控工具，UI 字串硬編英
> 文、無受眾需要多語；下表為框架範本（多語內容站適用），本專案不採用。

| 規則 | 指令 |
|---|---|
| 所有使用者面對文本透過 `t('key')` | [MUST] |
| 語言列表使用 SSoT 常數（`ALL_TRANSLATION_LANGS`） | [ALWAYS] |
| locale 文件 key 跨語言完整一致 | [MUST] |
| `dangerouslySetInnerHTML` 中動態值用 `JSON.stringify()` | [MUST] |
| URL 格式：店家 `/{lang}/{country}/{city}/{industry}/{slug}` | [MUST] |

---

## 8. R2 與儲存規範

> **watch-dog：無 R2/KV binding（TODO-REVIEW #4）**——本專案僅 D1；下表 R2/KV 條目 N/A，
> 「`R2.get()` 可 null」等通用防 null 紀律保留精神適用於 D1 查詢。Drizzle 條目不適用（無 ORM，見 §3）。

| 規則 | 指令 |
|---|---|
| R2 圖像使用自定義域，禁止原始 `r2.dev` | [MUST] |
| 關鍵圖像（Above the Fold）用 Cloudflare Image Resizing | [ALWAYS] |
| R2 key 格式：`{business}/{type}/{timestamp}.{ext}` | [MUST] |
| 前端使用 R2 圖像加 `/api/images/` 前綴 | [ALWAYS] |
| KV 快取鍵含 locale 前綴：`cache:{locale}:{key}` | [MUST] |
| D1 JSON 欄位用 Drizzle `mode: 'json'` | [MUST] |
| `R2.get()` 返回可 null，必須處理 | [MUST] |
| `c.env` binding 只在請求上下文中有效 | [MUST] |

---

## 9. 元件邊界與資料隔離

> **watch-dog 適配（11-MULTI-TENANT 標註，`~/Code/rules/11-MULTI-TENANT-READINESS.md` §1.2 [MUST]）**
> 部署策略選擇 = **單一共享部署**（單一 Worker + 單一 D1，靠查詢約束隔離）。
> watch-dog 是**單操作者系統、非多租戶**：下表 Astro/Svelte/tenantId 等條目為框架範本
> （供已多租戶 Astro 棧適用），對本專案 N/A——實際的資料隔離是 **per-project scoping**：
> pulse 上報與查詢一律經 project token 解析出 `project_id` 後過濾（`timingSafeEqual`
> 防時序攻擊，見 `src/routes/api.ts`），admin 採單操作者 Basic Auth。多租戶感知升級時
> 改遵循 `PLATFORM-CONTRACTS.md`（rules 11 對照表），[NEVER] 降級回 rules 11 底線。

| 邏輯類型 | 位置（watch-dog 真實邊界） |
|---|---|
| DB 查詢 + 商業邏輯 | `src/services/`（logic/settings/alert/maintenance）— 深模組，路由層不寫 SQL |
| HTTP 路由 / auth / 過濾 | `src/routes/`（api/admin/dashboard）+ `src/middleware/`、`src/lib/` |
| HTML 渲染 | `src/views/`（hono/html 視圖）— 無 Astro/Svelte/hydration |
| 定時偵測 | `src/cron.ts`（每分鐘 scheduled handler） |

| 資料隔離規則（watch-dog） | 指令 |
|---|---|
| pulse/查詢一律經 project token 解析 `project_id` 後過濾 | [MUST] |
| admin 走單操作者 Basic Auth（`src/middleware/adminAuth.ts`） | [MUST] |
| token 比對用 `timingSafeEqual`（防時序攻擊） | [MUST] |
| 多租戶查詢 tenantId 過濾 | N/A（非多租戶，見本節頂部標註） |

~~Hydration / BEM / Svelte scoped style 條目~~：N/A（無元件框架）；CSS 集中於 `src/views/layout.ts` 單一真源。

---

## 10. SEO 鐵三角

> **watch-dog：N/A（TODO-REVIEW #5）**——dashboard/admin 均為 noindex 監控工具，非公開內容站，
> 無 sitemap/JSON-LD 受眾；路由變更三維一致性紀律保留供未來公開頁面時啟用。

路由變更觸發三維強制一致性：**UI/Route** + **Breadcrumbs** + **SEO Artifacts**（sitemap.xml, JSON-LD）。

- [MUST] `breadcrumbs` JSON-LD 必須匹配 HTML breadcrumbs
- [MUST] 動態 schema 類型基於業務上下文
- [MUST] 數據質量可疑時剝除敏感 schema，保留基礎 schema

---

## 12. 平台已知限制

| 限制 | 解決方案 |
|---|---|
| Astro v6: `Astro.locals.runtime.env` 已移除 | 用 runtime.ts gateway |
| Astro: `Astro.redirect()` 無三參數形式 | `new Response(null, { status: 302, headers })` |
| Hono JSX: 無 React Context | Hono context 或 prop drilling |
| Drizzle 類型混淆 `astro check` | astro-db-helpers 隔離層 |
| `dangerouslySetInnerHTML` server render 時評估 | `JSON.stringify()` |
| R2 `get()` 返回可 null | 必須 null check |
| Workers 不支持 Node.js APIs | Web API 等效項 |
| `JWT_SECRET` 需 `wrangler secret put` 非 `pages secret put` | 正確 wrangler 命令 |

---

## 13. 防禦性編程

- [MUST] parse 函式先做 `typeof` 檢查，`JSON.parse` 包 try-catch
- [MUST] Union/nullable 參數用 type guards，陣列/物件訪問前檢查存在性（`?.` / `|| []`）
- [MUST] Svelte `$effect` 處理 props 為 undefined，提供默認值
- [MUST] 異步操作三態：loading / success / error
- [ALWAYS] 使用可選鏈接和空值合併 (`?.` / `??`)

---

## 14. UI 設計原則

> **watch-dog：既有 UI 為 legacy accepted（TODO-REVIEW #6）**——現存 Pico.css + custom CSS
> 不重造；新頁面遵循本節精神（避免清單照用），Tailwind 遷移另案裁決。

**避免**：圖標+圓角背景標題 / 千篇一律卡片網格 / Hero metrics 布局 / 漸層文字 / glassmorphism

**偏好**：大膽留白 / 左對齊+非對稱構圖 / 漸進式揭露 / 流暢載入動畫 / Tailwind CSS + OKLCH (WCAG AA)

---

## 15. 禁止事項

| 模式 | 嚴重性 | 替代方案 |
|---|---|---|
| 非 runtime.ts 直接 `import from 'cloudflare:workers'` | CRITICAL | 從 runtime.ts import |
| `db.execute()` 原始 SQL | HIGH | Drizzle query builder |
| 組件中硬編碼字串 | HIGH | `t('key')` |
| Node.js APIs / Express / tRPC | CRITICAL | Web API + Hono + Astro |
| 核心表物理 DELETE | HIGH | 軟刪除 `deletedAt` |
| 無 tenant 過濾器的查詢 | CRITICAL | WHERE 含 tenantId/slug |
| `as any` 無 eslint-disable | HIGH | 窄化介面或具體類型斷言 |
| 原始 `r2.dev` 域名 | MEDIUM | 自定義域名 |
| 無 null check 的 `R2.get()` | HIGH | 先檢查 null |
| 低品質 agent 執行架構決策 / 安全審計 / 程式碼審查 | HIGH | opus 等級 agent（詳見 02-BUILD-SPEC.md Section 3） |

---

## 16. 採用與擴展

> 採用模型：**copy + adjust + merge-sync**（見 `rules/CLAUDE.md` Step 2/3）。本檔是**模板**，複製進消費者後是消費者的——可依專案現實調整（§1 改真實棧、標 N/A guard、加專案規則）；框架更新用 3-way merge 帶進來，不打掉調整。

**導入新專案**：`cp -r rules/cloudflare/* your-project/`（含本檔 + 02–07 + references/）。本地拷貝是你的：調整 §1 為真實棧、標 N/A guard、加專案規則。框架更新走 merge-sync（rules/CLAUDE.md Step 3），[NEVER] 盲 cp 覆蓋（會打掉調整）。

**繼承核心（消費者 [NEVER] 改寫；cp 自 rules，框架更新經 merge-sync 帶進來）**：§4–§6 / §13–§15 的 universal prohibitions、Runtime Gateway 邊界、分層原則、guard 級別政策。
**本地可調（消費者自擁；調整後 merge-sync 保留不打掉）**：真實技術棧（§1 的範本棧只是起點）、DB schema、pages、components、config、env、專案特有 ESLint 規則。

**專案 CLAUDE.md 引用本專案本地拷貝**：
```
## Cloudflare Stack Framework
核心規則見本專案的 01-CLAUDE.md … 07-ALL-IN-ONE.md（cp 自 rules，本地可調；@07-ALL-IN-ONE.md 直接讀本地執行）
以下為本專案真實棧 + 特定擴展規則...
```

**擴展邊界**：

| 可擴展（本地調整） | 不可擴展（繼承核心） |
|---|---|
| 真實技術棧 / 業務邏輯規則 / UI 組件約定 | universal prohibitions（§4–§6、§13–§15） |
| 專案特定測試 / 環境變數 | 分層 + Runtime Gateway 邊界 |
| 自定義 ESLint 規則 | 核心強制規則級別 |

[NEVER] 重寫框架核心規則、修改 ESLint error 級別、繞過 architecture guards。

> **澄清（解除舊矛盾）**：「核心技術棧」不再是「不可擴展」——範本棧（§1）是本地可調起點，消費者宣告各自真實棧；不可擴展的是**禁令與架構不變量**，不是某一組套件版本。

---

**COMPLIANCE ACKNOWLEDGEMENT:** Bypass Detection Protocol in Section 0 is now active.
