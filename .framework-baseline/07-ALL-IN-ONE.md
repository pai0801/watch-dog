# 07-ALL-IN-ONE — 一鍵加固 + 完善程式碼 + 產出/更新文檔（Cloudflare Stack）

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。
> 本文件是** orchestrator**：執行一次即依序跑完 03（審計/記錄）→ 02（完善程式碼與註解）→ 04（加固）→ 03（文檔收斂）→ **08（人類操作手冊，Phase E）→ 09（可重建 + 反鎖死閘門，Phase F）**。11（多租戶就緒底線）在 Phase A 架構快照時自查。
> [MUST] 各 Phase 引用對應主文檔的完整規則，本文件只定義**編排順序與產出**，[NEVER] 重複抄錄細節。

---

## 0 — [MUST] 合規聲明

> 執行本文件 = 對專案做一次完整的「記錄→完善→加固→收斂文檔」收束。
> [MUST] 嚴格依 Phase A→B→C→D→E→F 順序（E 為 conditional：無 ops impact 可註記跳過；F 為可發布/可搬移閘門，[NEVER] 跳過），[NEVER] 並行、[NEVER] 顛倒。
> [MUST] 執行 agent ≥ sonnet；涉及架構決策、安全審計、錯誤分類 ≥ opus（見 `02-BUILD-SPEC.md` §3）。
> [NEVER] 用 `--no-verify`、[NEVER] 提交 secrets（見 `01-CLAUDE.md` §0、`04-HARDENING_PROTOCOL.md` §0）。

---

## 1 — 觸發時機與產出

| 觸發 | 類型 |
|---|---|
| 「跑一次完整收斂」「all-in-one」「07」「全量加固+補文檔」 | [MUST] 執行本文件 |
| 主要功能新增後、發布前、每週活躍專案保養 | [MUST] 執行 |

**[MUST] 產出清單（本文件保證全部就位才完成）：**
- 更新後的 `README.md`（架構 + 安裝/build/test + 環境變數 + guard 概覽）— [MUST] 通過 **D36 README Handover Parity**
- `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`）— [MUST] 通過 **D35 Deployment & Operations Doc**（7 必填 section，見 `references/DEPLOYMENT-TEMPLATE.md`）
- 系統/技術文檔（`docs/ARCHITECTURE.md` 或既有 module reference）反映**現狀**
- `TODO-REVIEW.md`（依 `references/TODO-REVIEW-TEMPLATE.md`）
- `CHANGELOG.md` 今日 cycle（含 Fix→Lock tag，見 04 §4.a1）
- 加固後的原始碼（D1–D25 全 PASS、ESLint/Vitest/Build 全綠）
- `putkm` 經驗記錄（04 §5.5 / 02 §5）
- **ops manual（08，Phase E，conditional）**：`docs-hub` 人類操作/部署/維運手冊頁（走 `08-OPS-MANUAL-FRAMEWORK.md` §3 原型 + §4 frontmatter；無 ops impact 則註記跳過）
- **manifest + portability-check（09，Phase F）**：`.portability.toml`（五段完整）+ portability guard 三項（secret-not-in-vars / raw-SQL / manifest 存在性）PASS + fresh-clone smoke 過（走 `09-PROJECT-PORTABILITY.md` §1.1/§5，模板 `references/PORTABILITY-GUARDS.md`）；**若用 secret：同 Phase F 跑 10 §F–§J（見 Phase F 步驟 5）**

---

## 2 — Phase A: 記錄現狀 + 文檔診斷（執行 `03-DOC-AND-CODE-REVIEW.md`）

> [MUST] 先記錄 IS，再決定改什麼。[NEVER] 在沒有現狀快照前動程式碼。

