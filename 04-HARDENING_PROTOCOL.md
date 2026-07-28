# 04-HARDENING_PROTOCOL — 強化協議（模式鎖定）

> 定義 Cloudflare Stack 專案的 nightly hardening 流程與架構守護規則。
> 審查流程請見 `03-DOC-AND-CODE-REVIEW.md`。

---

## Section 0 — [MUST] 強制合規聲明

本文件是 [MUST] 強制合約，非建議。所有 `[MUST]`/`[NEVER]`/`[ALWAYS]` 標記為不可談判規則。

[MUST] 執行 hardening 的 agent 必須使用高品質模型（防禦掃描 ≥ sonnet，安全審計與錯誤分類 ≥ opus）。

| 禁止模式 | 嚴重程度 | 正確動作 |
|---|---|---|
| `git commit --no-verify` | CRITICAL | 修復鉤子失敗。重新暫存。無 flag 提交 |
| `git push --no-verify` | CRITICAL | 本地修復測試/lint 失敗。無 flag 推送 |
| `git push --force` 到 main/master | BLOCKED | [NEVER] 拒絕，即使使用者要求 |
| CI 後省略 `make clean` | HIGH | 3.3GB 磁碟。[MUST] 每次 CI 清理 |
| `2>/dev/null \|\| true` 吞噬 lint 輸出 | HIGH | 僅在工具不存在時抑制。[NEVER] 抑制實際失敗 |
| 提交 `.env`、credentials、`.pem`、`.key` | CRITICAL | [MUST] 立即取消暫存並加入 `.gitignore` |
| `rm -rf /` 或 `rm -rf ~` | CRITICAL | [NEVER] 生成無破壞性範圍的命令 |

[MUST] 執行任何 git/CI 命令前，先對照此表。匹配即中止並修復根本原因。

---

## Section 1 — 核心原則

- 一個關注點一個源頭：env / config / auth / db / utils / constants [MUST] 各自有唯一 SSoT
- [MUST] shared logic 集中在單一模組中，不散佈
- [ALWAYS] 在正確層級修根本原因，never symptoms
- [MUST] uncertain → STOP，don't guess，先問
- [MUST] patterns discovered in review → locked in ESLint/Vitest → verified
- [MUST] 防禦模式跨專案共享：hardening 前呼叫 getkm 發現其他專案的防禦模式，發現新模式後用 putkm 記錄供其他專案學習
- [MUST] hardening 一輪完成時，另依 `rules/PROJECT-STATUS.md` 用 peter-brain `ingest_doc`（`source_type="project-status"`）emit 一筆 project-status record（health 通常轉 green），讓跨專案 session 能跑 `project-status.sh <本專案>` 拉到加固後狀態

---

## Section 1.5 — [MUST] Pre-Mortem（D31，hardening/release 前置）

主要 release 或 hardening cycle **開始前** [MUST] 跑一次 pre-mortem。想像 14 天後 launch 失敗了，往回推出錯點。完整模板見 `references/RETRO-PRE-MORTEM-TEMPLATES.md`。

[MUST] 分 3 類風險：

- **Tigers**（真實風險，基於證據，需 action）
- **Paper Tigers**（表面成立但被誇大，記錄以對齊認知）
- **Elephants**（未說出口/未驗證的疑慮，需調查）

> [MUST] 不確定時預設為 Tiger（高估風險比低估安全）。

[MUST] 將 Tigers 分類：

| 類別 | 意義 | 處理 |
|---|---|---|
| **launch-blocking** | 解決前不能上線 | launch 前必修 |
| **fast-follow** | 上線後 ≤30 天內修 | 排入下個 cycle |
| **track** | 監控即可 | 設監控點，不阻塞 |

[MUST] 每條 launch-blocking Tiger 含 mitigation + owner + date。

> 由 **D31 guard** 驗證：release/harden commit 前有 PreMortem artifact；launch-blocking Tigers 全部含 mitigation+owner+date。[NEVER] 跳過 pre-mortem 直接 release/harden。

---

## Section 2 — Phase 1: 錯誤模式分析 + 防禦掃描

輸入：git diff、error logs、failed checks、TODO-REVIEW.md

### Step 0: [MUST] 跨專案防禦模式發現（getkm）

每次 hardening [MUST] 先搜尋其他專案的防禦模式，識別可採納的 guard：

```
getkm("defense-pattern cloudflare guard eslint", tags=["defense-pattern", "cloudflare"])
```

評估原則：
- 其他專案已有此 guard 且驗證過 → 優先採納（已證明有效）
- 與本專案當前防禦掃描結果對照 → 識別缺口
- [NEVER] 盲目照搬 → 評估是否適用於本專案架構

### Step 1: 錯誤分類

對每個錯誤模式執行：

