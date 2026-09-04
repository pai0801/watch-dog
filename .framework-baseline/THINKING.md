# THINKING — 思考模板（Cloudflare Stack）

> 任何程式碼之前，[MUST] 輸出 THINK block。
> 遇到 BUG → [MUST] 先遵循 `05-FIX-SPEC.md` 修復流程。

---

## THINK Block（強制）

```
THINK:
1. ROOT CAUSE:     （根本原因，不是表面症狀。問「為什麼」至少兩次）
2. CORRECT LAYER:  （R2 Data / D1 / API Route / Component / i18n / CSS / Config）
3. AFFECTED FILES: （會動到哪些檔案，爆破半徑多大）
4. ASSUMPTIONS:    （這次修改依賴哪些假設？哪個最可能錯？）
5. SIMPLER PATH:   （有沒有更簡單的做法？能不能只改一行？）
6. RISK:           （改壞了最嚴重的後果？能不能 rollback）
7. VERDICT:        PROCEED / STOP（架構有問題則 STOP，先修架構）
```

---

## 規則

- **VERDICT 為 STOP → [NEVER] 寫程式碼。先修架構，再重來。**
- **SIMPLER PATH 有明確答案 → [MUST] 優先採用最簡單的路。**
- **ASSUMPTIONS 最可能錯的假設 → [MUST] 先驗證再繼續。**
- [NEVER] 因為「改動很小」就省略 THINK block。
- [MUST] THINK block 輸出後才開始寫程式碼，不可事後補寫。
