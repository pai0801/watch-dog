# DEPLOYMENT-TEMPLATE — 系統部署與維運文件模板（Cloudflare Stack）

> 對應 **D35（Deployment & Operations Doc，artifact）**。
> 本模板是 `/documentation/deployment.md`（或 `docs/DEPLOYMENT.md`）的骨架。
> 目的：**交接**——接手者能部署、回滾、排障，而不需口頭知識。
> [MUST] 反映**現狀（IS）**，[NEVER] 記錄不存在的部署步驟或過時指令（由 D16 code-path + D35 section 檢查雙重保證）。

---

## 為何需要（Why）

交接斷層的主因不是缺架構文件，而是缺「**怎麼把東西送上去、壞了怎麼退**」的維運文件。
架構文件回答「系統長怎樣」；**deployment.md 回答「怎麼操作它」**。兩者 [MUST] 並存。

---

## D35 必填 section 清單

> D35 validator 檢查 `deployment.md` **存在**且含以下每個 heading（`##` 層級，標題文字可微調但語意 [MUST] 等價）。
> 缺任一 → D35 fail → 07 Phase D 不過 → [NEVER] 宣告 COMPLETE。

| # | Section heading（建議） | 內容 | 為何強制 |
|---|---|---|---|
| 1 | `## 環境矩陣` | dev / preview / prod 三欄：帳號、綁定（D1/KV/R2/Workers）、URL、隔離方式 | 交接者要知道每個 env 連到哪 |
| 2 | `## 部署指令` | 每個 env 的精確指令（`npm run deploy` / `wrangler deploy` / `wrangler pages deploy` / `./scripts/ship.sh <env>`）| 指令 [MUST] 真實可執行（D16 驗路徑） |
| 3 | `## Secrets 與變數` | 全部 secret/變數清單，交叉引用 `/documentation/variables.md`；標 rotation policy | secret 漏一個 = 部署後 broken |
| 4 | `## Migration 順序` | D1 schema migration 的**執行順序**與**部署前/後**時機 | migration 跑錯序 = 資料壞 |
| 5 | `## 回滾程序` | 每個 deploy 的回滾步驟（wrangler rollback / prev pages deployment / migration backout）| 壞了要能退 |
| 6 | `## 部署後驗證` | smoke test 清單：deploy 後 [MUST] 跑的 endpoint / 功能核對 | 部署成功 ≠ 上線成功 |
| 7 | `## 維運 Runbook` | 常見 ops 任務：排障、手動 cron、KV 清快取、R2 清理、log 查詢 | 日常運作靠這份 |

---

## 模板骨架（複製到 `/documentation/deployment.md` 後填入）

```markdown
# Deployment & Operations — <專案名>

> Last verified: <YYYY-MM-DD / cycle ref>（D36 README parity 也讀此欄位）

## 環境矩陣

| 環境 | 帳號 | D1 | KV | R2 | URL | 隔離 |
|---|---|---|---|---|---|---|
| dev | <帳號> | <binding> | <ns id> | <bucket> | <url> | <獨立帳號/共用> |
| preview | ... | ... | ... | ... | ... | ... |
| prod | ... | ... | ... | ... | ... | ... |

## 部署指令

# dev
<指令>

# preview
<指令>

# prod
<指令>（見全域 CLAUDE.md Deploy Policy：直接部署允許；ship.sh 為可選保險）

## Secrets 與變數

| 名稱 | 用途 | scope | rotation | 設定指令 |
|---|---|---|---|---|
| <NAME> | <用途> | server | <policy> | `wrangler secret put <NAME>` |

[MUST] 與 `/documentation/variables.md` 交叉一致。

## Migration 順序

1. <migration 檔>（部署**前**）
2. <migration 檔>（部署**後**）

[MUST] migration 先行於 worker deploy（見 01 §migration 規範）。

## 回滾程序

# Worker
wrangler rollback

# Pages
<prev deployment 的回滾指令>

# Migration backout
<步驟或標註「向前相容，不回滾」理由>

## 部署後驗證

- [ ] <smoke endpoint 回 200>
- [ ] <關鍵流程手動跑一次>
- [ ] <cron / scheduled handler 最近一次成功>

## 維運 Runbook

- 排障：<dashboard / log 位置>
- 手動觸發 cron：<指令>
- 清快取：<KV/R2 指令>
```

---

## 與其他 guard 的關係

- **D16**：deployment.md 內引用的每個檔案路徑/binding [MUST] 存在。
- **D26**：deployment.md 是第 6 份**強制**維運文件（不在 D26 的 5 份核心**邏輯**文件集內，而是 ops 文件；兩者並列）。
- **D29**：ship-check gate [MUST] 參考本檔的「部署後驗證」清單。
- **D36**：README [MUST] 連結到本檔（交接入口）。