```
ERROR:
1. PATTERN:    [出現頻率]
2. ROOT CAUSE: [一句話根本原因]
3. CLASSIFICATION:
   → ESLINT  : 靜態可偵測？錯誤 import、禁止語法、壞模式？
   → VITEST  : 邏輯錯誤？需要執行驗證？資料流問題？
   → HUMAN   : 架構決策？商業邏輯？無法自動鎖定？
   → UNSURE  : 預設為 HUMAN，不猜測
4. 僅 ESLINT 或 VITEST 繼續：
   WRONG: [最小錯誤範例]
   RIGHT: [最小正確範例]
   RULE : [可直接貼上的設定]
5. 寫入正確位置：
   ESLINT → eslint.config.js (flat config)
   VITEST → 新增或更新測試檔案
   兩者   → CHANGELOG.md (日期 + 原因 + 規則)
```

### Step 2: [MUST] 防禦掃描矩陣

不管有沒有錯誤，每次 hardening [MUST] 逐項檢查：

| # | 防禦項目 | 檢查方式 | 失敗條件 | 防禦工具 |
|---|---------|---------|---------|---------|
| D1 | 租戶隔離完整性 | grep WHERE 子句 | 不含 storeId/slug 的 UPDATE/DELETE | Guard: `tenant-isolation` |
| D2 | API 認證覆蓋 | grep POST/PUT/DELETE/PATCH handler | 缺少 tenant/session 檢查 | ESLint: `require-tenant-auth` |
| D3 | Dev 端點保護 | grep test/debug API routes | 缺少 PROD guard | ESLint: `require-prod-guard` |
| D4 | Cookie 安全 | grep set-cookie / cookie 設定 | 缺少 HttpOnly 或 Secure | ESLint: `require-httponly-cookie` |
| D5 | Import 隔離 | grep cloudflare:workers import | 非閘道檔案的直接 import | Guard: `import-isolation` |
| D6 | 型別安全預算 | grep `as any` | 超過 budget 或缺少 eslint-disable 原因 | Guard: `as-any-budget` |
| D7 | Raw SQL 預算 | grep `db.execute` / `.execute(` | 超過 budget（只減不增） | Guard: `raw-sql-budget` |
| D8 | i18n key 一致性 | 比對 locale JSON 檔案 | 語系之間 key 不一致 | Guard: `i18n-parity` |
| D9 | 硬編碼字串 | grep JSX 中的 CJK/英文文字 | 元件中有未透過 t() 的文字 | Guard: `hardcoded-strings` |
| D10 | Migration 同步 | 比對 migration SQL 與 applied set | 有未套用的 migration | Guard: `migration-drift` |
| D11 | CLAUDE.md 準確性 | 人工比對 | 規則/模組路徑/版本與程式碼不符 | Phase 3 文檔同步 |
| D12 | Secret 暴露風險 | `detect-secrets scan` | 新增 secret 或 baseline 過期 | Pre-commit hook + CI |

> **矩陣 guard 已知失效模式**（D1–D10 多為 grep/ESLint 字面 pattern）：(a) 動態組字 SQL/import 可繞過——例 D1 的 WHERE 子句若由字串拼接組成，grep `storeId` 不一定命中；(b) 註解或字串常數裡的 pattern 會 false-positive；(c) ESLint 規則可被 `eslint-disable` 局部關閉（故 D6 需附原因）。緩解：這些是「抓大多數」的防線，非形式證明；繞過空間靠 D5 import 隔離 + 03 審計補位。**字串匹配 guard 的固有界限，記錄於此以避免假信心。**

每個失敗的項目 [MUST] 視為新的錯誤模式，回到 Step 1 分類處理。

---

## Section 3 — Phase 2: 驗證

[MUST] 按順序執行，不可跳過：

```
1. Type check → zero TypeScript errors
2. Lint       → zero ESLint errors
3. Tests      → all pass, count ≥ pre-hardening
4. Build      → zero errors
5. Fix→Lock 配對 (D17) → PASS：本 cycle 每條 fix bullet 都攜帶有效 lock tag
```

失敗處理：每個失敗 = [MUST] new error pattern → return to Phase 1。同一問題 max 3 iterations → [MUST] STOP，add to HUMAN queue。Budget 違規 → [MUST] immediate STOP。

**Step 5 (D17) 是「只修症狀」的防線。** D17 失敗代表有 fix 沒加 guard →
[MUST] 回 Phase 1 Step 1 分類並補 guard，補完重新驗證。[NEVER] 跳過 D17 宣告 COMPLETE。

> **[NEVER] 把驗證指令 pipe 進 `tail`/`head`/`grep`**——exit code 是 `tail` 的（0）不是工具的，失敗被讀成 PASS。修法：寫檔捕捉 `EXIT=$?` / `set -o pipefail` / 包成 guard 測試直接斷言 exit code。（getkm c5fc0c002584 / 4526bee5e18b — F841 跨 ≥3 cycle 出貨被 green pipe 遮蔽）

### [MUST] Guard 有效性驗證

除了通過/失敗，還要確認 guard 本身沒有鏽蝕：

