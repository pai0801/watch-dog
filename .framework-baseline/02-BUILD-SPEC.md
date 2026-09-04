# Cloudflare Stack 建造流程 (Build Process)

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。

## 0 — [MUST] 合規聲明

> 本文件定義所有程式碼變更（features, fixes, refactors）的 [MUST] 執行流程。
> 01-CLAUDE.md 為規則來源，本文檔定義執行流程。違反導致架構問題。
> [NEVER] 跳過任何步驟，[NEVER] 用程式碼遮蓋架構問題。

---

## 1 — [MUST] 經驗查詢 + THINK Block

**[MUST] THINK block 之前，先呼叫 `getkm`** 搜尋類似問題的過往解法。有相關經驗則納入分析。

> **THINK block 為 artifact**，由 **D21 guard** 驗證：tier ≥ standard（見 §1.5）
> [MUST] 在 BUILD-PLAN / PR / commit 引用一個 THINK block。trivial 豁免（見 §1.5）。getkm 呼叫本身為 `[HUMAN]`（無法靜態驗）。

完整 THINK 模板見 `THINKING.md`（7 欄位）。任何程式碼之前 [MUST] 輸出：

```
THINK:
1. ROOT CAUSE:     （根本原因，不是表面症狀。問「為什麼」至少兩次）
2. CORRECT LAYER:  （R2 Data / D1 / API Route / Component / i18n / CSS / Config）
3. AFFECTED FILES: （會動到哪些檔案，爆破半徑多大）
4. ASSUMPTIONS:    （這次修改依賴哪些假設？哪個最可能錯？）
5. SIMPLER PATH:   （有沒有更簡單的做法？能不能只改一行？）
6. RISK:           （改壞了最嚴重的後果？能不能 rollback）
7. VERDICT:        PROCEED / STOP（架構有問題則 STOP，[NEVER] 寫程式碼）
```

---

## 1.5 — [MUST] 變更分級（Change Tier → 決定跑哪些 gate）

> 對齊 `scripts/scan-projects.sh:analyze_changes()` 的 `minor/standard/major`，**不另立第二套門檻**。
> 門檻是寫死的——[NEVER] 憑感覺判「平凡」，[NEVER] 為保險把全套儀式套到一行 fix。

| Tier | 門檻（取較嚴者） | 必跑 gates | 可豁免 |
|---|---|---|---|
| **trivial** | ≤1 檔 **且** ≤10 行 **且** 不碰 critical-path¹ | getkm(輕量) + FIX-PLAN(05 §1) + §4 驗證 + putkm | D21 THINK / D33 user-story / D19 FIX-LOG / D28 tests.md |
| **standard** | 2–5 檔，且未達 major | + D21 THINK + D19 FIX-LOG + D28 tests.md（Proposed 段） | D33 user-story（除非屬新能力） |
| **major** | >5 檔² **或** 碰 critical-path¹ **或** 新增 load-bearing flow | 全套：D21 + **D33** user-story + D28 + D29 ship-check + D19 | 無 |

¹ **critical-path**（引用 `scan-projects.sh:138`，不複製）：`auth|config|middleware|.env|secret|docker|package.json|requirements|pyproject|schema|migration`。碰任一 → 直接 major（cf 棧常見：`package.json`/wrangler config/middleware/auth route/D1 migration）。
² **門檻與 `scan-projects.sh` 刻意不同（每一級都更嚴）**：scan 用 `minor≤5 / standard 6–20 / major>20`（為掃描 budget 分級）；本流程用 `trivial≤1 / standard 2–5 / major>5`（為 gate 觸發，更早要求完整儀式）。**同名但邊界不同**——交叉參照時以本表為準，scan 僅供 budget 參考。

> [MUST] 動工前先對照本表判定 tier，寫入 BUILD-PLAN / FIX-PLAN 第一行（例：`tier: standard (3 檔)`）。
> [NEVER] 自行降級以規避 gate；判定有疑義 → 取較嚴 tier。

---

## 2 — 規劃階段（Planning Phase）

此階段 [NEVER] 寫任何程式碼。

