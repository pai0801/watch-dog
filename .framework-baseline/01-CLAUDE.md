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

| 技術 | 技術棧 | 版本 |
|---|---|---|
| Runtime | Cloudflare Workers / Pages | 最新 wrangler |
| Framework | Astro 6 (SSR) + Hono 4 (routing/middleware) + Svelte 5 (UI, runes only) | package.json engines |
| ORM | Drizzle (SQLite dialect, D1) | ^0.30.0 |
| Storage | D1 (關聯) + KV (快取/session) + R2 (物件/圖片) | Cloudflare 平台 |
| Testing | Vitest + @cloudflare/vitest-pool-workers | Vitest 2.x |
| Linting | ESLint 9 (flat config) + custom rules | flat config |

[MUST] 寫任何程式碼前先檢查 `package.json` 的版本釘選。

---

## 2. 邊緣架構原則

**Hono -> Astro 單一 Worker 連鎖**：Hono middleware 處理 rate limiting / tenant blocking / security filtering；未攔截的請求 `next()` 傳給 Astro SSR。

| 規則 | 指令 |
|---|---|
| Response 修改用 service wrapper，不用 `app.use('*')` | [MUST] `withSmartCache(c, () => handler)` |
| 只有 `src/lib/runtime.ts` 可 `import from 'cloudflare:workers'` | [NEVER] 其他文件直接 import |
| 禁止 Node.js APIs (fs, path, crypto) | [NEVER] 使用 Web API 等效項 |
| 禁止 Express / tRPC | [NEVER] 使用 Hono + Astro |

---

## 3. Drizzle ORM 強制規範

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

| 規則 | 指令 |
|---|---|
| 所有使用者面對文本透過 `t('key')` | [MUST] |
| 語言列表使用 SSoT 常數（`ALL_TRANSLATION_LANGS`） | [ALWAYS] |
| locale 文件 key 跨語言完整一致 | [MUST] |
| `dangerouslySetInnerHTML` 中動態值用 `JSON.stringify()` | [MUST] |
| URL 格式：店家 `/{lang}/{country}/{city}/{industry}/{slug}` | [MUST] |

---

## 8. R2 與儲存規範

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

| 邏輯類型 | 位置 |
|---|---|
| DB 查詢 | Astro frontscript (`---` 區塊) |
| 使用者互動 / 即時狀態 | Svelte components ($state, $derived) |
| 靜態數據渲染 | Astro template |

| 資料隔離規則 | 指令 |
|---|---|
| 多租戶查詢 WHERE 必須含 tenantId/slug 過濾器 | [MUST] |
| 核心實體用 `deletedAt` 軟刪除，禁止物理 DELETE | [MUST] |
| D1 事務 < 5ms，事務中禁止 SELECT | [MUST] |
| 行業特定數據存 JSON metadata 欄位，不擴展主 schema | [MUST] |
| 暴露記錄用前綴 ID（`str_`/`itm_`/`ord_`）+ nanoid | [MUST] |
| 資料驗證失敗返回 `null`，不渲染空容器 | [MUST] |

Hydration：Admin `client:load` / Below-fold `client:visible` / SEO 關鍵內容不 hydrate。
CSS：Admin 元件 [MUST] import CSS 檔，[NEVER] 依賴 Svelte scoped `<style>`，用 BEM 命名。
詳細模式見 `references/COMPONENT_PATTERNS.md`。

---

## 10. SEO 鐵三角

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

> **澄清（解除舊矛盾）**：「核心技術棧」不再是「不可擴展」——範本棧（§1）是本地可調起點，消費者宣告各自真實棧；不可擴展的是**禁令與架構不變量**，不是某一組套件版本。

[NEVER] 重寫框架核心規則、修改 ESLint error 級別、繞過 architecture guards。

---

**COMPLIANCE ACKNOWLEDGEMENT:** Bypass Detection Protocol in Section 0 is now active.