| 檢查 | 方法 |
|------|------|
| Guard regex 仍匹配當前程式碼結構 | 人工確認 pattern 沒過時 |
| Test fixture 格式與真實 schema 一致 | 比對 fixture vs Drizzle schema |
| Budget 常數合理 | 如果 budget N 個月沒降，審查每個是否仍必要 |
| eslint-disable 數量未增加 | grep `eslint-disable`，每個都需有原因 |
| **Secret guard 涵蓋所有副檔名** | secret 掃描 [MUST] 涵蓋 repo 實際使用的**全部**原始副檔名（.ts/.tsx/.js/.mjs/.astro/.svelte/.sh/.py/.env），[NEVER] 只掃 .ts——真實 token 常藏在 .py/.sh（fe4f344889c8：D7 只掃 .ts，漏掉 scripts/daily_check.py 的 live Slack token） |
| **Raw-SQL guard 涵蓋所有呼叫點** | raw-SQL guard [MUST] 同時掃 `db.execute(` / `db.prepare(` / `sql.raw(` / `` sql` ``，[NEVER] 只掃 `db.execute(`（fe4f344889c8：D2 只掃 db.execute，漏掉 3 處 db.prepare raw-SQL） |
| **Guard 不靜默 no-op** | guard 讀 artifact [MUST] 用 repo-root 絕對路徑（`resolve(ROOT, ...)`），[NEVER] 裸相對路徑；會 `console.warn('skip')` 的 guard [MUST] 交叉確認 artifact 真實存在——monorepo 子套件 cwd 會讓 `existsSync` 恆 false → guard 永遠 skip 永遠 PASS（9d864a1dd5b8：anti-phantom guard 自己 phantom） |
| **Budget PASS 交叉驗證** | 信任任何 budget PASS 前，[MUST] 以獨立 grep 對照該 guard 的 regex vs 專案實際建構——template-only 覆蓋會對專案真實結構 false-PASS（fe4f344889c8：兩個 green guard 各藏一個 blind spot） |

---

## Section 4 — Phase 3: 文檔同步

[MUST] 只記錄實際存在的東西。[ALWAYS] 更新以反映當前現實。

### a) CHANGELOG.md 格式（D32 release-notes user-facing）

[MUST] CHANGELOG 條目 [MUST] 以**使用者利益**開頭（plain language），非技術變更本身。無 jargon / codename / ticket number，每條 1–3 句。範例：技術「Redis caching layer for dashboard API」→ 使用者「Dashboards now load up to 3× faster.」

> 由 **D32 guard** 驗證：最新 CHANGELOG cycle 的 New/Improved/Fixed/Breaking 條目 [MUST] 以使用者影響開頭（非 raw 技術變更）。Locked / Human Queue 段為內部用，豁免 user-benefit 檢查。

CHANGELOG 段落結構（New Features / Improvements / Bug Fixes / Breaking Changes / Deprecations 為 user-facing；Locked / Human Queue 為內部用）：

```markdown
## [YYYY-MM-DD]
**New Features**     — 新功能（user benefit 開頭）
**Improvements**     — 改善（user benefit 開頭）
**Bug Fixes**        — 修復（user impact 開頭）
**Breaking Changes** — 破壞性變更（migration/action 開頭）
**Deprecations**     — 廢棄（替代方案開頭）
**Locked**           — 今日新增的 ESLint/Vitest 規則（技術細節，內部用）
**Human Queue**      — 需要人工決策的項目（內部用）
```

### a1) [MUST] Fix→Lock 配對標籤（強制性來源）

`[MUST]` 文字標記無法防止「只修症狀、不加 guard」。真正的強制性來自一個會 fail 的測試。
**每一條 `### Fixed` bullet，以及 `### Human Queue` 中標記 `(resolved)` 的 bullet，
[MUST] 在 bullet 文字結尾攜帶下列其中一個 lock tag：**

| Tag | 意義 | 約束 |
|-----|------|------|
| `(locked: D##)` | 此 fix 由 guard `D##` 鎖定 | `D##` [MUST] 對應 `workers/tests/guards.test.ts` 中一個真實存在的 `it('D##: ...)` |
| `(human: <一句話理由>)` | 明確豁免，需人工決策理由 | 不得用來掩蓋漏加 guard；理由 [MUST] 具體（非「之後再處理」） |

**未攜帶 tag 的 fix bullet、或 `(locked: D##)` 指向不存在的 guard，視為 Phase 2 失敗。**

此規則由 **D17 guard**（`workers/tests/guards.test.ts`）自動檢查，隨 `make test` /
pre-commit / CI 執行。未通過 D17 → Phase 2 [MUST] 回到 Phase 1 補 guard，
[NEVER] 宣告 HARDENING COMPLETE。

> **已知失效模式**：D17 只驗「fix bullet 結尾有 lock tag 且 tag 指向存在的 guard」——(a) **tag 與 fix 不對應**（貼錯 D##，只要該 guard 存在就 PASS）抓不到，需 reviewer 人工判讀；(b) `(human: ...)` 豁免的「理由具體性」無法靜態驗，可被濫用為跳過 guard 的後門。緩解：(a) 由 03 審計抽查 tag-fix 對應；(b) `(human:)` 比例異常高時 06-REFLECT [MUST] 列為審查重點。

範例：
```markdown
### Fixed
- `src/x.astro`: ogImageUrl 修正為 /og/mbti/${id}.png。 (locked: D14)

### Human Queue
- HQ-002 (resolved): 移除 as Record<string, any>。 (locked: D15)
- HQ-003 (resolved): 移除 dead ENGINEERING_GUIDE.md 引用。 (locked: D16)
- HQ-001 (carry): stale worktree 待清理。   # carry/open 項目非 fix，不需 tag
```

### b) 更新規則：

| 文件 | [MUST] 動作 |
|---|---|
| CLAUDE.md | 加入 concrete example 的永久規則。[NEVER] 加入模糊原則 |
| dev-brain | [MUST] 新發現的防禦模式用 putkm 記錄（格式見下方），供其他專案 getkm 發現 |
| Module reference | 反映新增或變更的模組職責 |
| TODO-REVIEW.md | 更新已處理項目狀態，加入 hardening 中發現的新項目 |

### c) [MUST] CLAUDE.md 準確性驗證清單：

- 每條禁止規則 — 目前程式碼是否真的遵守？
- 每個模組路徑 — 檔案是否仍然存在？職責是否相同？
- 每個版本相關註記 — 是否仍然適用於當前版本？
- 技術棧版本 — 是否與 package.json / pyproject.toml 一致？
- 已知限制 — 是否有新發現的限制未記錄？

---

## Section 5 — Phase 4: 總結報告

```
HARDENING COMPLETE — [DATE]

LOCKED TODAY:
- [Rules added to ESLint/Vitest with reason]

DEFENSE SCAN:
- D1  租戶隔離: PASS / FAIL
- D2  API 認證: PASS / FAIL
- D3  Dev 保護: PASS / FAIL
- D4  Cookie 安全: PASS / FAIL
- D5  Import 隔離: PASS / FAIL
- D6  型別預算: N (was M, -X)
- D7  SQL 預算: N
- D8  i18n 一致: PASS / FAIL
- D9  硬編碼: PASS / FAIL
- D10 Migration: PASS / FAIL
- D11 文檔準確: PASS / FAIL
- D12 Secret: PASS / FAIL

HEALTH:
- TypeScript: PASS / FAIL
- ESLint:     PASS / FAIL
- Vitest:     PASS / FAIL
- Build:      PASS / FAIL

HUMAN QUEUE:
- [Items needing human decision]
```

[MUST] All defense scans + health checks PASS 才能輸出 COMPLETE。

---

## Section 5.5 — [MUST] 防禦模式共享（putkm 格式）

本次 hardening 新增的防禦模式 [MUST] 用以下格式記錄到 dev-brain：

```
putkm(
  problem="[防禦名稱]: [它抓什麼，為什麼重要]",
  solution="""
  ## 偵測方式
  [regex / AST pattern / ESLint rule config]

  ## 實作代碼
  [guard test 或 rule 的核心代碼片段]

  ## 驗收條件
  [怎麼確認它有效]
  """,
  tags=["defense-pattern", "cloudflare", "guard|eslint|pre-commit", "具體分類"],
  context="[本專案] — [驗證情境：什麼 bug 或 review 發現觸發了這個防禦]"
)
```

**Tag 規範：**
- `defense-pattern` — [MUST] 標記為防禦模式
- 技術棧：`cloudflare` 或 `python` — [MUST]
- 工具類型：`guard` / `eslint` / `pre-commit` — 至少一個
- 具體分類：`sql-safety` / `secret-detection` / `tenant-isolation` / `type-safety` / `i18n` / `cookie-security`

---

## Section 6 — STOP 條件

| Condition | Reason |
|---|---|
| Same issue loops > 3 times | [MUST] 理解不足，需人工介入 |
| Single rule affects > 10 files | [MUST] 爆破半徑太大，需確認 |
| HUMAN queue > 3 items in one cycle | [MUST] 需架構層級決策 |
| Unsure if change is safe | [MUST] 寧可保守，不要冒險 |
| Budget would increase | [ALWAYS] 預算只減不增 |

[MUST] 停下來。[NEVER] 猜。輸出你卡在哪裡，等指示。

---

## Section 7 — 最終檢查清單

| # | Check | Pass Criteria |
|---|-------|---------------|
| 1 | Defense scan 全過 | D1-D12 全 PASS |
| 2 | ESLint rule completeness | All patterns from this cycle addressed |
| 3 | Guard test completeness | All patterns have guards |
| 4 | Guard effectiveness | Regex/fixtures/budgets still valid |
| 5 | Type check | Zero errors |
| 6 | ESLint clean | Zero error, zero warning |
| 7 | Vitest all pass | All green, count ≥ pre-hardening |
| 8 | Build success | Zero errors |
| 9 | CLAUDE.md accuracy | No stale rules or paths |
| 10 | Fix→Lock parity (D17) | Every fix bullet carries a valid `(locked: D##)` or `(human:)` tag; all `D##` exist |

[MUST] All 10 pass before COMPLETE。第 10 項是強制性核心：未通過 = 有 fix 漏加 guard。

---

## Section 8 — 關鍵防線模板

> 各 guard 的完整測試模板已移至 `references/GUARD-TEMPLATES.md`；本節僅保留索引。下方（D1–D15）非 `### D##` 形式 heading，沿用原 a)–i) 子節命名對齊 §2 矩陣。

