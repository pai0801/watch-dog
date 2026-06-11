**任何程式碼之前，必須輸出 THINK block：**

```
THINK:
1. ROOT CAUSE:     （根本原因，不是表面症狀。問「為什麼」至少兩次）
2. CORRECT LAYER:  （應該在哪一層修：DB / Worker / Config / API / UI / Infra）
3. AFFECTED FILES: （會動到哪些檔案，爆破半徑多大）
4. ASSUMPTIONS:    （這次修改依賴哪些假設？哪個最可能錯？）
5. SIMPLER PATH:   （有沒有更簡單的做法？能不能只改一行？）
6. RISK:           （改壞了最嚴重的後果？能不能 rollback）
7. VERDICT:        PROCEED / STOP（架構有問題則 STOP，先修架構）
```

**VERDICT 為 STOP → 不寫程式碼。先修架構，再重來。**
**SIMPLER PATH 有明確答案 → 優先採用最簡單的路。**

如果遇到 BUG，請先去看該專案的修復流程文檔（FIX.md / 05-FIX-SPEC.md）。