[MUST] 完整執行 03 的 Phase 1–4：
- [MUST] **架構快照**（03 §2）：Hono→Astro 連鎖、Drizzle/D1/KV/R2、模組依賴圖、SSoT 目錄、**信任邊界 + authz 流**（饋入 `/documentation/flows.md` + `permissions.md`）
- [MUST] **文檔準確性**（03 §3）：逐條比對 `01-CLAUDE.md` 規則、API 端點 auth/tenant、測試覆蓋
- [MUST] **模式覆蓋 + intent-vs-implemented parity**（03 §4）：ESLint/guard 覆蓋缺口 + **D27 parity check**（每條 documented rule 有 code cite 或 finding）
- [MUST] **產出 `/documentation/` 核心集 5 份**（03 §5 / D26）：architecture / flows / permissions / variables / tests（後者由 derive-tests 產出，D28）
- [MUST] 產出 `TODO-REVIEW.md`，問題分 BUG / TECH_DEBT / MISSING_TEST / MISSING_DOC / HARDEN，分 Critical/High/Medium
- [MUST] **剪枝掃描（PRUNE）**：每個 cycle 掃「retired-but-present」表面——dead routes / env / modules / 測試、reverted features、guard 重複、舊資料的 stale config；每項標 **safe-to-prune** vs **defer-with-trigger**（附觸發條件，如「DROP after all cards seeded」）。safe-to-prune 走 05 §3.5 Pass 1 連同其測試一起刪；defer 項登錄 TODO-REVIEW。（getkm 7ef20e642174）

[MUST] 把 TODO-REVIEW 的 MISSING_DOC + TECH_DEBT 分支匯入 Phase B/C 的待辦清單。

> **多租戶就緒底線自查（11，Phase A conditional）**：非多租戶系統 [MUST] 照 `~/Code/rules/11-MULTI-TENANT-READINESS.md` §3 六項 checklist 逐項標 PASS/GAP；GAP 進 TODO-REVIEW。已多租戶系統遵循 `PLATFORM-CONTRACTS.md`，本條標 N/A。

---

## 3 — Phase B: 完善程式碼與註解（執行 `02-BUILD-SPEC.md` 流程）

> 針對 Phase A 找出的 TECH_DEBT / MISSING_TEST，逐項走 02 的 THINK→規劃→執行→驗證。
> **清理型 TECH_DEBT**（deslop：重複邏輯 / 死碼 / 多餘 wrapper / 邊界違規）→ [MUST] 改走 `05-FIX-SPEC.md` §3.5 的分類 + four-pass（FIX-PLAN `類型: cleanup`），[NEVER] 與新功能交付混在同一 edit set。

[MUST] 每一項非平凡變更前：
- [MUST] 呼叫 `getkm` 搜尋過往解法（02 §1）
- [MUST] 輸出 7 欄位 THINK block（`THINKING.md`），VERDICT=STOP 則 [NEVER] 寫程式碼
- [MUST] **非平凡功能先寫 user-story + acceptance test-scenarios**（02 §2.1 / D33）：3 C's + INVEST story + ≥1 acceptance criterion
- [NEVER] 把架構問題用程式碼遮蓋；遇架構問題 [MUST] STOP 回 Phase A 補規則

**完善範圍 [MUST] 限定在 Phase A 待辦清單內：**
| 工作類型 | [MUST] 動作 |
|---|---|
| 註解完善 | 補 public API / service / guard 的 JSDoc；[NEVER] 為自明程式碼加廢話註解 |
| 型別完善 | 收窄 `as any`/`as unknown`、補 `keyof typeof`/narrowed interface（01 §4） |
| i18n 完善 | 硬編碼字串改 `t('key')`、locale key 補齊（01 §7） |
| 缺測補測 | 為 MISSING_TEST 模式補 Vitest guard（含 WRONG/RIGHT，04 §8 模板） |
| 清理型 TECH_DEBT（deslop） | [MUST] 走 05 §3.5：smell 分類 → Pass0 鎖行為 → Pass1 死碼 → Pass2 重複 → Pass3 命名/錯誤處理 → Pass4 補測；每 pass 重跑 §4 驗證子集；[NEVER] 借清理新增依賴或抽象 |
| 小幅重構 | [NEVER] 越界；爆破半徑 > 10 檔 → [MUST] STOP（04 §6） |

[MUST] 每完成一項即更新 TODO-REVIEW 狀態。[NEVER] 新增裸 TODO/FIXME 掩蓋未完工作（02 §5）。

---

## 4 — Phase C: 加固（執行 `04-HARDENING_PROTOCOL.md`）

> [MUST] 執行完整防禦掃描矩陣 + Fix→Lock 配對。

[MUST] **加固 cycle 開始前先跑 pre-mortem**（04 §1.5 / D31）：Tigers / Paper Tigers / Elephants；每條 launch-blocking Tiger 含 mitigation+owner+date。

