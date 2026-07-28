# Guard Authoring Patterns — Anti-Weakening & Drift-Lock

> 主文檔 04 保持精簡，本檔收納「寫 guard 時容易漏掉的反模式與其修正」。
> 對應 dev-brain：`75a41dba8e14`（anti-weakening）、`a25ff78aab41`（doc-path drift）。

## Pattern 1 — Anti-Weakening 雙斷言（正向 + 負向）

**Problem**：把散落的 drift 收斂成單一 helper 後，guard 若只驗「有呼叫 helper」，**有人日後再加回舊內聯模式仍會 pass**——drift 回退無人察覺。

**Rule**：[MUST] 收斂型 guard 同時驗兩件事：

| 斷言 | 檢查 | 失敗訊息 |
|---|---|---|
| 正向 | 新 helper 被使用 | `handler 未呼叫 canFinalizeTicket()` |
| 負向 | 舊 drift 模式消失 | `PATCH 區塊仍出現 orgRoles.some…org_admin 內聯判定` |

**Template（Vitest）**：

```typescript
it('D##: <capability> uses the single source of truth AND drops the old inline drift', () => {
  const handler = readFileSync('src/handler.ts', 'utf-8');
  // 正向：必須委派給唯一真源
  expect(handler, 'handler 必須呼叫 canFinalizeTicket()').toMatch(/canFinalizeTicket\(/);
  // 負向：舊內聯 drift 模式必須消失（防止日後回退）
  expect(handler, '舊內聯 orgRoles.some 判定仍殘留').not.toMatch(/orgRoles\.some\([^)]*org_admin/);
});
```

**非 vacuous 證明**：[MUST] 構造兩個違規樣本——(a) 移除 helper 呼叫 → 正向 fail；(b) 加回舊內聯 → 負向 fail。兩者都 FAIL 才算有效。

## Pattern 2 — Count-evasion guards（living constant）

**Problem**：guard 把預期數量 hard-code 進 README/斷言（如 `expect(count).toBe(15)`），加新 guard 時數量變 16 → guard 壞，除非同時改兩處。ee7637a945f3 實證 G14 因 hard-code count 而 drift。

**Rule**：[MUST] 把預期數量視為 living constant——改 guard 數量時，**同一 commit** 更新 (a) guard 的斷言值 (b) README/文檔引用的數字。[NEVER] 用 hard-code 數字當唯一真源；優先用「不少於上一次」的相對斷言（`>= baseline`）或「與 registry 對齊」的衍生斷言。

## Pattern 3 — AND-composite guards（多條件才算違規）

**Problem**：架構鐵則如「分析邏輯只在 Worker pipeline」是 prose，單一條件 guard（只驗「呼叫分析 helper」）會誤判允許的 CLI demo；只驗「寫 D1」會誤判允許的純 backfill。dev-brain `87e9a0843dbf`。

**Rule**：違規 = 多個條件的 AND。guard [MUST] 只在**所有條件同時成立**時 fail。

```typescript
it('D##: no analysis-logic leak from scripts/ into D1', () => {
  const violations = globSync('scripts/**/*.mjs').filter(f => {
    const c = readFileSync(f, 'utf-8');
    const callsAnalysis = /buildSystemPrompt|parseAnalysis|analyzeReview|composeReply/.test(c);
    const writesD1 = /d1\(|api\.cloudflare\.com.*d1|UPDATE\s+\w+\s+SET|INSERT\s+INTO/i.test(c);
    return callsAnalysis && writesD1;   // AND — 單獨一項不構成違規
  });
  expect(violations, `scripts doing analysis→D1:\n${violations.join('\n')}`).toHaveLength(0);
});
```

**決策閘門**：[MUST] 在人類決定既有違規腳本的去留（migrate vs allowlist）之後才 instantiate，否則 CI 無解。

## Pattern 4 — Coverage Honesty（guard 自己別 false-PASS）

**Problem**：guard 的 regex 只覆蓋「範本裡見過的呼叫形式」，對專案**真實**建構 silently PASS，把 bug 藏住。三個實證變體（皆 getkm fe4f344889c8 / 9d864a1dd5b8）：