| 子節 | Guard | 模板位置 |
|---|---|---|
| a) | 租戶隔離 Guard (D1) | `references/GUARD-TEMPLATES.md §D1` |
| b) | API 認證 Guard (D2) — ESLint 規則 | `references/GUARD-TEMPLATES.md §D2` |
| c) | Dev 端點保護 Guard (D3) — ESLint 規則 | `references/GUARD-TEMPLATES.md §D3` |
| d) | Cookie 安全 Guard (D4) — ESLint 規則 | `references/GUARD-TEMPLATES.md §D4` |
| e) | Import 隔離 Guard (D5) | `references/GUARD-TEMPLATES.md §D5` |
| f) | i18n 一致性 Guard (D8) | `references/GUARD-TEMPLATES.md §D8` |
| g) | Migration 同步 Guard (D10) | `references/GUARD-TEMPLATES.md §D10` |
| h) | 通用 Budget Guard 模板 | `references/GUARD-TEMPLATES.md §Budget Guard 模板（通用）` |
| i) | Budget 追蹤表（detection regex / budget / 只減不增） | `references/GUARD-TEMPLATES.md §Budget 追蹤表` |

---

## Section 8.5 — Meta & Artifact Guards（D16, D18–D21, D34）

> 這些 guard 把「每條 [MUST] 都有強制機制」本身變成會 fail 的測試。對應 `ENFORCEMENT_REGISTRY.md`。
> 下游在 `workers/tests/guards.test.ts` instantiate。每個都 [MUST] 雙向驗證（fixed PASS / broken FAIL）。

