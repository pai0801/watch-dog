# FIX-LOG — Template（Cloudflare Stack）

> 對應 `05-FIX-SPEC.md` §1/§4/§5，由 **D19 guard** 驗證。
> 每個 fix/hotfix/小功能動手前 [MUST] 在本檔 append 一個 entry；驗證完成後補上四重奏結果。
> D19 檢查：CHANGELOG 最新 cycle 的每條 fix bullet 都有對應的 FIX-LOG entry，四欄位齊全 + 四重奏有紀錄。

## Entry 格式

```markdown
### [YYYY-MM-DD] <一句話標題>

- **目標**: 要修什麼 / 做什麼小功能
- **類型**: bugfix | cleanup（選填，預設 bugfix；cleanup 走 05 §3.5 four-pass）
- **清理計畫**（cleanup [MUST]）: smell 分類 + four-pass 各 pass 摘要 + 行為鎖定證據
- **原因**: 為什麼需要
- **預期結果**: 完成後應該看到什麼（可驗證）
- **範圍**: 會動到哪些檔案
- **THINK block**: <引用，或貼 THINKING.md 7 欄位；非平凡變更 [MUST]，由 D21 驗>
- **驗證（四重奏）**:
  - [ ] `npx tsc --noEmit` → 0 errors
  - [ ] `npm run lint` → 0 errors, 0 warnings
  - [ ] `npm test` → all pass, count ≥ 修改前
  - [ ] `npm run build` → success
- **Lock tag**: `(locked: D##)` — 對應鎖定此 fix 類別的 guard
- **Human Queue 連動**: 若有未決項，記於 TODO-REVIEW.md 並標 HQ-id
```

## 豁免

- 純 typo / 單行修補：可省略 THINK block（D21 豁免），但其餘欄位仍 [MUST]。
- `(human: 理由)` 標記的 fix：D19 接受，但理由 [MUST] 具體。

## 範例

```markdown
### [2026-06-15] 修正 MBTI 文章 OG image 404

- **目標**: ogImageUrl 從 /og/mbti/article-${id}.png 改為 /og/mbti/${id}.png
- **原因**: 舊路徑無對應 endpoint，永遠 404，無 og:image
- **預期結果**: 文章頁 og:image 正確渲染，社群分享有圖
- **範圍**: src/pages/mbti/article/[slug].astro
- **THINK block**: （引用 BUILD-PLAN）
- **驗證**: tsc✓ lint✓ test 173✓ build 2950✓
- **Lock tag**: (locked: D14)
```