- [MUST] 列出所有變更檔案、預期影響、執行順序
- [MUST] 評估爆破半徑（直接影響、間接影響、測試影響）
- [MUST] 如有 schema 變更，包含 migration 計畫
- [MUST] 檢查依賴是否就緒（套件、型別、測試環境）
- [NEVER] 包含不必要的 refactoring

### 2.1 — [MUST] 非平凡功能先寫 user-story + 驗收條件（D33）

tier = major（>5 檔，或碰 critical-path，或新增 load-bearing flow，見 §1.5）[MUST] 在寫任何程式碼前，先產出 user-story + acceptance test-scenarios，寫入 BUILD-PLAN。

- **user-story**（[MUST] 3 C's + INVEST）：`As a [role], I want [action], so that [benefit]` + 4–6 條 testable acceptance criteria
- **test-scenarios**（[MUST] 每條 story 衍生）：Test Objective / Starting Conditions / User Role / step-by-step Test Steps / Expected Outcomes / edge cases

> 由 **D33 guard** 驗證：BUILD-PLAN / FIX-LOG 對 tier = major 變更（見 §1.5）[MUST] 引用 user-story + ≥1 條 acceptance criterion。
> trivial 豁免（見 §1.5）。[NEVER] 先寫程式碼再補 story。

### 2.2 — [MUST] 以 /documentation/ 為規劃輸入

[MUST] 規劃前讀 `/documentation/`（architecture / flows / permissions / variables / tests，見 `references/DOCUMENTATION-SET.md`，D26）：
- 變更是否觸及 load-bearing flow？→ 對照 flows.md
- 變更是否動到 permission/boundary？→ 對照 permissions.md（並觸發 D27 parity check）
- 變更是否引入新 env var？→ 更新 variables.md
[NEVER] 規劃時忽略 /documentation/ 已記載的邊界。

### 2.3 — [MUST] 模組形狀設計檢查（`~/Code/rules/14-DESIGN-PRINCIPLES.md` 接線）

tier = standard+（見 §1.5）且變更涉及新增/修改模組接口或演算法落點時，[MUST] 對照 `~/Code/rules/14-DESIGN-PRINCIPLES.md`（跨棧 SSoT——讀了實作、[NEVER] 抄進本 repo）：

- **§0 兩問判準**（接口測試／擁有權測試）→ BUILD-PLAN [MUST] 註明新模組/新函數的答案
- **§2 四條規則**：唯一實作（演算法長出第 2 個呼叫端 → 抽具名模組，[NEVER] 第 3 份複本）／介面收縮（死參數同批刪）／分層擁有（route/handler 只留傳輸層關切）／複本漂移（修共用邏輯前 [MUST] 盤點全部複本，寫入 THINK 的 AFFECTED FILES）
- **新舊債分流**：既有違反列 TODO-REVIEW，[NEVER] 借規則之名在 build 裡順手重構（14 §3）

trivial 豁免（見 §1.5）。強制類別：artifact（BUILD-PLAN 欄位）+ human——consumer 採用時在本地 `ENFORCEMENT_REGISTRY.md` 登記（D18 驗）。

---

## 3 — 執行階段（Agent Teams）

三個角色 [NEVER] 兼任：

| 角色 | 職責 |
|---|---|
| **Executor** | 按批准計畫寫程式碼，[MUST] 不越界，遇架構問題 [MUST] STOP |
| **Reviewer** | 審查 type safety、資料隔離、i18n、邊界案例，可發出 STOP |
| **Hardener** | ESLint、Vitest 測試、邊界案例、預算影響、安全漏洞檢查 |

**執行規則：**
- Executor [MUST] 嚴格按規劃執行，完成後標記待審核
- Reviewer [MUST] 驗證 type safety + tenant isolation + i18n + 邊界案例
- Hardener [MUST] 確保測試覆蓋率 + ESLint 零新增 error + 安全檢查

**[MUST] Agent 品質要求：**
- [MUST] 調用 agent 時匹配任務複雜度與模型等級（架構設計 / 安全審計 ≥ opus，標準實作 ≥ sonnet，快速查找可用 haiku）
- [MUST] Reviewer 和 Hardener 角色 [NEVER] 使用低於 sonnet 等級的模型
- [MUST] 優先使用專門化 agent type（如 code-reviewer、security-reviewer），[NEVER] 在專門化 agent 可用時降級為通用 agent
- [NEVER] 以低品質 agent 執行架構決策、安全審計、或程式碼審查
- [MUST] agent prompt 必須包含充足上下文（相關規則、檔案路徑、驗收標準），[NEVER] 發送空泛或模糊的指令

