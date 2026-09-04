# FIX-SPEC — 修復與小功能規範（Cloudflare Stack）

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。

> 適用於 bug fix、hotfix、小功能。大型功能請遵循 `02-BUILD-SPEC.md`。
> **適用 tier 由 `02-BUILD-SPEC.md §1.5` 決定**：trivial 走本檔輕量流程，standard/major 走 02 完整流程。
> [NEVER] 因為「只是小改」就跳過流程；[NEVER] 自行降級 tier 規避 gate。

---

## 1 — [MUST] 目標記錄

動手前 [MUST] 寫下：

```
FIX-PLAN:
tier:    trivial | standard | major   ← 見 02-BUILD-SPEC.md §1.5；判定有疑義取較嚴
目標:    （要修什麼 / 做什麼小功能）
類型:    bugfix | cleanup   ← 選填，預設 bugfix；cleanup 觸發 §3.5 four-pass
原因:    （為什麼需要）
預期結果: （完成後應該看到什麼）
範圍:    （會動到哪些檔案）
```

**[MUST] 此 FIX-PLAN 寫入 `FIX-LOG.md`（artifact）**，模板見 `references/FIX-LOG-TEMPLATE.md`。
由 **D19 guard** 驗證：CHANGELOG 最新 cycle 的每條 fix bullet 都有對應的 FIX-LOG entry，
四欄位齊全 + 驗證四重奏（§4）有紀錄。缺 entry 或缺欄位 → D19 fail。

---

## 2 — [MUST] 經驗查詢（getkm）

[MUST] 在分析前呼叫 `getkm`，用問題描述搜尋過往經驗。

- 有相關結果 → [MUST] 納入 THINK block 分析，避免重蹈覆轍
- 無相關結果 → 正常繼續

---

## 3 — [MUST] THINK Block

遵循 `THINKING.md` 的 7 欄位模板。[MUST] 使用完整版，[NEVER] 省略欄位。

VERDICT 為 STOP → [NEVER] 寫程式碼，先修架構。

> **THINK block 為 artifact**，由 **D21 guard** 驗證：tier ≥ standard（見 `02-BUILD-SPEC.md §1.5`）
> [MUST] 在 FIX-LOG 引用一個 THINK block。trivial 豁免（見 02 §1.5）。

---

## 3.5 — [MUST] 執行分支（bugfix vs cleanup）

§1 FIX-PLAN 的 `類型` 決定執行路徑：

- **`bugfix`**（預設）→ 直接修復：依 §3 THINK 結論改最小程式碼，[NEVER] 越出 §1 範圍。
- **`cleanup`**（deslop / 清理型修復）→ [MUST] 走本節的**分類 + four-pass**，[NEVER] 跳過直接動手。

### 清理型 [MUST] 紀律

- [MUST] **行為鎖定先行**：動手前先補或跑涵蓋現有行為的最小回歸測試（Vitest）；無法測先行則 [MUST] 先在 FIX-LOG 寫下驗證計畫再動程式碼。
- [MUST] **刪除優先於新增**：先刪死碼，再考慮收斂；[NEVER] 借清理之名新增 dependency、wrapper 或抽象層。
- [MUST] **重用優先**：先採既有 utility / pattern；[NEVER] 引入新 dependency 除非使用者明確要求。
- [MUST] **範圍閉鎖**：只動 §1 範圍內檔案；[NEVER] 靜默擴大到無關清理。爆破半徑 > 10 檔 → [MUST] STOP（04 §6）。
- [MUST] **diff 小、可逆、smell 聚焦**：每個 edit set 只處理一種 smell；[NEVER] 把無關 refactor 綁進同一次編輯。

### Slop 分類表（動手前 [MUST] 逐項標記本 cycle 要清的 smell）

| 類別 | 特徵 |
|---|---|
| **Duplication 重複** | 重複邏輯、copy-paste 分支、多餘 helper |
| **Dead code 死碼** | 未使用、不可達分支、過時 flag、debug 殘留 |
| **Needless abstraction 過度抽象** | pass-through wrapper、投機性間接層、單一用途 helper 層 |
| **Boundary violation 邊界違規** | 隱藏耦合、職責錯置、跨層 import 或副作用（如 Component 直讀 D1/R2） |
| **Missing test 測試缺口** | 行為未鎖定、回歸覆蓋弱、邊界案例缺失 |

