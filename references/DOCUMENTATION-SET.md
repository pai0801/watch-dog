# DOCUMENTATION-SET — /documentation/ Core + Conditional（D26）

> 對應 `03-DOC-AND-CODE-REVIEW.md` Phase 4 與 `07-ALL-IN-ONE.md` Phase D。
> 由 **D26 guard** 驗證：5 個核心檔存在，且 `architecture.md` 以「Related Documents」索引指名每份。

## 設計原則（[MUST]）

- **小 CORE + 條件 CONDITIONAL**：CONDITIONAL 文檔 [MUST] 僅在該能力存在時產出。
- **不發明空文檔**：能力不存在時，[MUST] 在 `architecture.md` 寫一行註記，[NEVER] 產出空殼文檔。
- **記錄 IS**：所有內容反映當前程式碼現實，[NEVER] 記錄不存在的功能（03 §1）。

---

## CORE 文檔集（[MUST] 5 份）

### 1. `architecture.md` — 產品概觀 + 信任邊界

[MUST] 涵蓋欄位：

- **產品概觀 + 假設**（product overview + assumptions）：產品做什麼、隱含前提
- **技術棧**（tech stack）：Astro(SSR) / Hono / Drizzle / D1 / KV / R2 / Workers AI 等，附版本
- **端到端 auth/session/claims 流**（end-to-end flow）：token/session/claim 如何從入口流到資源
- **信任邊界**（trust boundaries）：service-role（server）vs client；哪些 code 可信
- **Known-risks 列表**：每條風險 [MUST] 標注它在程式碼何處顯現（code cite）
- **「Related Documents」索引**（[MUST]）：列出本專案所有其他文檔（含 conditional），每份一行用途

> 「Related Documents」索引由 D26 強制驗證：architecture.md [MUST] 指名其他 4 份核心 + 存在的 conditional。

### 2. `flows.md` — 負載承重流程（Anti-PRD）

[MUST] 為每條 load-bearing flow 記錄：

- **actor + precondition + success**：誰、在什麼前提下、成功時達成什麼
- **step sequence**：UI → server → data → jobs → providers → agents 的步驟序列
- **每個受保護步驟的 authz check**：哪個 claim / role / scope、哪個 resource、預期 deny case
- **trust-boundary crossings**：流程何時跨越信任邊界
- **state changes / side effects**：寫入、外部呼叫、副作用

**Anti-PRD 規則（[MUST]）：** 不觸及 permissions / data-integrity / external-side-effects / money / privacy / ops-safety 的流程 [NEVER] 寫入 flows.md。

### 3. `permissions.md` — 角色、範圍、矩陣

[MUST] 涵蓋：

- **roles / claims**：系統中所有角色與 claim 清單
- **scope 衍生處**（where scope derived）：token（前端帶）vs DB（後端查）
- **resource × operation × role 矩陣**：哪個角色對哪個 resource 的哪個 operation 被允許/拒絕
- **資料層保護分類**：哪些 table 走 row-level security（RLS / D1 query filter）vs code-enforced

### 4. `variables.md` — 環境變數盤點

[MUST] 以表格記錄，每列欄位：

| Name | used-by | scope(server/client) | source | rotation | risk |

- **無 client-side secret 確認**（[MUST]）：明確宣告沒有 secret 被打包進 client bundle
- **pre-go-live checklist**：上線前變數檢查清單（rotation、least-privilege、prod-only）

> 對應 D12 secret 暴露掃描的文件層。

### 5. `tests.md` — 由 derive-tests 產出（見 `DERIVE-TESTS-MAP.md`，D28）

[MUST] 3 個分離 section：Existing coverage / Proposed tests / Gaps。格式與 row schema 見 `references/DERIVE-TESTS-MAP.md`。

---

## CONDITIONAL 文檔（[MUST] 僅在能力存在時產出；否則 architecture.md 一行註記）

### `emails.md`（有 email 寄送能力時）

[MUST] 涵蓋：queue → processor → provider 鏈；templates + vars；retry / backoff 策略。

### `cron.md`（有 scheduled job 時）

[MUST] 涵蓋：job → schedule → function → secrets → limits → retry 清查；idempotency；internal-call auth。

### `seo.md`（Astro public/indexable routes）

[MUST] 涵蓋：preview approach；route → needs-SEO → public-data 表；metadata sanitization；bot-vs-human routing。

> Cloudflare Stack（Astro SSR）通常 [MUST] 產出 seo.md。

### `automation.md`（有 LLM / agent 能力時）

[MUST] per agent 記錄：

- **trigger + owner + auto-vs-approved**
- **exact tools/APIs allowed**（白名單）
- **steering（prompt）vs hard guardrails**（哪個是軟引導、哪個是硬限制）
- **output contract schema / validation**
- **app-owned side-effects vs agent-suggestions**（agent 可建議但不可直接執行的邊界）
- **controls**：approval gates / audit logging / rate limits / retries / kill-switch

---

## D26 驗證條件（guard）

下游 `workers/tests/guards.test.ts` 實作：

1. `/documentation/` 下 5 個核心檔（architecture / flows / permissions / variables / tests）[MUST] 存在。
2. `architecture.md` 的「Related Documents」索引 [MUST] 指名其他 4 份核心 + 任何存在的 conditional。
3. Conditional 檔不存在時，architecture.md [MUST] 有一行註記說明該能力不存在。

未通過 → D26 fail → 03 Phase 4 不過 → 07 Phase D 不過。

## D37 — [MUST] Single Source of Truth — 揮發性數值

> 對應 **D37**（**static drift detector guard**——只比對 *labeled* 揮發數字 `schema v(\d+)` / `(\d+) passed|tests` / `(\d+) routes`，非任意數字 regex，避免撞行號/port；見 `references/GUARD-TEMPLATES.md §D37`）。
> 反漂移核心：**同一個會變的數字，只准存在一處。** 寫在第二處的那一刻就是漂移的起點（306→325→331 跨 CLAUDE/architecture/variables 的教訓）。

**揮發性數值**定義：schema 版本、測試數、route/endpoint 數、預算計數器（as-any/raw-sql）等任何會隨開發變動的數字。

[MUST] 規則（優先序由上到下）：

1. **[MUST] 能衍生者優先衍生，不寫死**：
   - schema 版本 → 取自最新 migration 檔名 / D1 schema 常數。
   - 測試數 → 由 `make test` 輸出，文檔不寫「N passed」的 N。
   - route/endpoint 數 → 由路由表清單長度決定，文檔引用清單不寫計數。
   - 預算計數器 → 已由 D6/D7 guard 持有單一真相，文檔引用 guard 不寫死數字。
2. **[MUST] 無法衍生者 → 單一 canonical 行**：寫在 `CLAUDE.md`「現況」段一行。
3. **[MUST] 其他文檔引用不寫死**：`architecture.md` / `variables.md` / `tests.md` / `TODO-REVIEW.md` 等 [MUST] 寫「見 CLAUDE.md §現況」連結，[NEVER] 硬寫同一個數字。
4. **[NEVER] 為了「看起來完整」把同一數字複製到第二處**——那是結構性漂移風險。

> 03 審計 [MUST] 把本規則納入檢查（D37）：發現同一揮發數值硬寫在 ≥2 處 → 列為 `[FINDING-FAIL]`，修法是收斂到單一來源，[NEVER] 只改數字不除根。
