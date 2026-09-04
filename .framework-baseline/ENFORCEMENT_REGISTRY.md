# ENFORCEMENT_REGISTRY — Cloudflare Stack

> **強制性來源**。本登記表是「每一條 `[MUST]`/`[NEVER]`/`[ALWAYS]` 都有強制機制」的單一事實來源。
> 搭配 `04-HARDENING_PROTOCOL.md` 的 **D18 (D-META) meta-guard**，由測試自動驗證：
> 任何帶有 `[MUST]/[NEVER]/[ALWAYS]` 的 section 若未出現在本表 → D18 fail → Phase 2 不過。
>
> 設計原則：**prose `[MUST]` 會被忽略（Cycle 17 HQ-002/HQ-003 實證）；只有會 fail 的測試有強制性。**

## 三種強制類別

| Category | Rule shape | Mechanism | 範例 |
|---|---|---|---|
| `guard` | 靜態程式碼模式 | 04 的 D-class guard（regex/AST/budget），下游 instantiate | `D3` 租戶隔離、`D15` no-as-any |
| `artifact` | 流程/工作流規則 | agent [MUST] 產出的結構化檔案/block，由 guard 驗證存在與完整 | `D19` FIX-LOG、`D20` REFLECT |
| `human` | 真正的判斷 | 明確標 `[HUMAN]`，**不偽裝成可自動化**。登記表強制它被「宣告」為 human | 架構決策、商業邏輯取捨 |

> `[HUMAN]` 規則維持 `[HUMAN]` — 不刪除、不偽裝。登記表的價值在於：**強制每條規則誠實宣告自己屬於哪一類**，
> 杜絕「看起來是 [MUST] 實際無人把關」的灰區。

## Guard ID 對照表（一頁可掃索引；實作見 04）

> 詳細定義 + 已知失效模式見 `04-HARDENING_PROTOCOL.md` 各 `### D##`。本表是**單一索引**——查 D## 要求什麼、屬哪類，只看這裡。

| D## | 用途（一句話） | 類別 |
|---|---|---|
| D1 | 租戶隔離（WHERE 必含 storeId/slug） | guard |
| D2 | API 認證覆蓋（handler 必有 tenant/session 檢查） | guard (ESLint) |
| D3 | Dev 端點 PROD guard | guard (ESLint) |
| D4 | Cookie 安全（HttpOnly + Secure） | guard (ESLint) |
| D5 | Import 隔離（非閘道檔禁直接 import cloudflare:workers） | guard |
| D6 | `as any` 預算（只減不增） | guard |
| D7 | Raw SQL 預算（只減不增） | guard |
| D8 | i18n key 跨語系一致 | guard |
| D9 | 禁硬編碼字串（JSX 必過 t()） | guard |
| D10 | Migration 同步（無未套用 migration） | guard |
| D11 | CLAUDE.md 準確性（人工比對） | human |
| D12 | Secret 暴露（detect-secrets） | guard |
| D13 | per-page CJK budget | guard |
| D14 | OG endpoint parity | guard |
| D15 | no `as ...any` in `.astro` frontmatter | guard |
| D16 | 現況文檔 code-path cite 必須存在（排除歷史日誌/brace expansion） | guard |
| D17 | Fix→Lock parity（CHANGELOG 每條 fix 帶 `(locked: D##)`/`(human:)`） | guard |
| **D18** | **D-META：本登記表完整性 + section 覆蓋** | **guard (meta)** |
| D19 | FIX-LOG artifact（05 §1/§4/§5） | artifact |
| D20 | REFLECT artifact（06 §3/§4/§5） | artifact |
| D21 | THINK block artifact（tier ≥ standard，02 §1.5 / 05 §3） | artifact |
| D22 | Forbidden imports（Node.js / Express / tRPC）— 01 §15 | guard |
| D23 | No physical DELETE on core tables（軟刪除）— 01 §15 | guard |
| D24 | No raw `r2.dev` domain — 01 §15 | guard |
| D25 | `R2.get()` null-checked — 01 §15 | guard |
| D26 | Documentation coverage：/documentation/ 核心集 5 份 + 索引 | artifact |
| D27 | Intent-vs-Implementation parity（每條 rule 引 code 或登 finding） | artifact |
| D28 | Test verification map：tests.md 3 section + rule row status | artifact |
| D29 | Ship-check gate（pre-push/CI） | guard |
| D30 | Retrospective（retro + action items owner+deadline） | artifact |
| D31 | Pre-mortem（Tigers/Paper Tigers/Elephants） | artifact |
| D32 | Release-notes user-facing（CHANGELOG 使用者利益開頭） | artifact |
| D33 | Acceptance scenarios before build（tier=major，02 §1.5） | artifact |
| D34 | Anti-Phantom Enforcement Audit（guard 存在/唯一/接線，meta-meta） | guard (meta) |
| D35 | Deployment & Operations Doc（deployment.md 7 必填 section） | artifact |
| D36 | README Handover Parity（README 反映現狀，6 項靜態檢查） | guard |
| **D37** | **Volatile-number SSoT：揮發性數值只在一處（衍生優先，否則 CLAUDE.md 現況行）——見 `references/DOCUMENTATION-SET.md §5`** | **guard（static drift detector，見 references/GUARD-TEMPLATES.md §D37）** |

