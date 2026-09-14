# BUILD-PLAN — Pages 資源名稱修正 + 用量示警改預估比例

> tier: **major**（>5 檔：cfResources/cfDetail/api/layout/dashboard/cfUsage + 3 測試檔）— 02-BUILD-SPEC §1.5

THINK:
1. ROOT CAUSE:     ①Pages 名稱錯誤：scriptName `pages-worker--14766800-production` 被解析成
                   「project 叫 pages-worker」並自造 `https://pages-worker.pages.dev` 連結。
                   2026-09-14 live 實證（paipeter 帳號）：`pages-worker` 是 CF 內部通用
                   Functions worker 名；8 位數字不存在於任何 REST 面（pages/projects、
                   deployments、workers/scripts 全 grep 無命中）；pages dataset 維度只有
                   scriptName（無 projectName）；wkr dataset 也不含 Pages project 真名。
                   → API 無法反查所屬 project，連結純屬虛構，且同帳號多個 project 全部
                   顯示成同名「pages-worker（production）」。
                   ②示警邏輯：poller 的 Slack 警報（classifyMetric）早就有燃燒速率預估
                   變體（2026-09-11），但 dashboard 卡片（bar 顏色 ≥60/≥80、amber chip、
                   排序）只看「已用量/配額」原始比例——台北清晨爆燒（如 photo 當日 01:00Z
                   已預估 >100%）在 dashboard 上完全沒有視覺警示，要等到實際比例過 60%
                   才變色。
2. CORRECT LAYER:  ①cfResources 解析層（移除虛構 URL，名稱加內部編號區分列）
                   ②cfUsage 聚合層 + dashboard 視圖層（effective ratio = max(實際, 預估)）。
3. AFFECTED FILES: src/services/cfResources.ts、src/views/cfDetail.ts、src/routes/api.ts、
                   src/views/layout.ts、src/views/dashboard.ts、src/services/cfUsage.ts、
                   tests/{cfResources,dashboard,api}.test.ts。爆破半徑：API 消費者失去
                   pages items 的 url 欄位（該欄位值本來就是錯的）；D1/KV 名稱解析不變。
4. ASSUMPTIONS:    最可能錯的：「數字無法映射」這個否定結論——已用四個獨立面實證
                   （projects/deployments/workers scripts/GraphQL 維度），今日最強可得證據。
5. SIMPLER PATH:   兩者都是最小改動：①拆掉 parse+URL、名稱帶 #編號；②一個 Math.max。
6. RISK:           移除 url 欄位是 API contract 變更——但現有值是錯的，越早拆越好；
                   預估比例著色：projected_eod 僅 counter 且 elapsed≥30min 才有值，
                   gauge（R2）不受影響。Rollback = git revert。
7. VERDICT:        PROCEED

## User Story

**As a** 操作者,
**I want** 明細的 Pages 列顯示可區分且誠實的名稱（不虛構連結）,
**so that** 我不會點進錯誤網站、能對照各 project 的用量。
**And I want** 卡片在「燃燒速率預估將超標」時就變色/計入警示,
**so that** 台北清晨的爆燒不會等到實際 60% 才被看到。

### Acceptance Criteria

1. AC1：Pages 列顯示 `pages-worker #<8位數>（production|preview）`；非此格式回退原始值；**無任何 pages.dev 連結**；HTML/API 不再出現 `pages-worker.pages.dev`。
2. AC2：dashboard bar 顏色、amber chip（N 項 ≥60%）、卡片排序改用 effective ratio = max(實際比例, projected_eod/配額)；列印數值與 bar 寬度仍為實際值（預估以既有 ⚠/斑馬紋標示）。
3. AC3：make ci 全綠（含新增回歸測試：低實際% + 高預估% → danger 色 + chip + 排序優先）。

## 變更檔案

| # | 檔案 | 變更 |
|---|---|---|
| 1 | src/services/cfResources.ts | 移除 parsePagesName/url；新 parsePagesTag → `pages-worker #N（env）`；header 註記實證 |
| 2 | src/views/cfDetail.ts | 名稱格移除 <a> |
| 3 | src/routes/api.ts | items 移除 url |
| 4 | src/views/layout.ts | 移除 `.cf-res-name a` CSS |
| 5 | src/services/cfUsage.ts | getTodayCfUsage：warnCount/maxRatio 用 effective ratio |
| 6 | src/views/dashboard.ts | CfMetricLine 著色用 effective pct；chip title 註明含預估 |
| 7 | tests×3 | 更新 pages 斷言；新增預警示警測試 |