| 變體 | 症狀 | 修正 |
|---|---|---|
| 副檔名不全 | secret guard 只掃 `.ts` → live Slack token 藏在 `scripts/*.py` 出貨 | regex 掃**repo 實際使用的全部原始副檔名**（列舉或 `globby` 取並集） |
| 呼叫形式不全 | raw-SQL guard 只掃 `db.execute(` → 漏掉 3 處 `db.prepare(` | 同時掃所有 raw-SQL 進入點：`db.execute(`/`db.prepare(`/`sql.raw(`/`` `sql` `` ` `` |
| 路徑恆 skip | guard 用裸相對路徑讀 artifact，monorepo 子套件 cwd 讓 `existsSync` 恆 false → 永遠 `warn('skip')` 永遠 PASS | 一律 `resolve(ROOT, ...)`；任何 `skip/return` 分支 [MUST] 附「artifact 確實存在」的反向證明 |

**Rule**：

1. 寫掃描型 guard 前，先 `grep -rE` 列出該構造在專案中的**所有**出現形式與副檔名，regex [MUST] 覆蓋全集合，[NEVER] 只抄範本。
2. 信任任何 budget/zero PASS 前，[MUST] 以**獨立** grep 對照 guard regex vs 實際建構（不在同一個測試裡自證）。
3. guard 含 `if (!artifact) { warn('skip'); return; }` 時 [MUST] 構造反向測試：暫時植入違規樣本 → guard FAIL（證明它真的在跑，不是恆 skip）。
4. anti-phantom / meta guard [MUST] 用 ROOT 絕對路徑 + 自我登記（否則它就是自己要抓的 phantom）。

**非 vacuous 證明**：[MUST] 驗三場景——(a) 範本形式存在 → 0 hit；(b) 範本外的真實違規形式 → 1 hit（證明覆蓋面夠）；(c) artifact 抽走 → guard FAIL 或如實 skip-with-reason（證明不是恆 PASS）。

## Pattern 5 — Test Isolation Tier（測試不污染 prod / 不遮蔽回歸）

**Problem**：兩個結構性相反的污染，都讓 `npm test` 的綠燈不可信（getkm 82b62eec0d2c / 27ee0322c49c）：

| 變體 | 症狀 | 修正 |
|---|---|---|
| 寫真實 FS path | 被測模組用 module-global 常數寫 `logs/x.log`；測試透過 scheduler 間接觸發 → 把 fixture 寫進**生產** log 檔 | 在 `conftest`（或 vitest setup）的 **autouse** isolation fixture 把該 module 常數重導到 per-test `tmp` path——涵蓋**所有** transitive caller，不是只改「擁有」該 feature 的那支測試 |
| 讀真實 DB/外部服務 | 整合測試直連 live Postgres，紅綠隨當下資料狀態走（NULL score、採集中斷）→ 遮蔽真正 code 回歸 | 用 marker/label 分 tier：`integration`/`live_db` 預設從 `make test` 排除（ini `addopts -m "not live_db"`）；新增 `make test-live` 用 CLI `-m live_db` 覆蓋。**總測試數不變**（只分 tier，[NEVER] 刪測試 fake green） |

**Rule**：

1. 被測程式碼若透過 module-global 寫真實 FS path，隔離 [MUST] 放在全域 setup（涵蓋 transitive caller），[NEVER] 只在 feature 自己的測試檔重導。
2. 觸及真實 DB / 外部服務 / 資料狀態相依的測試 [MUST] 標 marker tier，預設排除出 `make test` / CI 的 code-regression lane。
3. [NEVER] 用 `xfail` / patch assertion / 刪測試製造靜默綠——tier 內仍真實斷言；生根因（缺資料等）誠實列 carry-over。
4. 找污染源：把每支測試檔**個別**對 truncate 後的 log/DB 跑，bisect 出真正的 polluter（不是「看起來擁有該 feature」的那支）。