> **tier 分級**（決定 D21/D33/D19/D28/D29 觸發）：trivial / standard / major，門檻寫死於 `02-BUILD-SPEC.md §1.5`，對齊 `scripts/scan-projects.sh`。

## 01-CLAUDE.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §1 技術棧宣告 | human | `[HUMAN]` | 宣告式技術選擇；可檢查部分（package.json 含 astro/svelte/hono/drizzle）由 build 間接保證 |
| §2 邊緣架構原則 | guard | D5 (import-isolation) + human | 邊界守則可靜態檢查；架構決策為 human |
| §3 Drizzle ORM 強制規範 | guard | D1 (tenant), D7 (raw-sql budget) | WHERE 必含 tenant、parameterized SQL |
| §4 型別安全標準 | guard | D6 (as-any budget), D15 | `@typescript-eslint/no-explicit-any` + .astro 補洞 |
| §5 ESLint 執行層 | guard | D6, eslint config 存在 | lint gate |
| §7 i18n 規範 | guard | D8 (i18n parity), D9 (hardcoded CJK), D13 | locale key 一致、無硬編碼 |
| §8 R2 與儲存規範 | guard + human | D5 (gateway) | 透過 gateway 存取；配額為 human |
| §9 元件邊界與資料隔離 | guard | D5 (import-isolation) | cloudflare:workers 只從 gateway import |
| §10 SEO 鐵三角 | artifact + guard | D14 (OG parity), D16 (doc path) | schema/OG/sitemap |
| §13 防禦性編程 | guard + human | D1–D12 防禦矩陣 | |
| §16 採用與擴展 | guard + human | D18 (meta) | 擴展邊界（可自訂 vs 框架核心）；[NEVER] 重寫框架核心 |
| Cloudflare Stack Framework | guard | D18 (meta), D6 (eslint 層) | [NEVER] 重寫框架核心/改 ESLint error 級別/繞過 guards |