[MUST] 執行 04 §2 全程：
- [MUST] 先 `getkm` 跨專案防禦模式發現（04 §2 Step 0）
- [MUST] 逐項掃描 **D1–D25**（租戶隔離/認證/dev 保護/cookie/import/型別/SQL/i18n/硬編碼/migration/secret/§8.6 gap）
- [MUST] 每個失敗項回到 04 §2 Step 1 分類（ESLint / VITEST / HUMAN），輸出 WRONG/RIGHT + RULE
- [MUST] 新增規則寫入 `eslint.config.js`（flat config）或 `workers/tests/guards.test.ts`
- [MUST] 預算只減不增（`as any`/raw SQL/`eslint-disable`），違規 → [MUST] immediate STOP

[MUST] CHANGELOG 每條 fix bullet 攜帶 `(locked: D##)` 或 `(human: <理由>)` tag（04 §4.a1，由 D17 強制）。
[MUST] CHANGELOG 的 New/Improved/Fixed/Breaking 條目以**使用者利益**開頭（04 §4.a / D32）。

---

## 5 — Phase D: 驗證 + 文檔/README 收斂

### 5.1 — [MUST] 驗證四重奏（04 §3 / 02 §4）

[MUST] 依序執行，不可跳過，任一失敗 → [MUST] STOP 貼錯誤：

```bash
./node_modules/.bin/tsc --noEmit   # [MUST] 0 errors（[NEVER] npx tsc，見 02 §4）
npm run lint              # [MUST] 0 errors, 0 warnings
npm test                  # [MUST] all pass, count >= Phase A 之前
npm run build             # [MUST] success
```

> **驗證指令 [NEVER] pipe 進 `tail`/`head`/`grep`**——shell 回傳最後一個指令的 exit code，會把失敗讀成通過。完整說明見 02 §4。

[MUST] 跑 guard 測試（`workers/tests/guards.test.ts`）：D17 Fix→Lock、D18 registry 完整性、D19 FIX-LOG、D20 REFLECT、D21 THINK、D26 documentation set、D27 intent-parity、D28 tests.md、D29 ship-check gate、D30 retro、D31 pre-mortem、D32 release-notes、D33 acceptance scenarios、**D35 deployment.md**、**D36 README parity**。

### 5.2 — [MUST] 產出/更新文檔（03 §5 + 本文件擴充）

[MUST] 只更新有變動部分，反映當前現實，[ALWAYS] 記錄 IS not SHOULD BE（03 §1）。

| 文件 | [MUST] 內容 |
|---|---|
| `README.md` | 一段話專案定位 + 技術棧（取自 01 §1）+ 安裝/build/test 指令 + 關鍵環境變數 + guard 概覽（D1–D36 一句話）+ 指向 `01-CLAUDE.md`/`deployment.md`/本框架 + `Last verified:` 標記 — [MUST] 通過 **D36**（6 項同位檢查，見 `references/HANDOVER-CHECKLIST.md`） |
| `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`） | **D35**：環境矩陣 / 部署指令 / Secrets 與變數 / Migration 順序 / 回滾程序 / 部署後驗證 / 維運 Runbook（見 `references/DEPLOYMENT-TEMPLATE.md`）— 交接核心 |
| `/documentation/` 核心集（D26） | architecture / flows / permissions / variables / tests（D28），architecture.md 含 Related Documents 索引；條件文檔（seo 通常 [MUST]）依能力產出 |
| `docs/ARCHITECTURE.md`（或既有 module reference） | Phase A 快照：Hono→Astro 連鎖、D1/KV/R2 資料流、模組依賴圖、SSoT 目錄 |
| `01-CLAUDE.md` | [MUST] 準確性驗證清單（04 §4.c）：禁令/路徑/版本與程式碼一致 |
| `TODO-REVIEW.md` | 標記本 cycle 已解決項（含日期），加入新發現（含 D27 parity findings） |

[MUST] README/ARCHITECTURE/documentation 中所有引用的檔案路徑必須存在（由 D16 強制）。[NEVER] 記錄不存在的功能或過時路徑。

### 5.4 — [MUST] Ship-check（D29）

[MUST] 進 main 前跑 ship-check（02 §5.5）：operating-context current / 無 CRITICAL-unverified rule / `/documentation/` set present。未過 → [NEVER] push 到 main。

