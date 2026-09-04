# 文檔與代碼審查流程 — Audit & Record Process

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。

> 核心原則：本流程目的非找 bug，而是記錄專案當前狀態（流程、規格、架構）。文檔準確性透過對比代碼現實驗證，發現問題產生 TODO-REVIEW.md。

---

## Section 0 — 強制合規

[MUST] 本文件具強制約束力，所有 AI 代理必須遵循。
[ALWAYS] 每次 AI 會話開始時自動觸發（記憶刷新機制）。
[MUST] 記錄即 truth — 記錄內容即為當前專案現實，非理想狀態。
[MUST] 執行審計的 agent 必須使用高品質模型（≥ sonnet），架構決策與安全相關發現 ≥ opus。

---

## Section 1 — 目的（Priority Order）

| 優先級 | 目的 | 說明 |
|--------|------|------|
| PRIMARY | 記錄現狀 | 記錄實際資料流、API 端點、模組依賴、結構體模式 |
| SECONDARY | 驗證文檔 | 比對 CLAUDE.md 規則、模組引用、架構描述是否過時 |
| TERTIARY | 識別缺口 | 找出未記錄的流程、缺少測試的模式、需加固的守護 |

核心原則：
- [ALWAYS] 記錄的是 IS，不是 SHOULD BE
- [MUST] 每個模組、資料流、API 端點都應被記錄
- 輸出到 02-BUILD-SPEC.md（待修復）、04-HARDENING_PROTOCOL.md（待鎖定）、01-CLAUDE.md（新規則）

---

## Section 2 — Phase 1: 架構快照（Architecture Snapshot）

- [MUST] **目錄結構審計** — 用 `tree`/`find` 映射目錄樹，識別職責目錄、標記孤立檔案、檢查 SSoT 目錄
- [MUST] **模組清點** — 列出重要模組（path、responsibility、SSoT、depends on），建模組依賴圖
- [MUST] **資料流記錄** — 記錄資料流入（API/webhooks/scheduled）、存儲（D1/KV/R2）、檢索（query patterns/cache）、錯誤處理路徑
- [MUST] **Schema 記錄** — 記錄 D1 table schemas（Drizzle）、KV key patterns、R2 bucket organization
- [MUST] 標記同步/非同步操作及緩存策略實際實現
- [MUST] **信任邊界 + authz 流捕獲** — 記錄 trust boundaries（service-role vs client）與 load-bearing authz flow（每個受保護步驟的 claim/role/scope + resource + 預期 deny case），饋入 `/documentation/flows.md` 與 `/documentation/permissions.md`（見 `references/DOCUMENTATION-SET.md`，D26）

---

## Section 3 — Phase 2: 文檔準確性（Documentation Accuracy）

- [MUST] **CLAUDE.md 驗證** — 逐條檢查規則遵循、禁止違規、模組引用存在性、版本注意事項時效
- [MUST] **API 端點清點** — 列出所有路由，驗證 auth/tenant isolation/PROD guard（method、path、auth、status）
- [MUST] **測試覆蓋評估** — 統計測試檔案及數量、識別未測試模組、驗證架構守護完整性
- 驗證方法：Grep 查違規、Glob 驗檔案存在、查 import 路徑規範、查測試覆蓋率

---

## Section 4 — Phase 3: 模式覆蓋分析 + 意圖-實作 parity（D27）

### 4a — [MUST] 模式覆蓋分析

- [MUST] **ESLint 規則覆蓋** — 列出已鎖定規則，對照已知錯誤模式檢查覆蓋率，識別缺失規則
- [MUST] **架構守護完整性** — 列出守護測試，對照已知 bug 模式檢查覆蓋率，識別缺失守護
- **加固建議分級**：
  - 高：[NEVER] API 端點直接返回錯誤對象、[MUST] 錯誤處理不洩漏敏感信息
  - 中：檢測重複 import、驗證 rate limiting
  - 低：未使用變數提升為 error、緩存 key 唯一性

### 4b — [MUST] Intended-vs-Implemented parity check（D27）

[MUST] 對 `/documentation/permissions.md` 與 `/documentation/flows.md` 每條 rule 跑 parity check（完整方法見 `references/INTENT-PARITY-CHECKLIST.md`）：

- [MUST] 把每條 documented rule 視為待驗 claim，[MUST] 找到 code enforcement cite（`file:line`）
- [NEVER] 接受「handled upstream」/「internal only」/「admin only」/「validated elsewhere」為證據 — [MUST] 往上追到實際 check
- [MUST] 每條 finding 含 4 欄：documented intent（quote）+ implemented reality（cite）+ attacker & victim + concrete fix
- [NEVER] 捏造意圖；文檔沒寫就標 missing-doc finding
- [MUST] findings 寫入 TODO-REVIEW.md，缺 guard 的饋入 04 §2

> 由 **D27 guard** 驗證：[NEVER] 有 documented rule 靜默未被驗證。每條 rule [MUST] 有 code cite 或 honest finding。

---

## Section 5 — Phase 4: 產出 /documentation/ 核心集（D26）+ tests.md（D28）

[MUST] 以 document-app 方法產出 `/documentation/` 核心集（5 份）+ 條件文檔，取代 ad-hoc 文檔生成。完整欄位見 `references/DOCUMENTATION-SET.md`。

### 5a — [MUST] 核心集（5 份，D26）