### 3.1 — [MUST] Dispatch 前 hand-trace test assertion（防 plan 內含缺陷）

> 對應 dev-brain `62a1016c701b`：8-task plan 仍藏 (a) off-by-one（`calls[key] < 3` vs `<= 3`，使 subject 在第 3 次成功，與 `status=='failed' && attempts==3` 斷言矛盾）+ (b) 測試斷言一個 production 刻意不設的 dict key。reviewer/executor 在某些環境只回 "Acknowledged/APPROVED" 零 finding。

dispatch 每個 task 給 executor 前，[MUST] 先執行兩項補償：

1. **[MUST] 手動追蹤每條 test assertion** 對照 spec 描述的實作 signature / 行為——確認測試**自洽**（邊界、off-by-one、迴圈計數、斷言的 key/欄位實作真的會設）。不自洽 → 先修 plan，[NEVER] 丟給 executor 跑迭代。
2. **[NEVER] 把 reviewer 的 "APPROVED" 當驗證**。獨立以硬檔證據驗證每個 artifact：`git diff` 該檔、`pytest`/`vitest` 絕對路徑、`make typecheck`、逐行 `Read` 改動碼。**獨立驗證是完成的唯一真源**。

> 適用前提：本節為 `[HUMAN]` 判斷流程（無法靜態驗），由 D18 meta-guard 登記為 human。

---

### 3.2 — [MUST] Escalation Gate（升級前先查框架，不當人類為答案庫）

> 起點：agent 把框架（08/09/10 或本 01–07）已規定範式的問題，重新打包成開放題升級給人類——人類被迫重付已付過的決策成本，還得拆解 agent 自帶的錯（假代價、反框架角色）。源：wrangler resource-ID 違規被 09 §1.2 早已答完（gitignore + 範式 + manifest），仍以 4 選項升級裁決。

要把「這個違規／問題怎麼處理」升級給人類之前，agent **[MUST] 先過 gate**：

1. **[MUST] 先查框架有無已規定範式**——08／09／10、本 01–07、dev-brain（getkm）。
2. **有範式 → 套用（或提案套用），[NEVER] 改寫成多選題升級。** 違規若框架已規定修法，執行該修法，不開放討論。
3. **只有以下兩情況，才以「開放題」升級：**
   - **(a) 框架沈默／真新題**——查無已規定範式，確實需要人類判斷。
   - **(b) 修法不可逆或跨安全紅線**——需人類 sign-off（刪資料、動 prod secret、跨租戶影響等）。

**升級訊息 [MUST] 帶查證、[NEVER] 帶猜測：**
- [MUST] 附「我查了哪份框架（§X）、它說什麼、為何仍需人類」。
- [NEVER] 在升級選項裡編造代價、反轉框架角色、把已決定的事包裝成開放（例：把 phantom cost 列為選項代價；把壞例子講成好範式）。

> **違規計數**：升級了框架其實已答的問題 = process violation，[MUST] 記一筆進 dev-brain（tag `escalation-leak`），供 06 自審統計改進。本節為 `[HUMAN]` 判斷流程（何謂「已規定」「真新題」無法靜態驗），由 D18 meta-guard 登記為 human。

---

## 4 — 驗證階段（Verification Phase）

[MUST] 依序執行，不可跳過：

```bash
./node_modules/.bin/tsc --noEmit   # [MUST] Found 0 errors
npm run lint              # [MUST] 0 errors, 0 warnings
npm test                  # [MUST] Tests passed, count >= 修改前
npm run build             # [MUST] Build completed successfully
```

