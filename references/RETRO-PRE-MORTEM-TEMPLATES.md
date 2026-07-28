# RETRO-PRE-MORTEM-TEMPLATES — 回顧與事前驗屍模板（D30 / D31）

> 擴充 `references/REFLECT-TEMPLATE.md`（D20）與 `06-REFLECT.md` §3/§4。
> D30 retro 由 REFLECT guard 家族驗證；D31 pre-mortem 為 hardening/release 前置 artifact。

---

## A. RETRO 格式（D30，擴充 REFLECT）

> 每個 cycle / session-end [MUST] 產出一份 retro（Start/Stop/Continue **或** 4Ls **或** Sailboat）+ ≤3 個 prioritized action items。

### 格式選一（[MUST] 三選一，不可混用）

#### A1. Start / Stop / Continue

- **Start**：下個 cycle 應開始做什麼（新行為）
- **Stop**：應停止做什麼（有害行為）
- **Continue**：應繼續做什麼（有效行為）

#### A2. 4Ls（Liked / Learned / Lacked / Longed For）

- **Liked**：本 cycle 正面體驗
- ** Learned**：學到的
- **Lacked**：欠缺的
- **Longed For**：渴望但未發生的

#### A3. Sailboat（Wind / Anchor / Rocks / Island）

- **Wind**：推進我們的力量
- **Anchor**：拖住我們的
- **Rocks**：風險
- **Island**：目標

### 共通後處理（[MUST]）

1. **主題歸類**：把原始 feedback 歸入 themes，標註 sentiment（正/負/中）。
2. **Action items**（[MUST] ≤3 個）：超過 3 個做不完。每個 [MUST]：
   - **specific**（具體，非「改善溝通」）
   - **assignable**（有 owner）
   - **measurable**（有 success metric）
3. **Carry-over 追蹤**（[MUST]）：引用上一份 retro 的 action items 狀態（done / carry / dropped）。

### Retro block 模板（寫入 REFLECT.md 或 RETRO.md）

```markdown
## RETRO — [DATE] / [cycle or session]

Format: Start/Stop/Continue | 4Ls | Sailboat（標明用哪個）

[Raw feedback grouped into themes with sentiment]

### Action Items (≤3)
1. [AI-1] <action> | owner: <name> | deadline: <date> | success metric: <metric> | carry-from: <prior AI-# or none>
2. [AI-2] ...
3. [AI-3] ...

### Carry-over from prior retro
- <prior AI-#>: done / carry / dropped — <note>
```

### D30 驗證條件（guard）

1. retro block 存在（含 format 標示）。
2. ≥1 個 action item，且每個 action item [MUST] 含 owner + deadline（success metric 強烈建議，缺則標 MEDIUM finding）。
3. carry-over 段存在（即使是「無前次 retro」也要註明）。

未通過 → D30 fail（augment D20）。

---

## B. PRE-MORTEM 格式（D31）

> 主要 release 或 hardening cycle **前** [MUST] 跑一次 pre-mortem。
> 想像：14 天後 launch 失敗了，往回推 — 哪裡出錯？

### 3 類風險（[MUST] 分類）

- **Tigers**（老虎）：基於證據的真實風險，需要 action。
- **Paper Tigers**（紙老虎）：表面成立但被誇大的擔憂，記錄以對齊認知（不需 action）。
- **Elephants**（大象）：未說出口 / 未驗證的疑慮，需要調查。

> **不確定時預設為 Tiger**（[MUST]）— 高估風險比低估安全。

### Tigers 分類（[MUST]）

| 類別 | 意義 | 處理 |
|---|---|---|
| **launch-blocking** | 解決前不能上線 | launch 前必修 |
| **fast-follow** | 上線後 ≤30 天內修 | 排入下個 cycle |
| **track** | 監控即可 | 設監控點，不阻塞 |

每條 **launch-blocking** Tiger [MUST] 含：
- **risk**：具體風險描述
- **mitigation**：緩解措施
- **owner**：負責人
- **date**：完成日期

### PreMortem artifact 模板

```markdown
## PRE-MORTEM — [DATE] / [release or hardening cycle]

Scenario: 14 天後 launch 失敗了。往回推，哪裡出錯？

### Tigers（real risks — need action）
| # | Risk | Evidence | Class | Mitigation | Owner | Date |
|---|------|----------|-------|------------|-------|------|
| T1 | <risk> | <evidence> | launch-blocking | <mitigation> | <owner> | <date> |
| T2 | <risk> | <evidence> | fast-follow | <mitigation> | <owner> | <date> |
| T3 | <risk> | <evidence> | track | <monitor point> | — | — |

### Paper Tigers（overblown — document to align）
- <concern>: 為何被誇大 — <reasoning>

### Elephants（unspoken — investigate）
- <unspoken concern>: 需調查 — <next probe>

### Summary
- launch-blocking Tigers: N（[MUST] 全部有 mitigation+owner+date 才能 launch）
- fast-follow Tigers: N
- track Tigers: N
```

### D31 驗證條件（guard）

1. release/harden commit 前 [MUST] 有 PreMortem artifact。
2. 每條 launch-blocking Tiger [MUST] 含 mitigation + owner + date。
3. 缺漏 → D31 fail → [NEVER] 進行 release/harden。

---

## 與既有 REFLECT-TEMPLATE 的關係

- 本檔**補充** `references/REFLECT-TEMPLATE.md`（Quick Check R1–R5 + Full Audit F1–F2），不取代。
- retro block 可嵌入 REFLECT.md 的 F 段之後，或獨立 RETRO.md。
- pre-mortem 為獨立 artifact，通常與 release/hardening plan 同目錄。