## 02-BUILD-SPEC.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §0 合規聲明 | human | `[HUMAN]` | 流程宣告 |
| §1 經驗查詢 + THINK Block | artifact | D21 (THINK block) + human (getkm) | getkm 呼叫無法靜態驗；THINK block 為 artifact |
| §1.5 變更分級（tier） | human | `[HUMAN]` + D21/D33 觸發依據 | tier 判定客觀（檔數/行數/critical-path，見 §1.5 表），歸類為 human；D21/D33 據此決定觸發 |
| §2 規劃階段 | artifact | D21 | plan artifact |
| §2.1 user-story + acceptance（D33） | artifact | **D33** | tier=major（§1.5）先寫 story + acceptance |
| §2.2 /documentation/ 為規劃輸入 | artifact | D26 (documentation set) | 規劃讀 documentation 邊界 |
| §2.3 模組形狀設計檢查（14 號檔接線） | artifact + human | BUILD-PLAN 註記 + `[HUMAN]`（複本盤點） | 對照 `~/Code/rules/14-DESIGN-PRINCIPLES.md`（§0 兩問＋§2 四條）；死參數/分層可機械化部分接 04 guard |
| §3 執行階段 | artifact + human | D18 (meta) | agent team 協調為 human |
| §3.1 hand-trace test assertion | human | `[HUMAN]` | dispatch 前手動追蹤 test 自洽；reviewer APPROVED 非驗證 |
| §3.2 Escalation Gate | human | `[HUMAN]` | 升級前先查框架；已規定範式套用、不重開多選題；process violation 記 dev-brain；D18 登記 human |
| §4 驗證階段 | guard | build/lint/test gates（即 Phase 2 Step 1–4） | 驗證四重奏本身是 enforcement |
| §4a README/deployment 同步觸發（D35/D36） | artifact + guard | **D35**, **D36** | 改 script/env/端點/棧/deploy 目標 → [MUST] 同步 README + deployment.md |
| §5 自審清單 | artifact | D20 (REFLECT) | 自審產出 REFLECT |
| §5.5 Ship-Check Gate（D29） | guard | **D29** | merge main 前 ship-check |
| §6 提交流程 | guard | pre-commit/pre-push hooks（`ENGINEERING_GUIDE` §7）+ D29 | `--no-verify` 由 hook 擋；ship-check gate |
| §7 失敗處理 | human | `[HUMAN]` | 判斷何時 STOP |
| §8 禁止事項 | guard | pre-commit hooks + D17 | `--no-verify`/force-push 禁止 |

## 03-DOC-AND-CODE-REVIEW.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §0 強制合規 | human | `[HUMAN]` | 流程宣告 |
| §1 目的 | human | `[HUMAN]` | priority 宣告 |
| §2 架構快照（含 trust boundaries + authz） | artifact | D16 (path accuracy) + D26 (documentation set) | 產出反映現實；饋入 flows.md/permissions.md |
| §3 文檔準確性 | guard | D16 | 引用路徑必須存在 |
| §4a 模式覆蓋分析 | artifact + human | D18 (meta) | 判斷覆蓋為 human |
| §4b Intent-vs-Implemented parity（D27） | artifact | **D27** | documented rule ↔ code parity |
| §5 產出 /documentation/ 核心集 | artifact | **D26** + TODO-REVIEW.md | document-app 方法 |
| §5a 核心集 5 份（D26） | artifact | **D26** | architecture/flows/permissions/variables/tests |
| §5b tests.md via derive-tests（D28） | artifact | **D28** | 3 section + status |
| §5c 條件文檔 | artifact | D26 | 僅在能力存在時 |
| §5d TODO-REVIEW.md | artifact | TODO-REVIEW.md 產出 | 既有產出 |
| §5e deployment.md（D35） | artifact | **D35** | 記錄部署/維運現狀，交接用 |
| §6 TODO-REVIEW 模板 | artifact | TODO-REVIEW.md 存在 | |
| §7 審查週期 | human | `[HUMAN]` | 排程 |
| Compliance Check | guard | D16 + D18 + D26 + D27 + D28 + **D35** + **D37** | 含新 guard 檢查項；D37：審計揮發性數值 SSoT（見 DOCUMENTATION-SET §5） |

