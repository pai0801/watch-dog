# DERIVE-TESTS-MAP — tests.md 3 段格式（D28）

> 對應 `/documentation/tests.md`，由 `03-DOC-AND-CODE-REVIEW.md` Phase 4 產出。
> 由 **D28 guard** 驗證：tests.md 存在、含 3 個分離 section、每條 rule 帶 status。

## 目的

tests.md [MUST] 分 3 個**分離** section，避免讀起來「假綠」（看起來都有測，其實沒有）。
每條 documented rule 都 [MUST] 帶一個 status，讓覆蓋缺口無所遁形。

---

## 3 個 Section（[MUST] 分離，順序固定）

### Section 1: Existing coverage（repo 中**今天**就有的測試）

[MUST] 列出目前 repo 內已存在的測試，每個 [MUST] 綁到它所 pin 的 rule。

### Section 2: Proposed tests（尚未寫的測試）

[MUST] 列出待寫的測試，每個標 type：
- **automated unit**（單元）
- **automated integration**（整合）
- **guarded live**（CI 跑的 live guard）
- **manual review**（人工審查步驟）

### Section 3: Gaps（documented rule 但**無任何驗證**）

[MUST] 列出有文檔記載但完全沒驗證的 rule，按 exposure（暴露風險）排序。

---

## Row Schema（[MUST] 每列欄位）

```
use-case → rule → expected behavior(含 deny/negative case) → evidence source(doc + code) → status
```

| 欄位 | 說明 |
|---|---|
| **use-case** | 觸發場景（actor + action） |
| **rule** | 對應 /documentation/ 中的哪條 rule（permissions.md / flows.md） |
| **expected behavior** | 預期結果，[MUST] 含 deny / negative case（不只 happy path） |
| **evidence source** | 文檔 cite + 程式碼 cite（doc: section + code: file:line） |
| **status** | `existing` / `proposed` / `none` |

> deny case 不可省（[MUST]）：只寫 happy path 的測試地圖等於沒寫。

---

## CI-gating 標註（[MUST]）

[MUST] 在 Section 1 / 2 中標註哪些 check 是 **CI-required gating main**（merge 前必跑）。
非 gating 的測試標 `advisory`。

---

## tests.md 模板

```markdown
# tests.md

> 由 derive-tests 產出（03 Phase 4 / D28）。3 段分離，每條 rule 帶 status。

## Existing coverage
| use-case | rule | expected (incl. deny) | evidence (doc + code) | status | CI-gate |
|---|---|---|---|---|---|
| <uc> | permissions.md §X | allow A; deny B | doc §X + src/y.ts:42 | existing | gating-main |
| ... | | | | | |

## Proposed tests
| use-case | rule | expected (incl. deny) | evidence | status | type |
|---|---|---|---|---|---|
| <uc> | flows.md §Y | ... | ... | proposed | automated integration |
| ... | | | | | |

## Gaps
| use-case | rule | expected (incl. deny) | evidence | status | exposure |
|---|---|---|---|---|---|
| <uc> | permissions.md §Z | ... | doc only, no code | none | HIGH |
| ... | | | | | (ranked) |
```

---

## D28 驗證條件（guard）

下游 `workers/tests/guards.test.ts` 實作：

1. `/documentation/tests.md` 存在。
2. 含 3 個 heading：`## Existing coverage`、`## Proposed tests`、`## Gaps`（[MUST] 三者齊全）。
3. 每條 rule row（跨 3 section）[MUST] 有 `status` 欄且值為 `existing` / `proposed` / `none` 之一。
4. [NEVER] 有 rule row 缺 status（缺 = silent unverified）。

未通過 → D28 fail → 03 Phase 4 不過 → 07 Phase D 不過。

---

## 與其他 guard 的關係

- **D26** 驗 tests.md **存在**（5 核心之一）。
- **D28** 驗 tests.md **結構正確**（3 section + status）。
- **D27** 驗 permissions/flows rule 有 code cite 或 finding（更上游）。
- 三者共同確保「文檔聲稱的保護」與「實際驗證」之間沒有黑箱。