### 5.3 — [MUST] 經驗記錄

[MUST] 新發現的防禦模式用 `putkm` 記錄（04 §5.5 格式，tags 含 `defense-pattern`/`cloudflare`）。[ALWAYS] 非顯而易見的問題與解法也記錄（02 §5）。

---

## Phase E — ops-doc 收斂（conditional，見 `~/Code/rules/08-OPS-MANUAL-FRAMEWORK.md`）

> 本 Phase 是 07 與 08（人類操作手冊框架）的**交接點**。只在專案有 docs-hub 手冊頁時觸發；否則註記跳過。
> [MUST] 在 Phase D 驗證全綠、文檔收斂完成後才跑。

1. **[MUST] 判斷 operational impact**：本次 Phase B/C 變更是否影響「人類如何操作/部署/排障」（指令、secrets、migration、runbook、整合接點）？
   - 否 → 註記「Phase E：無 ops impact，跳過」，結束。
   - 是 → 進步驟 2。
2. **[MUST] 蒸餾進 docs-hub** 對應頁（走 08 §3 頁面原型 + §4 frontmatter）：從本 cycle 的 `CHANGELOG`／`/documentation/deployment.md`／sent-log 抓真實內容（cite-or-don't-write）；每頁 frontmatter 帶 `source_repo`／`source_files`／`last_verified_head`。
3. **[MUST] 跑 drift guard**：`docs-hub/scripts/check-cites.sh` 過 + `npm run build` 過。

[NEVER] 憑記憶撰寫手冊內容；[NEVER] 把 01–07 合約搬進手冊。方法論全在 08。

---

## Phase F — portability + secret gate（見 `~/Code/rules/09-PROJECT-PORTABILITY.md` + `~/Code/rules/10-SECRETS-CONTRACT.md`）

> 本 Phase 是 07 與 09（專案可重建 + 廠商反鎖死）及 10（secret 權威 + 部署期保證）的**交接點**，作為「可發布 / 可搬移」閘門。
> [MUST] 在 Phase D 驗證全綠、Phase E（若有）完成後才跑。[NEVER] 跳過整個 Phase(步驟 1–4 非 conditional;步驟 5 條件化——見下,有用 secret/env 者 [MUST],否則註記跳過)。
> 步驟 1–4 續 09（每個 repo）；步驟 5 續 10（**有用 secret/env 者 [MUST]**，否則註記「Phase F.5：無 secret，跳過」）。

1. **[MUST] manifest 存在且完整**：`.portability.toml` 含五段（`machine_local`/`secrets`/`bootstrap`/`verify`/`vendor_lock`）——走 09 §1.1，guard 見 `references/PORTABILITY-GUARDS.md` §C。
2. **[MUST] 跑 portability guard 三項**：secret-not-in-vars / raw-SQL（Cloudflare = Drizzle）/ manifest 存在性——09 §1.2/§2.1，模板 `references/PORTABILITY-GUARDS.md` §A/§B/§C，[MUST] 接進既有 `workers/tests/guards.test.ts`。
3. **[MUST] 反鎖死檢查**：帳號特定 resource ID（D1 `database_id`/KV id/R2 bucket）未明文 commit（git grep 驗）、secret 與 `[vars]` 分離、`[vendor_lock]` 等級 + touchpoints 已標註——09 §1.2/§2.3。
4. **[MUST] fresh-clone smoke**：本機跑 09 §1.1 `[verify]`（`tsc`+`test`+dev boot+`curl /health`）證明可重建；`vendor_lock=high` 者 [MUST] 列綁定點清單（09 §2.3）。
5. **[MUST] secret 合約閘門（10，有用 secret/env 者；無則註記跳過）**：跑 10 §F–§J —— §F `assertBindings`/startup-check 涵蓋 `[secrets].worker` 每個 name / §G `wrangler.jsonc secrets.required` 與 manifest 同步（首次部署走 #14258 例外）/ §H reverse-coverage（code 用的 secret 必在 manifest）/ §I env-types↔runtime gateway 型別鎖（有 gateway 的 repo）/ §J naming-convention（新 secret 結構 + `legacy_names`）—— 模板 `references/PORTABILITY-GUARDS.md` §F–§J，[MUST] 接進既有 `workers/tests/guards.test.ts`。