## 04-HARDENING_PROTOCOL.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §0 強制合規聲明 | guard | pre-commit hooks | `--no-verify`/force 禁止 |
| §1 核心原則 | guard | D17 (fix→lock), D18 (meta) | patterns→locked→verified |
| §1.5 Pre-Mortem（D31） | artifact | **D31** | release/harden 前置 Tigers/Paper Tigers/Elephants |
| §2 Step 0 跨專案防禦模式發現 | human | `[HUMAN]` (getkm) + D18 (meta) | API 呼叫無法靜態驗 |
| §2 Step 2 防禦掃描矩陣 | guard | D1–D12 矩陣 | 每次必掃 |
| §3 Phase 2 驗證 | guard | build/lint/test + **D17 (Step 5)** + D18 (guard 有效性) | 五步驟；guard 不鏽蝕 |
| §3 Guard 有效性驗證 | guard | D18 (meta), D34 (anti-phantom) | guard regex/fixture/budget/disable 數量逐項驗證 |
| §4 Phase 3 文檔同步 | guard | **D16** (path), **D17** (lock-tag, §4a1), D18 | |
| §4.c CLAUDE.md 準確性驗證清單 | guard | **D16** (path), D18 | 禁止規則/模組路徑/版本/已知限制逐項驗證 |
| §4.a CHANGELOG 格式（D32） | artifact | **D32** | release-notes user-facing |
| §4.a1 Fix→Lock 標籤 | guard | **D17** | 強制性核心 |
| §4.b 更新規則 | artifact | D16 (path accuracy) | 文檔同步規則 |
| §5 Phase 4 總結報告 | artifact | report 產出（含 D1–D36 結果） | |
| §5.5 防禦模式共享 | human | `[HUMAN]` (putkm) | API 呼叫無法靜態驗 |
| §6 STOP 條件 | human | `[HUMAN]` | 判斷 |
| §7 最終檢查清單 | guard | D18 (meta, item 10) | 10 項含 D17 |
| §8.i Budget 追蹤表 | guard | D6/D7 budgets | 預算只減不增 |
| §8.5 Meta & Artifact Guards | guard/artifact | D16,D18,D19,D20,D21,D34 | meta + artifact + doc-drift + anti-phantom guards 區塊 |
| §8.5 D16 現況文檔 code-path drift | guard | **D16** | 全文檔範圍路徑存在（升級） |
| §8.5 D18 Registry 完整性 meta-guard | guard (meta) | **D18** | 本登記表覆蓋驗證 |
| §8.5 D19 FIX-LOG artifact guard | artifact | **D19** | FIX-LOG 四欄位 |
| §8.5 D20 REFLECT artifact guard | artifact | **D20** | REFLECT R1–R5 |
| §8.5 D21 THINK block artifact guard | artifact | **D21** | 非平凡變更 THINK |
| §8.5 D34 Anti-Phantom Enforcement Audit | guard (meta) | **D34** | guard existence/collision/wiring 四驗 |
| §8.5 D38 Non-vacuous guard proof | guard (meta) | **D38** | guard test [MUST] NON-VACUOUS + NEGATIVE marker(證非 vacuous) |
| §8.6 D25 R2.get null-check | guard | **D25** | 01 §15 gap guard |
| §8.7 PM/Doc Artifact Guards（D26–D33） | artifact/guard | D26–D33 | 整合 PM skill 區塊 |
| §8.7 D26 Documentation coverage | artifact | **D26** | /documentation/ 核心集 |
| §8.7 D27 Intent-vs-Implementation parity | artifact | **D27** | documented rule ↔ code |
| §8.7 D28 Test verification map | artifact | **D28** | tests.md 3 section |
| §8.7 D29 Ship-check gate | guard | **D29** | pre-push/CI ship-check |
| §8.7 D30 Retrospective | artifact | **D30** (augments D20) | retro + action items |
| §8.7 D31 Pre-mortem | artifact | **D31** | Tigers/Paper Tigers/Elephants |
| §8.7 D32 Release-notes user-facing | artifact | **D32** | CHANGELOG user benefit |
| §8.7 D33 Acceptance scenarios before build | artifact | **D33** | user-story + acceptance |
| §8.8 Handover & Deployment Guards | artifact/guard | **D35**, **D36** | D35 deployment.md + D36 README parity |
| §8.8 D35 Deployment & Operations Doc | artifact | **D35** | deployment.md 7 必填 section |
| §8.8 D36 README Handover Parity | guard | **D36** | README 6 項靜態檢查 |
| §9 Human Queue 管理 | artifact | TODO-REVIEW.md | |
| Guard Index（D1–D39） | guard | D18 (meta) | 全 guard 速查表 |