### D18 — Registry 完整性 meta-guard

[MUST] 每個帶 `[MUST]/[NEVER]/[ALWAYS]` 的 section 都 [MUST] 在 ENFORCEMENT_REGISTRY 對應 doc 區塊有登記列；registry 覆蓋率不足 → Phase 2 fail。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D18`.

> **已知限制（多表格 registry）**：上方 count-logic 假設「registry 每個 doc 區塊 = 單一表格、data row 與 doc 的 tagged section 1:1」。若你的 registry 在同一 doc 標題下放**多個子表格**（或夾雜非 section 對應的列），`regRows` 會膨脹 → D18 恆 fail。採用變體：以「每個 doc 在 registry 有被引用（**存在性**）+ 雙向 D## 檢查」取代嚴格計數；或強制 registry 結構為「每 doc 一表、每 tagged section 一列」（本框架的 ENFORCEMENT_REGISTRY 即依此結構）。count-logic 上線時 [MUST] 構造「新增未登記 section → fail」「多一個 registry 子表 → 確認是否誤判」兩個反向測試。（getkm 1b09c53a40a1 / 32d405c0bf92 — 多個採用專案實證 raw count-logic 在多表格 registry 失效）

### D19 — FIX-LOG artifact guard（05-FIX-SPEC §1/§4/§5）

[MUST] 每條 CHANGELOG fix 都 [MUST] 有對應 FIX-LOG entry，含目標/原因/預期結果/範圍 + 驗證四重奏結果（tsc/lint/test/build）四欄位齊全。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D19`.

### D20 — REFLECT artifact guard（06-REFLECT §3/§4/§5）

[MUST] 每個 session/cycle 都 [MUST] 產出 REFLECT.md，含 R1（[MUST] 遵守）至 R5（經驗記錄）各段非空，[NEVER] 以裸 "N/A" 逃避。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D20`.

### D21 — THINK block artifact guard（02 §1, 05 §3）

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D21`.

> **已知失效模式**：tier 判定是 `[HUMAN]`——操作者可能誤把 standard 判成 trivial 以規避 THINK。緩解：02 §1.5 門檻寫死（檔數/行數/critical-path 客觀可查），判定有疑義取較嚴 tier；本 guard 只能驗「tier ≥ standard 時有無 THINK 引用」，無法驗 tier 判定本身是否正確。

> D18 是 meta 層的「強制性核心」：它保證本協議沒有任何 [MUST] 是孤兒（無 guard、無 artifact、
> 未宣告 human）。新增規則時若忘了登記 → D18 fail，Phase 2 過不了。

