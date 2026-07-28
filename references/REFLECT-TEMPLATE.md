# REFLECT — Template（Cloudflare Stack）

> 對應 `06-REFLECT.md` §3/§4/§5，由 **D20 guard** 驗證。
> 每個觸發點（end-of-session / pre-commit / post-task / phase transition）[MUST] 產一份 reflection。
> D20 檢查：本 cycle/session 有 REFLECT.md，R1–R5 各段非空、無裸 `N/A` 逃避。

## 快速自審（Quick Check，≤2 min，end-of-session）

```
### R1 [MUST] Directives
本 session 是否違反 01–05 任何 [MUST]？
  □ 否 → 繼續
  □ 是 → 逐條列出 + 原因：<...>

### R2 [NEVER] Directives
是否觸發任何 [NEVER]（--no-verify / force-push / 跳 THINK / 吞 lint）？
  □ 否
  □ 是 → <...>

### R3 Artifact 完整
FIX-LOG / REFLECT / CHANGELOG lock-tag 是否齊全？（D17/D19/D20）
  □ 是  □ 否 → 缺什麼：<...>

### R4 驗證證據
宣稱「完成」前是否跑過 build/lint/test 並讀過輸出？
  □ 是（貼結果摘要）  □ 否 → 為何：<...>

### R5 經驗記錄
本 session 是否該 putkm 一條經驗？（非平凡問題/防禦模式）
  □ 否  □ 是 → 已記錄 id：<...>
```

## 完整稽核（Full Audit，≤5 min，pre-commit / post-task）

R1–R5 之外另加：

```
### F1 Constitution Compliance
01-CLAUDE 各章節遵守狀況（逐一點名觸及的章節）：<...>

### F2 矯正行動（Corrective Action）
若 R1/R2 發現違反：
  - 違反項：<...>
  - 根本原因（why ≥2x）：<...>
  - 補 guard / 補 artifact：<...>（對應 D##）
  - 是否需加 Human Queue：<...>
```

## 反模式（[NEVER]，D20 會抓裸 N/A）

- 裸 `N/A`、`無`、`略` 而無理由 → fail。
- 批次 reflection（一次覆蓋多 session）→ fail（06 §1 [NEVER] batch）。
- 「任務太小所以跳過」→ fail（06 §0 [NEVER]）。