## 05-FIX-SPEC.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §0 合規前言 | human | `[HUMAN]` | 流程宣告；[NEVER] 因「小改」跳過流程 |
| §1 目標記錄 | artifact | **D19 (FIX-LOG)** | FIX-PLAN 四欄位 |
| §2 經驗查詢 getkm | human | `[HUMAN]` | API 呼叫 |
| §3 THINK Block | artifact | D21 | 非平凡 fix |
| §3.5 執行分支（cleanup four-pass） | artifact + human | D18 (meta) + [HUMAN] + D19 (FIX-LOG 清理計畫) | cleanup 走分類表+four-pass；bugfix 直接修復；紀律（行為鎖定/刪除優先/範圍閉鎖）由 §4 gates + D19 承載 |
| §3.5 清理型紀律（行為鎖定/刪除優先/範圍閉鎖） | human + artifact | [HUMAN] + D19（FIX-LOG 清理計畫）+ §4 gates | 動手前補回歸測試；刪除優先於新增；只動 §1 範圍；爆破 >10 檔 STOP |
| §3.5 Slop 分類表 | human | [HUMAN] + D19 | 動手前逐項標記 smell（重複/死碼/過度抽象/邊界違規/測試缺口）；Missing test Pass 0 先補 |
| §3.5 Four-pass 執行順序 | human + artifact | [HUMAN] + §4 gates + D19 | Pass 0→4 由安全到風險；每 pass 後重跑 §4；任一 fail STOP 回退 |
| §4 修復與驗證 | guard | Phase 2 五步驟（含 D17） | 驗證四重奏 |
| §5 自審清單 | artifact | D20 (REFLECT) | |
| §6 經驗記錄 putkm | human | `[HUMAN]` | API 呼叫 |
| §7 失敗處理 | human | `[HUMAN]` | |
| 禁止事項 | guard | D17 + pre-commit | 跳流程禁止 |

## 06-REFLECT.md

| Section | Category | Enforcement | 說明 |
|---|---|---|---|
| §0 Purpose | human | `[HUMAN]` | |
| §1 Trigger Points | artifact | D20 (REFLECT 觸發) | 每觸發點產 REFLECT |
| §2 Experience Search | human | `[HUMAN]` (getkm) | |
| §3 Quick Check | artifact | **D20 (REFLECT R1–R5)** | |
| §3 R1 [MUST] Directives | artifact | D20 (R1) | [MUST] 違反檢查 |
| §3 R2 [NEVER] Directives | artifact | D20 (R2) | [NEVER] 違反 = critical |
| §3 R5 Experience Recording | human | `[HUMAN]` (putkm) + D20 (R5) | 經驗記錄 |
| §3 R6 Retro block（D30） | artifact | **D30** | retro format + action items |
| §4 Full Audit | artifact | **D20 (REFLECT F1+)** | |
| §4 F1 Constitution Compliance | artifact | D20 (F1) | 01 合規 |
| §5 Corrective Action | artifact | D20 + TODO-REVIEW | 矯正行動產出 |
| §5 Action Template | artifact | D20 (違規模板) | 違規紀錄格式 |
| §6 Compliance Summary（報告段） | artifact | D20 (REFLECT 產出) | 報告 summary 段 |
| §6 Retro（D30 報告段） | artifact | **D30** | 報告內 Retro 段 |
| §7 Cross-Project Learning | human | `[HUMAN]` (putkm) | |
| §8 Anti-Patterns | human | `[HUMAN]` | 行為判斷 |

## 07-ALL-IN-ONE.md

> 07 是 orchestrator(編排順序與產出),**刻意不在 D18 掃描範圍**(見下方 D18 規則 §1)。
> 本 section 僅為**人類可讀的 Phase→強制對照**,讓 07 引入的 Phase E/F(08/09)有登記、不孤兒。