> **[NEVER] 用 `npx tsc`，[MUST] 用 local binary `./node_modules/.bin/tsc`。** `node_modules` 缺時 `npx tsc` 會從 npm 抓到同名玩笑包（`This is not the tsc command you are looking for`），pre-push hook 印出「FAIL: tsc type-check」→ 偽 type error，遮蔽真正根因（沒裝 node_modules）。local binary 缺時直接 `No such file` → 明確指向 `npm install`。pre-push gatekeeper（`ENGINEERING_GUIDE.md` §2.2）同此原則。（getkm ceefe43db76d / e034eb2bed02）

> **[NEVER] 把驗證指令 pipe 進 `tail`/`head`/`grep`**——shell 回傳**最後一個指令**（`tail` 等）的 exit code（0），不是工具的。`npm test 2>&1 | tail` 或 `tsc --noEmit | grep error` 會把失敗讀成通過。修法：(a) 寫檔再讀並單獨捕捉 exit：`npm test > /tmp/t.log 2>&1; echo EXIT=$?; tail /tmp/t.log`；(b) `set -o pipefail` 讓首個失敗指令傳遞；(c) 最佳：把工具包成 Vitest guard（直接斷言 `proc.status === 0`），從結構上無法被 pipe 遮蔽。（getkm c5fc0c002584 / 4526bee5e18b — F841 跨 ≥3 cycle 靜默出貨）

---

## 4a — [MUST] README / Deployment 同步觸發（D35 / D36）

> README freshness 不只靠 07 手動觸發。**日常開發路徑**（本文件 / 05）變更以下任一者時，[MUST] 同步對應文件，否則下次 07 的 **D35/D36 guard fail**。

| 本 cycle 變更 | [MUST] 同步 | 對應 guard |
|---|---|---|
| 新增/移除 `npm run <x>` script | README 安裝/build/test 段 | D36（指令真實） |
| 新增/移除環境變數或 secret | README 環境變數段 + `deployment.md` Secrets 段 | D35 + D36（無 phantom var） |
| 新增/移除 API 端點、路由 | README/API 概觀 + `documentation/flows.md` | D16 |
| 變更技術棧依賴 | README 技術棧段 | D36（棧一致） |
| 變更部署目標 / env 矩陣 / 回滾方式 | `deployment.md`（D35）+ README 環境段 | D35 |

> [NEVER] 為了通過 D36 而從 README 刪掉指令或變數——那是隱瞞 drift，不是修復。修法是同步 README 反映現狀。
> 完整檢查項見 `references/HANDOVER-CHECKLIST.md`；deployment 模板見 `references/DEPLOYMENT-TEMPLATE.md`。

---

## 5 — 自審清單（Self-Review Checklist）

所有 7 項 [MUST] 全部通過才能標記完成：

| # | Standard | 通過條件 |
|---|----------|---------|
| 1 | Build passes | `npm run build` 零錯誤 |
| 2 | All tests pass | `npm test` 全過，數量 >= 修改前 |
| 3 | Lint clean | `npm run lint` 零新增 error |
| 4 | No new TODO/FIXME | [NEVER] 用 TODO 掩蓋未完成工作 |
| 5 | No out-of-scope changes | [NEVER] 動到計畫外檔案 |
| 6 | Achieves stated purpose | 達到規劃文件的設計目的 |
| 7 | No security regression | 無 SSRF、XSS、IDOR 等安全性退化 |

**[MUST] 經驗記錄（雙庫分流）：** 自審通過後：
- 呼叫 `putkm` 記錄非顯而易見的問題與解法（problem / solution / tags / context）。[ALWAYS] 記錄，[NEVER] 跳過。判準：**需要「遇到類似問題才想起來」的**（bug、技術、pattern）→ putkm（語意召回，LanceDB）。
- **若本 session 產出了「在這個 workspace 之後每次都該做到的操作教訓」**（例：測試必須單線程跑、某指令必須加某 flag），[MUST] 一併寫入該專案的 `.jcode/refinements.md`（jcode 專案）或對應 harness 的確定性注入檔——判準：**需要「不用想起也永遠在場」的** → refine 類（每 session system prompt 必載）。沒有此類教訓則明確說「本次無 refinement」。[NEVER] 把只該語意召回的內容塞進注入檔（永遠在場的噪聲是負資產）。

---

## 5.5 — [MUST] Ship-Check Gate（D29）

merge 到 main 前 [MUST] 跑 ship-check，三項全過才能 push：