### D16 — 現況文檔 code-path drift guard（升級：全文檔範圍）

> 原始 D16 只驗 CLAUDE.md 引用路徑。omni-bot 實證（dev-brain `a25ff78aab41`，G30）：重構刪檔後
> **architecture.md / permissions.md / README 仍 cite 已刪檔**，typecheck/lint/build/test 全綠靜默通過。
> 升級成「所有現況文檔的 code-path cite 须存在」，[NEVER] 記錄不存在的路徑。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D16`.

> **範圍邊界**：(1) 排除歷史日誌（TODO-REVIEW/FIX-LOG/CHANGELOG/REFLECT）——其 cite 是「缺陷發生時的所在」；
> (2) 排除 brace expansion（`{types,machine}.ts` 非字面路徑）；(3) regex 在副檔名停止，不捕 `:40` 行號。
> **非 vacuous 證明**：omni-bot 首跑即抓到 `core-session/tests/faq-loader.test.ts` 應為完整路徑 → 證明有效。
>
> **已知失效模式**：regex 只認固定副檔名形式（`.ts`/`.tsx`/...）——(a) 非白名錄根目錄布局的 cite 不掃；(b) 動態組字路徑、monorepo workspace 別名（`@/`、`~/`）抓不到；(c) brace expansion 已排除但 template-literal 路徑未排除。緩解：誤判少（只驗存在性），但漏判真實——新增頂層目錄或 path alias 時 [MUST] 同步擴充 regex。

### D34 — Anti-Phantom Enforcement Audit（meta-meta）

> 防止「guard 被聲稱存在但實際不存在 / 沒接線 / ID 碰撞」。D18 驗「每條 rule 有登記」；
> **D34 驗「每個被登記的 guard 真實存在、唯一、且被執行」**——D18 自己 phantom 時，只有 D34 抓得到（recursive failure 防線）。
> 對應 dev-brain 經驗 `f7c0dbf75dc1`：life-talk 曾出現 D17 由不存在的 `test_guard_fixlock_parity.py` 強制、
> 同時 D17 ID 碰撞指另一個 guard → 每句「D17 PASS」都 silently ambiguous；D18–D21 全 phantom。

每個被 registry/04/CHANGELOG 宣稱為 "enforced" 的 D## guard，[MUST] 通過四驗：

| 驗證 | 失敗條件 | 範例 |
|---|---|---|
| **Existence** | registry 宣稱的 test 路徑不存在 | 04 寫 `test_guard_fixlock_parity.py` 但該檔不在 repo |
| **Implementation** | test 沒真的 assert 該 invariant（只 docstring 提到 ID） | `def test_d17...` body 只有 `pass` |
| **Wiring** | pre-commit / CI / Makefile 都沒引用 | guard 寫了但 `make test` 不跑它 |
| **Collision** | 同一 D## 指兩個不同 guard 定義 | 兩個 `### D17` heading，或 test 與 doc 各指一個 |

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D34`.

> **非 vacuous 證明**：本 guard 首次落地 [MUST] 構造違規樣本（在 04 加第二個 `### D17` heading、
> 或暫時改名 guards.test.ts）確認會 FAIL，再還原。沒做這步 = 不能信任 PASS 結果。
> artifact 類 guard（D19/D20/D21/D26–D33）以「對應 artifact 模板 + 其 validator guard 存在」間接滿足 Implementation。
> **框架層自律**：`scripts/validate-templates.sh` 在 rules repo 即對模板做 collision + undefined-D## 檢查（drift 在 source 抓，非下游）。

---

## Section 8.6 — 01 禁止事項 gap guards（D22–D25）

> 01-CLAUDE.md §15 禁止事項多數已由 D1–D12 覆蓋。下列 4 條可靜態檢查但原本無 guard，補為模板。

### D22 — Forbidden imports（Node.js / Express / tRPC）

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D22`.

### D23 — No raw physical DELETE on core tables（軟刪除）

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D23`.

### D24 — No raw `r2.dev` domain in source

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D24`.

### D25 — `R2.get()` results must be null-checked

[MUST] 每個 `R2.get()` binding 都 [MUST] 在使用前有 `if (!x)` / `??` / `?.` null-handling；未處理 → fail。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D25`.

> 01 §15 中 `[HUMAN]` 類（低品質 agent 執行架構決策、UI 設計原則）不自動化，於登記表標 human。

---

## Section 8.7 — PM / Documentation Artifact Guards（D26–D33）

> 整合 7 個 PM skill 為可執行步驟。對應 `ENFORCEMENT_REGISTRY.md`。
> 下游在 `workers/tests/guards.test.ts` instantiate。每個 [MUST] 雙向驗證（fixed PASS / broken FAIL）。

### D26 — Documentation coverage（artifact）