| Phase | Category | Enforcement | 說明 |
|---|---|---|---|
| Phase A 記錄現狀 | artifact | 03 的 D26/D27/D16 | 執行 03,繼承其 enforcement |
| Phase B 完善程式碼 | artifact | 02 的 D21/D33 + 05 §3.5 deslop | 執行 02/05,繼承 |
| Phase C 加固 | guard | 04 的 D1–D37 + Fix→Lock(D17) | 執行 04,繼承 |
| Phase D 驗收+文檔收斂 | guard + artifact | 驗證四重奏 + **D29**(ship-check)+ **D35**(deployment)+ **D36**(README parity) | build/lint/test gates |
| **Phase E ops-manual(conditional)** | artifact | **08-OPS-MANUAL-FRAMEWORK** §6 body-cite(`check-cites.sh`) | 蒸餾進 docs-hub;有 ops impact 才做 |
| **Phase F portability gate** | guard | **09-PROJECT-PORTABILITY** 三 guard(secret-not-in-vars / raw-SQL / manifest 存在性,模板 `references/PORTABILITY-GUARDS.md`)+ fresh-clone smoke | 可發布/可搬移閘門;[NEVER] 跳過;失敗 [NEVER] 宣告可發布 |

> Phase E/F 的 guard 由消費者專案 instantiate 進 `workers/tests/guards.test.ts`(09 §3 採用流程)。
> 08/09 本身是跨 stack SSoT,**不隨 stack 複製進消費者**——消費者透過 07 的 Phase E/F 引用 rules repo 的 08/09。

---

## D18 (D-META) 驗證規則

D18 guard（下游 `workers/tests/guards.test.ts`）讀取本檔 + 01–06，驗證：

1. **Section 覆蓋**：01–06 中每個含 `[MUST]/[NEVER]/[ALWAYS]` 的 section heading，[MUST] 出現於本表對應 doc 的 Section 欄。（07-ALL-IN-ONE 不在掃描範圍內。）
2. **Guard 存在**：本表 Enforcement 欄的每個 `D##`，對應 04 內已定義的 guard（template 或 section）。
3. **Artifact 完整**：每個 `artifact` 類別指向一個已定義 artifact（FIX-LOG/REFLECT/THINK/documentation-set/tests-map/retro/pre-mortem/release-notes/acceptance/deployment-doc）+ 其 validator guard（D19/D20/D21/D26/D27/D28/D30/D31/D32/D33/**D35**/**D37**）。D37 為 static drift detector **guard**（見 `references/GUARD-TEMPLATES.md §D37`），下游 [MUST] instantiate 測試。
4. **Human 誠實**：`human` 類別必須帶 `[HUMAN]` 標記，不可與 `guard`/`artifact` 混標。

未通過任一項 → Phase 2 fail → [NEVER] 宣告 COMPLETE。

## 下游 instantiate 指引

1. 複製本檔到專案根。
2. 在 `workers/tests/guards.test.ts` 實作 D1–D36（04 的模板 + 本表指明的 guard）+ **D37**（D37 為 static drift detector guard，模板見 `references/GUARD-TEMPLATES.md §D37`，下游 [MUST] instantiate）。
3. D18 即讀本檔 + 01–06 做覆蓋檢查；新增任何 `[MUST]` 必須同步登記，否則 D18 fail。若同 doc 標題下放多個子表格，count-logic 會失準——改用「存在性 + 雙向 D##」變體（見 04 §8.5 D18 已知限制）。
4. artifact 類（D19/D20/D21）：在專案約定位置維護 `FIX-LOG.md` / `REFLECT.md` / THINK block。
5. PM artifact 類（D26–D33）：維護 `/documentation/` 核心集、retro/pre-mortem artifact、CHANGELOG user-facing 格式、BUILD-PLAN user-story。模板見 `references/DOCUMENTATION-SET.md`、`INTENT-PARITY-CHECKLIST.md`、`DERIVE-TESTS-MAP.md`、`RETRO-PRE-MORTEM-TEMPLATES.md`。