- [MUST] **operating-context current**：`CLAUDE.md` / `AGENTS.md` 反映當前現實（禁令/路徑/版本與程式碼一致，04 §4.c）
- [MUST] **無 CRITICAL-unverified rule**：/documentation/ 中無 rule 被標 CRITICAL-unverified（D27 finding 已解或降級）
- [MUST] **/documentation/ set present**：5 份核心檔就位（D26）
- [MUST] **guard currency**：部署/CI 模式變更時（如 auto-deploy→手動、加減 ship.sh），[MUST] 審計所有 encode 舊模型的 guard/workflow/訊息——過時 fail 訊息比沒 guard 更危險（會誤導）。源於 direct-push-guard 在部署模式變更後訊息過時的教訓（getkm 3a00df4edea8）。
- [MUST] **gate read-only**：pre-push/CI gate [NEVER] mutate tracked file（如 `detect-secrets scan --baseline` 原地重寫 `generated_at` → auto-commit churn → local/remote diverge）；只做 read-only 檢查（getkm c0e358167156）。
- [MUST] **project-status emit**：非 trivial（>1 檔或 >10 行或碰 critical-path）變更 / hardening / health 變色，merge 前 [MUST] 依 `rules/PROJECT-STATUS.md` 用 **peter-brain `ingest_doc`**（`source_type="project-status"`，可變狀態走 upsert 庫、非 dev-brain 的 append lessons 庫）emit 一筆 status record，讓任何 session 動手前能跑 `project-status.sh <本專案>` 拉到最新 intent。trivial 修補免 emit（每日 digest 帶過）。

> 由 **D29 guard** 驗證：ship-check step [MUST] 接入 pre-push hook / CI（assert config 存在，見 04 §0 pre-push gatekeeper 模式）。
> ship-check 未過 → [NEVER] push 到 main。

---

## 6 — 提交流程（Commit Process）

- [MUST] Stage 具體檔案（[NEVER] `git add -A` / `git add .`）
- [MUST] 使用 conventional commit 格式（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`）
- [MUST] schema 變更時在 commit message 包含 migration 指令
- [MUST] merge 到 main 前通過 §5.5 ship-check（D29）
- [MUST] push 前先 `git fetch` + `git pull --rebase`（多寫入者 main：auto-commit daemon / CI runner / 多機並存）
- [NEVER] 對已 push 的近期 commit 做 amend/rebase/rewrite — main 禁 force-push，無法補救；要改就新增 commit
- working-tree 改動「消失」時 [MUST] 先查 `git status` / `git reflog`（可能被 auto-commit 帶走），[NEVER] 假設資料遺失
- [NEVER] 使用 `--no-verify`
- [NEVER] 提交 `.env`、credentials、secrets、node_modules、build 產物

---

## 7 — 失敗處理（Failure Handling）

**任何失敗 [MUST] 停止，[NEVER] 跳過、[NEVER] 忽視。**

**STOP 原則：** 失敗時 → STOP → 貼上錯誤（file:line + error message）→ 修復 → 重啟 THINK block。

**3 次連續失敗規則：** 同一問題連續失敗 3 次 → [MUST] 停止並建立 Bug Report（含完整錯誤日誌、3 次嘗試方法及結果、分析結論）。

---

## 8 — 禁止事項（Prohibitions）

| [NEVER] 行為 | 嚴重程度 | [MUST] 替代方案 |
|---|---|---|
| `as any` | CRITICAL | Type assertion chain 或 narrowed interface |
| Raw SQL | CRITICAL | Drizzle query builder |
| 直接 `import { env } from 'cloudflare:workers'` | CRITICAL | Runtime gateway via `@/lib/runtime` |
| 靜態錯誤吞嚥（空 catch） | HIGH | try-catch with handling/logging |
| 內部錯誤訊息給客戶端 | HIGH | Generic error message |
| Component 直接讀取 R2/D1 | HIGH | Service layer |
| `c.env` 在 request context 外 | HIGH | Pass as parameter |
| 在 middleware 做快取 | MEDIUM | Service wrapper |
| 未經批准安裝套件 | MEDIUM | Ask first |
| 重構不相關檔案 | MEDIUM | Stay in scope |