`/documentation/` [MUST] 維護核心集 5 份：`architecture.md` / `flows.md` / `permissions.md` / `variables.md` / `tests.md`。
`architecture.md` [MUST] 含「Related Documents」索引指名其他每份產出文檔。
條件文檔（`emails.md` / `cron.md` / `seo.md` / `automation.md`）僅在該能力存在時產出；否則 `architecture.md` 一行註記。
Validator：5 份核心檔存在 AND `architecture.md` references each by name。完整欄位見 `references/DOCUMENTATION-SET.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D26`.

### D27 — Intent-vs-Implementation parity（artifact）

`/documentation/permissions.md` 與 `/documentation/flows.md` 中每條 documented rule [MUST] 引用一個 code enforcement point（`file:line`）或記為 finding（documented-but-unenforced）。
每條 finding [MUST] 命名：documented intent（quote）+ implemented reality（code cite）+ attacker & victim + concrete fix。
Validator：no rule silently unverified。完整方法見 `references/INTENT-PARITY-CHECKLIST.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D27`.

### D28 — Test verification map（artifact）

`/documentation/tests.md` [MUST] 有 3 個分離 section — Existing coverage / Proposed tests / Gaps。
每條 documented rule 帶 status（existing / proposed / none）。
Validator：tests.md 存在含 3 headings；no rule row missing status。完整格式見 `references/DERIVE-TESTS-MAP.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D28`.

### D29 — Ship-check gate（guard）

merge 到 main 前 [MUST] 跑 ship-check：(1) operating-context（CLAUDE.md / AGENTS.md）current，(2) 無 documented rule 標 CRITICAL-unverified，(3) `/documentation/` set present。
Validator：ship-check step 接入 pre-push / CI（assert config 存在）。見 02 §5.5。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D29`.

### D30 — Retrospective（artifact，augments D20）

每個 cycle / session-end [MUST] 產出 retro（Start/Stop/Continue OR 4Ls）+ ≤3 prioritized action items，每個含 owner + deadline + success metric。
carry-over 自前次 retro [MUST] 追蹤。Validator：retro block 存在，≥1 action item 含 owner+deadline。完整模板見 `references/RETRO-PRE-MORTEM-TEMPLATES.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D30`.

### D31 — Pre-mortem（artifact）

主要 release 或 hardening cycle 前 [MUST] 跑 pre-mortem — Tigers（real risks）/ Paper Tigers（overblown）/ Elephants（unspoken）。
Tigers 分類 launch-blocking / fast-follow / track。每條 launch-blocking Tiger 含 mitigation + owner + date。
Validator：PreMortem artifact 在 release/harden commit 前存在。見 §1.5。完整模板見 `references/RETRO-PRE-MORTEM-TEMPLATES.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D31`.

### D32 — Release-notes user-facing（artifact）

CHANGELOG 條目 [MUST] 以使用者利益開頭（plain language，非 raw 技術變更），分類 New / Improved / Fixed / Breaking。
Validator：最新 CHANGELOG cycle 條目以使用者影響開頭。見 §4.a。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D32`.

### D33 — Acceptance scenarios before build（artifact）

tier = major（見 02 §1.5：>5 檔 或 critical-path 或新增 load-bearing flow）[MUST] 在實作前有 user-story + acceptance test-scenarios。
Validator：BUILD-PLAN / FIX-LOG 對 tier = major 變更引用 user-story + ≥1 acceptance criterion。見 02 §2.1。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D33`.

> D26–D33 與 D1–D25 並列。D1–D12（防禦掃描）與 security/perf 不在此處修改 — PM skill 不整合 security/perf（依框架規則）。

---

## Section 8.8 — Handover & Deployment Guards（D35–D36）

> 交接斷層防線。D35 保證「**怎麼部署/回滾/排障**」有文件；D36 保證「**README 反映現狀**」。
> 對應 `ENFORCEMENT_REGISTRY.md`。下游在 `workers/tests/guards.test.ts` instantiate，每個 [MUST] 雙向驗證（fixed PASS / broken FAIL）。

### D35 — Deployment & Operations Doc（artifact）

[MUST] 維護 `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`）反映**現狀**。Validator 檢查檔存在 AND 含 7 個必填 section heading：環境矩陣 / 部署指令 / Secrets 與變數 / Migration 順序 / 回滾程序 / 部署後驗證 / 維運 Runbook。
內容 [MUST] 與現實一致（由 D16 code-path cite 雙重保證：deployment.md 內每個指令/binding/路徑必須存在）。
完整骨架見 `references/DEPLOYMENT-TEMPLATE.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D35`.

> **已知失效模式**：section 存在性只認 heading 文字——(a) 子字串/變體命名（hyphenated 標題、「Rollback」vs「回滾程序」）可能 false-negative；(b) heading 在但內容空/過時仍 PASS。緩解：以**完整 heading 文字**比對（不接受子字串命中），內容真實性由 D16 code-path cite + 03 審計分擔。

### D36 — README Handover Parity（guard）

[MUST] `README.md` 是有效交接入口。Validator 靜態檢查 6 項：(1) one-liner 非空非佔位、(2) 技術棧與 `package.json` 一致、(3) README 列的 `npm run <x>` 是真 script、(4) 無 phantom 環境變數（README 提及的 UPPER_VAR 必須存在於 wrangler.toml/code）、(5) 連結 01-CLAUDE.md + 部署文件 + /documentation/、(6) 含 `Last verified:` 標記。
完整檢查項 + validator 模板見 `references/HANDOVER-CHECKLIST.md`。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D36`.