- [MUST] **`/documentation/architecture.md`** — 產品概觀+假設 / 技術棧 / 端到端 auth/session/claims 流 / 信任邊界 / Known-risks（每條 backed by code cite）/ 「Related Documents」索引
- [MUST] **`/documentation/flows.md`** — 每條 load-bearing flow（actor+precondition+success / step sequence / 每步 authz check / trust-boundary crossings / state changes）。Anti-PRD：不觸及 permissions/data-integrity/side-effects/money/privacy/ops-safety 的 flow [NEVER] 寫入
- [MUST] **`/documentation/permissions.md`** — roles/claims / scope 衍生處（token vs DB）/ resource×operation×role 矩陣 / RLS vs code-enforced 分類
- [MUST] **`/documentation/variables.md`** — Name·used-by·scope(server/client)·source·rotation·risk 表 + 無 client-side secret 確認 + pre-go-live checklist
- [MUST] **`/documentation/tests.md`** — 由 derive-tests 產出（見 5b）

### 5b — [MUST] tests.md via derive-tests（D28）

[MUST] tests.md 含 3 個分離 section，完整格式與 row schema 見 `references/DERIVE-TESTS-MAP.md`：

- **Existing coverage**（repo 今天的測試，每個綁 rule）
- **Proposed tests**（待寫，標 type：automated unit/integration · guarded live · manual review）
- **Gaps**（documented rule 但無驗證，按 exposure 排序）

row schema：`use-case → rule → expected(含 deny case) → evidence(doc+code) → status(existing/proposed/none)`。[MUST] 標 CI-gating。

### 5c — [MUST] 條件文檔（僅在能力存在時；否則 architecture.md 一行註記）

- `emails.md`（有 email 寄送）/ `cron.md`（有 scheduled job）/ `seo.md`（Astro public/indexable routes，Cloudflare Stack 通常 [MUST] 產出）/ `automation.md`（有 LLM/agent）

### 5d — [MUST] TODO-REVIEW.md（既有產出保留）

- [MUST] 產出 `TODO-REVIEW.md` — 模板見 `references/TODO-REVIEW-TEMPLATE.md`
  - 問題分類：BUG / TECH_DEBT / MISSING_TEST / MISSING_DOC / HARDEN
  - 按風險和頻率優先級排序，包含上下文和建議
- [MUST] **加固建議饋入 04-HARDENING_PROTOCOL.md** — 模式、風險、WRONG/RIGHT 範例、rule/guard 建議

### 5e — [MUST] deployment.md（D35 — 交接核心）

- [MUST] 產出 `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`）反映**現狀部署/維運** — 模板見 `references/DEPLOYMENT-TEMPLATE.md`
  - [MUST] 含 7 必填 section：環境矩陣 / 部署指令 / Secrets 與變數 / Migration 順序 / 回滾程序 / 部署後驗證 / 維運 Runbook
  - [MUST] Phase A 架構快照的部署事實（綁定、env、migration、回滾）饋入本檔
  - [NEVER] 記錄不存在的部署步驟（D16 code-path cite 雙重保證）

---

## Section 6 — TODO-REVIEW.md 模板

[MUST] 使用 `references/TODO-REVIEW-TEMPLATE.md` 產出待辦清單，包含：
- Critical / High / Medium 三級分類表格
- Architecture Snapshot Changes（新增/變更/移除模組、資料流變更）
- Hardening Suggestions（ESLint rule candidates、Architecture guard candidates）
- Statistics（總項目數、各級數量、已解決數、重複模式數）

---

## Section 7 — 審查週期

| 觸發時機 | 類型 |
|----------|------|
| 每次 AI 會話開始 | [MUST] 強制 |
| 主要功能新增後 | [MUST] 強制 |
| 加固週期完成後 | [MUST] 強制 |
| 主要發布前 | 建議 |
| 新成員加入時 | 建議 |
| 活躍專案每週 | 建議 |

| 審查範圍 | 預估時長 |
|----------|----------|
| Phase 1 快速快照 | 15-30 min |
| Phase 2 文檔準確性 | 30-60 min |
| Phase 3 模式覆蓋 | 30-45 min |
| Phase 4 產出生成 | 15-30 min |
| 完整審查（全部） | 2-4 hr |

---

## Section 8 — 流程整合

```
01-CLAUDE.md ──(rules/limits)──> 03-DOC-AND-CODE-REVIEW.md ──(TODO-REVIEW.md)──> 02-BUILD-SPEC.md
        ^                                |                                      |
        └────(new rules/limits)──────────┘                                      |
        └────(hardening patterns)─────> 04-HARDENING_PROTOCOL.md <──────────────┘
```

輸入：01-CLAUDE.md（規則集、限制、模組職責）、02-BUILD-SPEC.md（已解決 TODO、新需求）
輸出：01-CLAUDE.md（新規則）、02-BUILD-SPEC.md（TODO-REVIEW.md、缺口列表）、04-HARDENING_PROTOCOL.md（加固建議）

---

## Compliance Check

- [ ] [MUST] 所有階段已完成
- [ ] [MUST] `/documentation/` 核心集 5 份就位（D26），architecture.md 含 Related Documents 索引
- [ ] [MUST] `/documentation/deployment.md` 就位且含 7 必填 section（D35）
- [ ] [MUST] `/documentation/tests.md` 含 3 分離 section + 每條 rule 帶 status（D28）
- [ ] [MUST] Phase 3 parity check 完成，每條 documented rule 有 code cite 或 finding（D27）
- [ ] [MUST] TODO-REVIEW.md 已產出（依 `references/TODO-REVIEW-TEMPLATE.md`）
- [ ] [MUST] 相關文檔已更新
- [ ] [MUST] 加固建議已饋入 04-HARDENING_PROTOCOL.md

> [ALWAYS] 本流程是專案的記憶刷新機制。每個 AI 會話都應從此開始，確保連續性和準確性。