任一失敗 → [NEVER] 宣告「可發布/可搬移」。方法論全在 09 與 10，[NEVER] 抄錄條文。

---

## 6 — [MUST] 執行順序（嚴格 pipeline）

```
Phase A (03 記錄現狀)  ──TODO-REVIEW──┐
   ▼                                  │
Phase B (02 完善程式碼+註解+補測) ◄────┘
   ▼
Phase C (04 加固 D1–D25 + Fix→Lock)
   ▼
Phase D (驗證四重奏 → 更新 README/deployment.md/ARCHITECTURE/01 → putkm)
   ▼
Phase E (ops-doc 收斂 → 蒸餾進 docs-hub，conditional)
   ▼
Phase F (09 portability + 10 secret gate → manifest/guard/smoke/§F–§J，可發布/可搬移閘門)
   ▼
完成報告
```

[MUST] Phase 失敗即 STOP，不進下一階段。[MUST] 同一問題 3 次連續失敗 → STOP 建立 Bug Report（02 §7）。

---

## 7 — STOP 條件（04 §6 匯總）

| 條件 | 動作 |
|---|---|
| 同一問題 loop > 3 次 | [MUST] STOP，人工介入 |
| 單一規則影響 > 10 檔 | [MUST] STOP，爆破半徑過大 |
| HUMAN queue > 3 項 | [MUST] STOP，需架構決策 |
| 不確定是否安全 | [MUST] STOP，寧可保守 |
| 預算會增加 | [ALWAYS] STOP，預算只減不增 |
| THINK VERDICT = STOP | [NEVER] 寫程式碼，先修架構 |

[MUST] 停下來。[NEVER] 猜。輸出卡在哪裡，等指示。

---

## 8 — 完成檢查清單

[MUST] 全部 ✅ 才能輸出 ALL-IN-ONE COMPLETE：

- [ ] D1–D25 防禦掃描全 PASS
- [ ] `tsc`/`lint`/`test`/`build` 全綠，測試數量 ≥ Phase A 之前
- [ ] D17/D18/D19/D20/D21 guard 全 PASS
- [ ] D26 `/documentation/` 核心集 5 份就位 + architecture.md 索引
- [ ] D27 intent-parity：每條 documented rule 有 code cite 或 finding
- [ ] D28 tests.md 3 section + 每條 rule 帶 status
- [ ] D29 ship-check gate 已接入 pre-push/CI 且 PASS
- [ ] D30 retro 已產出（含 ≤3 action items，owner+deadline）
- [ ] D31 pre-mortem 已跑（launch-blocking Tigers 含 mitigation+owner+date）
- [ ] D32 CHANGELOG New/Improved/Fixed 條目以使用者利益開頭
- [ ] D33 非平凡功能有 user-story + acceptance criterion
- [ ] **D35** `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`）就位且含 7 必填 section
- [ ] **D36** README 通過 6 項 Handover Parity 檢查（含 `Last verified:` + 交接連結）
- [ ] TODO-REVIEW.md 已產出、已解決項已標記
- [ ] **PRUNE**：本 cycle 已跑剪枝掃描；safe-to-prune 已清（含其測試），defer 項附觸發條件
- [ ] CHANGELOG 今日 cycle 完整，每條 fix 有 lock tag
- [ ] `README.md` + `/documentation/` + `docs/ARCHITECTURE.md` + `deployment.md` 已更新且路徑引用存在（D16）
- [ ] `01-CLAUDE.md` 準確性通過（禁令/路徑/版本）
- [ ] `putkm` 已記錄防禦模式/經驗
- [ ] **Phase E**：判斷 operational impact；有 docs-hub 手冊頁且有 impact → 蒸餾進 docs-hub 並過 `check-cites.sh`；無則註記跳過
- [ ] **Phase F**：`.portability.toml` 五段就位、portability guard 三項（secret-not-in-vars/raw-SQL/manifest）PASS、resource ID 未明文 commit、`[vendor_lock]` 已標註、fresh-clone smoke 過、**若用 secret：§F–§J 過（assertBindings 涵蓋 / secrets.required 同步 / reverse-coverage / type-lock[gateway] / naming）**
- [ ] 預算未增加

[MUST] 輸出報告格式：仿 04 §5 HARDENING COMPLETE + 本文件產出清單對照表。[NEVER] 在任一項未通過時宣告 COMPLETE。
