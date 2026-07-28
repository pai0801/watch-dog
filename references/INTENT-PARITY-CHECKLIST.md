# INTENT-PARITY-CHECKLIST — Intended-vs-Implemented 方法（D27）

> 對應 `03-DOC-AND-CODE-REVIEW.md` Phase 3。
> 由 **D27 guard** 驗證：每條 documented rule [MUST] 有 code enforcement cite 或被記為 finding。

## 目的

把 `/documentation/*.md`（permissions.md / flows.md 等）視為**待驗證的 claim**，逐條對照程式碼實作。
[NEVER] 假設文檔對、[NEVER] 假設程式碼對 — 兩邊必須 parity，否則記 finding。

---

## 方法（5 步，[MUST] 依序）

### Step 1: 建立意圖（Establish intent）

[MUST] 讀 `/documentation/permissions.md` 與 `/documentation/flows.md`，把每一條規則當作 claim 列出：
「規則 X 聲稱：actor A 對 resource R 的 operation O 應被 deny。」

### Step 2: 收集實作證據（Gather implementation evidence）

[MUST] 為每條 claim 找到一個 code enforcement point：`file:line`。
- **「handled upstream」不是證據**（[NEVER] 接受）— [MUST] 往上追到實際的 check。
- **「internal only」/「admin only」/「validated elsewhere」註解不是證據**（[NEVER] 接受）— [MUST] 在程式碼驗證。

### Step 3: 逐邊界比對 claim → code（Compare one boundary at a time）

[MUST] 一次比對一個邊界（一條 rule × 一個 resource × 一個 actor），確認：
- 文檔說的 deny case，程式碼真的會 deny 嗎？
- 程式碼的 check 真的對應文檔描述的 resource/role/scope 嗎？

### Step 4: 依「是否重要」分類 mismatch

[MUST] 只在跨越邊界**會讓真實 actor 接觸到 data / money / infra / 另一個 tenant** 時視為重要：
- 重要 → 記為 finding（Step 5）
- 表面漂移（cosmetic drift，命名不一致等）→ drop，[NEVER] 記為 finding 製造噪音

### Step 5: 無含糊 finding（No hand-wavy findings）

每條 finding [MUST] 含 4 個欄位，缺一不可：

```
FINDING:
  Documented intent:  <quote from /documentation/*.md>
  Implemented reality: <file:line code cite，實際行為>
  Attacker & victim:  <誰能利用、受害者是誰>
  Concrete fix:       <具體修法，指向某個 guard 或程式碼變更>
```

[NEVER] 捏造意圖（fabricate intent）— 若文檔沒寫，就標「文檔未記載此邊界」（這本身是 missing-doc finding）。

---

## Finding 來源（與既有流程銜接）

- finding [MUST] 寫入 `TODO-REVIEW.md`，分類優先級（Critical/High/Medium）。
- 若 finding 指向缺 guard → 饋入 `04-HARDENING_PROTOCOL.md` §2（D1–D12 + 新 guard）。
- 若 finding 指向文檔過時 → 更新 `/documentation/*.md`（03 Phase 4 / D26）。

---

## D27 驗證條件（guard）

下游 `workers/tests/guards.test.ts` 實作：

1. 對 `/documentation/permissions.md` 與 `/documentation/flows.md` 中每條 rule，[MUST] 有一個 code cite（`file:line`）或一條對應 finding（在 TODO-REVIEW.md）。
2. [NEVER] 有 rule 靜默未被驗證（silent unverified）。
3. 每條 finding [MUST] 含 4 欄位（intent quote / reality cite / attacker&victim / fix）。

未通過 → D27 fail → 03 Phase 3 不過。

---

## 與 D17 / D18 的關係

- **D17** 驗 fix 有 guard（CHANGELOG lock-tag）。
- **D18** 驗每條 [MUST] section 有登記。
- **D27** 驗每條 **documented rule** 有 code enforcement 或 honest finding — 補的是「文檔 ↔ 程式碼」這條軸，前兩者不覆蓋。