> Missing test 同時是 smell 與清理前提：列為 smell 時 [MUST] 在 Pass 0 先補，[NEVER] 只標不補。

### Four-pass 執行順序（每個 pass 後 [MUST] 重跑 §4 驗證相關子集）

| Pass | 動作 | 完成信號 |
|---|---|---|
| **Pass 0** | 鎖行為：補 / 跑最小回歸測試 | 現有行為被測試覆蓋 |
| **Pass 1** | Dead code 刪除 | 無未使用 export / 不可達分支 |
| **Pass 2** | Duplication 收斂 | 重複邏輯合併為單一來源 |
| **Pass 3** | Naming / error-handling 清理 | 命名一致、catch 不靜默吞錯 |
| **Pass 4** | Test 補強 | 邊界案例覆蓋、回歸密度提升 |

- [MUST] 由安全（Pass 1 刪除）排到風險高（Pass 2 收斂）；[NEVER] 顛倒。
- [MUST] 每個 pass 後跑 §4 對應驗證（至少 `tsc --noEmit` + 受影響測試）；任一 fail → [MUST] STOP 回退該 pass。
- [MUST] 清理完成在 FIX-LOG 記錄：smell 分類結果 + 各 pass 變更摘要 + 行為鎖定證據（由 D19 FIX-LOG 承載）。

---

## 4 — 修復與驗證

修復完成後 [MUST] 依序執行：

```bash
./node_modules/.bin/tsc --noEmit   # [MUST] 0 errors（[NEVER] npx tsc，見 02 §4）
npm run lint         # [MUST] 0 errors, 0 warnings
npm test             # [MUST] all pass, count >= 修改前
npm run build        # [MUST] success
```

任何一項失敗 → [MUST] STOP，貼出錯誤，修復後重跑。

> **[NEVER] 把驗證指令 pipe 進 `tail`/`head`/`grep`**——shell 回傳 `tail` 的 exit code（0），不是 tsc/lint/test/build 的，會把失敗讀成通過。修法見 02 §4（寫檔捕捉 exit / `set -o pipefail` / 包成 guard）。（getkm c5fc0c002584 / 4526bee5e18b）

---

## 5 — [MUST] 自審清單

所有項目 [MUST] 全部通過才能標記完成：

| # | 標準 | 狀態 |
|---|------|------|
| 1 | TypeScript 零錯誤 | ✅/❌ |
| 2 | 測試全過 | ✅/❌ (N passed) |
| 3 | Lint 乾淨 | ✅/❌ |
| 4 | Build 成功 | ✅/❌ |
| 5 | 無新增 TODO/FIXME | ✅/❌ |
| 6 | 未動到範圍外檔案 | ✅/❌ |
| 7 | 達到設計目的 | ✅/❌ |
| 8 | 安全性無退化 | ✅/❌ |

審核全部 ✅ 後，[MUST] 輸出完成摘要：改了什麼檔案、改了什麼、新增了什麼測試。

---

## 6 — [MUST] 經驗記錄（putkm）

驗證通過後 [MUST] 呼叫 `putkm`：

```
problem:  問題描述（症狀 + 根因）
solution: 解法（改了什麼、為什麼有效）
tags:     ["bugfix", "cloudflare", ...] （小寫、具體）
context:  專案 / 技術背景
```

[ALWAYS] 記錄。[NEVER] 覺得「太簡單」就跳過。未來的自己會感謝現在的你。

---

## 7 — 失敗處理

**任何失敗 [MUST] 停止，[NEVER] 跳過、[NEVER] 靜默忽略。**

- tsc 失敗 → 停，貼出 error
- Lint 失敗 → 停，貼出 error
- 測試失敗 → 停，貼出失敗的 test case
- Build 失敗 → 停，貼出 error

**3 次連續失敗：** 同一問題連續失敗 3 次 → [MUST] STOP 並報告（含完整錯誤日誌、3 次嘗試記錄、分析結論）。

---

## 禁止事項

遵守 `01-CLAUDE.md` 和 `02-BUILD-SPEC.md` 的所有禁令。特別強調：

- [NEVER] `as any`、raw SQL、空 catch
- [NEVER] `--no-verify`
- [NEVER] 提交 `.env` / credentials / secrets
- [NEVER] 靜默忽略錯誤
- [NEVER] Component 直接讀取 R2/D1（[MUST] 經過 service layer）