> **已知失效模式**：(a)「`npm run <x>` 是真 script」靠子字串比對——README 寫了但 script 改名時，舊名是某新 script 子字串仍 PASS；(b) phantom env var 只驗 UPPER_CASE，`lowerCase` wrangler var 漏網；(c) stack 一致性只比對相依存在，不驗版本。緩解：靜態 guard 設計上只抓「明顯漂移」，深層一致性交給 03 審計 + D16。**這正是框架不上 D37 regex SSoT guard 的理由**（見 DOCUMENTATION-SET §5）——數字比對 regex 會把版本號撞行號/port 的誤判常態化。

> D35/D36 與 D26–D33 並列為交接防線。D35 是 ops 文件（與 D26 的 5 份邏輯文件並列）；D36 是 README 同位 guard。
> [NEVER] 為通過 D36 而刪 README 指令/變數——那是隱瞞。修法是同步 README 反映現狀。

### D37 — Volatile-number SSoT（static drift detector）

> 揮發性數值（schema 版本 / 測試數 / route 數）跨現況文檔 [MUST] ≤1 distinct value——兩處寫不同數字即 drift。
> **靜態掃描，不跑 runner**：只比對 labeled 數字，排除歷史檔，避免撞行號/port。

> 完整 guard 測試模板見 `references/GUARD-TEMPLATES.md §D37`.

---

## Section 9 — Human Queue 管理

[MUST] 維護在 TODO-REVIEW.md。分類：架構決策、商業邏輯、安全政策、技術債。
已解決項目標記日期。超過 3 項 unresolved → [MUST] STOP until resolved。

---

## Guard Index（D1–D36）— 全 guard 速查

> `ENFORCEMENT_REGISTRY.md` 的每個 D## [MUST] 出現於本表。下游 instantiate 於 `workers/tests/guards.test.ts`。

| Guard | 用途 |
|---|---|
| D1–D12 | 防禦掃描矩陣（§2）：租戶隔離/認證/dev保護/cookie/import預算/sql預算/i18n/硬編碼/migration/doc/secret |
| D13 | per-page CJK budget（單頁 CJK ≤ N）— i18n 補強 |
| D14 | OG endpoint parity（OG URL 必須對應 endpoint） |
| D15 | no `as ...any` in `.astro` frontmatter（eslint 不涵蓋 .astro） |
| D16 | 現況文檔（CLAUDE.md / architecture / permissions / README 等）的 code-path cite 必須存在；排除歷史日誌與 brace expansion（§8.5） |
| D17 | Fix→Lock parity（CHANGELOG lock-tag） |
| D18 | D-META：registry 完整性 + section 覆蓋（§8.5） |
| D19 | FIX-LOG artifact（§8.5） |
| D20 | REFLECT artifact（§8.5） |
| D21 | THINK block artifact（§8.5） |
| D22–D25 | 01 §15 gap guards：forbidden imports / no physical DELETE / no r2.dev / R2.get null-check（§8.6） |
| D26 | Documentation coverage：/documentation/ 核心集 5 份 + architecture.md 索引（§8.7） |
| D27 | Intent-vs-Implementation parity：每條 documented rule 有 code cite 或 finding（§8.7） |
| D28 | Test verification map：tests.md 3 section + 每條 rule 帶 status（§8.7） |
| D29 | Ship-check gate：pre-push/CI 接入 ship-check（§8.7） |
| D30 | Retrospective：retro block + action items owner+deadline，augments D20（§8.7） |
| D31 | Pre-mortem：release/harden 前置 Tigers/Paper Tigers/Elephants（§8.7） |
| D32 | Release-notes user-facing：CHANGELOG 條目以使用者利益開頭（§8.7） |
| D33 | Acceptance scenarios before build：tier=major（02 §1.5）先 user-story + acceptance（§8.7） |
| D34 | Anti-Phantom Enforcement Audit：每個 guard 真實存在 / 唯一 / 接線（§8.5，meta-meta） |
| D35 | Deployment & Operations Doc：deployment.md 含 7 必填 section（§8.8，artifact） |
| D36 | README Handover Parity：README 反映現狀（6 項靜態檢查，§8.8，guard） |
| D37 | Volatile-number SSoT：揮發性數值只在一處（衍生優先，否則 CLAUDE.md 現況行，其餘連結）— **guard（static drift detector）** |
