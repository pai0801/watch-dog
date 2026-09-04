# AGENTS.md — 與 CLAUDE.md 同步維護的 agent 合約（SSoT = CLAUDE.md；改動 [MUST] 兩檔同步，[NEVER] 只改一邊）


被動式 dead-service 監控哨兵：受監服務每分鐘上報 pulse，**pulse 停了 = 服務死了**（非主動探活）；Cron 每分鐘掃描逾期 → Slack 警報。Hono 4 單一 Worker + D1（原生 prepared statements，無 ORM）。

## 專案不變式（改程式碼前必讀）

1. **fail-dead 語義**：偵測靠「收不到 pulse」——任何改動 [NEVER] 把語義換成主動健康檢查。
2. **單操作者系統、非多租戶**：部署 = 單一共享部署（單 Worker + 單 D1）；資料隔離 = per-project token scoping（`timingSafeEqual`），admin = Basic Auth 單操作者。標註見 `01-CLAUDE.md` §9。
3. **D1 原生 prepared statements**：SQL 一律靜態字面值 + `.bind()` 參數化（guard 鎖定：字串插值/拼接 SQL 預算 = 0）；無 Drizzle（`01-CLAUDE.md` §3 注記）。
4. **型別安全**：`as any` 預算 0（ESLint error + guard 雙鎖）；例外走 `eslint-disable` 註明理由。
5. **schema 真源 = `src/db.sql`**（`CREATE TABLE IF NOT EXISTS` 冪等；bootstrap.sh 據此建 local D1）。

## 文件索引（新 session 起手）

| 文件 | 內容 |
|---|---|
| `01-CLAUDE.md`…`07-ALL-IN-ONE.md` | Cloudflare Stack Framework 本地副本（已適配真實棧；merge-sync 更新） |
| `TODO-REVIEW.md` | 存量債清單（新舊債分流——[NEVER] build 裡順手重構） |
| `FIX-LOG.md` / `REFLECT.md` / `THINKING.md` | 修復記錄 / 反思 / 思考日誌（guard D19–D21 驗存在） |
| `.portability.toml` | 可重建 manifest 五段（[secrets] 合約真源） |
| `secrets-archive/SECRETS.md` | secret 清冊（域 A） |

## Dev 啟動

```bash
# 只啟動本地服務 (http://192.168.1.200:8789)
DEV_PORT=8789 ./dev-tunnel.sh

# 啟動 + ngrok tunnel
DEV_PORT=8789 ./dev-tunnel.sh ngrok

# 停止服務
./dev-tunnel.sh stop
```

### 環境

| 項目 | 值 |
|------|-----|
| **Port** | 8789 |
| **Network URL** | http://192.168.1.200:8789 |

## 專案資訊

- **GitHub**: git@github.com:paipeter0801/watch-dog.git

## Cloudflare Stack Framework

核心規則見本專案的 `01-CLAUDE.md` … `07-ALL-IN-ONE.md`（cp 自 `~/Code/rules/cloudflare/`，本地可調——§1 已調成真實棧 Hono/D1 無 Astro/Svelte、N/A 段落已標記）。guard 測試在 `tests/guards/`（portability §A–§M watch-dog 適配版 + framework D18–D21）；框架更新走 `~/Code/rules/scripts/sync-framework.sh <repo>`（merge-sync，[NEVER] 盲 cp）。

跨棧承重牆（[NEVER] 抄進本 repo，以路徑引用、讀了實作）：

- `~/Code/rules/09-PROJECT-PORTABILITY.md` — 可重建＋反鎖死（`.portability.toml` 五段＋`scripts/bootstrap.sh`＋`scripts/portability-smoke.sh`＋guard §A–§E/§K/§L/§M）
- `~/Code/rules/10-SECRETS-CONTRACT.md` — secret 權威＋雙層部署安全網（`[secrets]` 合約＋`assertBindings` Layer 2（`src/lib/bindings.ts`）＋`wrangler.jsonc secrets.required` Layer 1（需 wrangler ≥4.62 schema 支援）＋guard §F–§J）
- `~/Code/rules/11-MULTI-TENANT-READINESS.md` — 本專案非多租戶（invariant ②），遵循此底線而非 PLATFORM-CONTRACTS；標註在 `01-CLAUDE.md` §9（單一共享部署）
- `~/Code/rules/14-DESIGN-PRINCIPLES.md` — 模組化單體＋深模組（`02-BUILD-SPEC` §2.3 規劃階段引用 §0 兩問＋§2 四條；存量違反 → `TODO-REVIEW.md`）
- `~/Code/rules/ENGINEERING_GUIDE.md` — CI/CD 合約（見下）

## Engineering Contract

This project follows the shared ENGINEERING_GUIDE.md.
Read it before modifying CI/CD, Makefiles, or git hooks.

Absolute rules:
- NEVER use --no-verify on any git operation
- ALWAYS run make clean after CI
- ALWAYS check the version matrix before writing Python/Node code
- NEVER hardcode credentials or tokens in any file
- NEVER generate --force push to main/master under any circumstance

## Secrets 紀律（自包含模型）

- secret 合約真源＝`.portability.toml [secrets]`（名稱＋meta，[NEVER] 值）；值走域 A（`secrets-archive/env.7z` 加密進 git）↔ 域 B（`wrangler secret put`，值 [MUST] file-sourced，agent [NEVER] 經手明文值）。
- **[MUST] 加/改/刪任何 secret 後**：同步更新 `secrets-archive/SECRETS.md`（用途/來源/被誰用/換掉影響範圍/上次更換）＋ `bash secrets-archive/seal.sh` ＋ commit。
- master 密碼 `ENV_SECRET_PASS` 存密碼管理器（＋離線備份），[NEVER] hardcode 進任何 committed 檔。
- ⚠ **待辦**：`CLOUDFLARE_API_TOKEN` 曾於 `docs/plans/2026-02-02` 明文洩漏（已 redact）——操作者 [MUST] 於 CF dashboard 輪替，完成後更新 SECRETS.md 該列（詳 `FIX-LOG.md`）。

## 開發紀律

- 完成定義：`make ci` 全綠（tsc + ESLint + 測試雙 pool + §L/§M python guard）。`npm test` = app pool（workerd 全保真）+ guards pool。
- cron 偵測/警報邏輯改動必附測試（`tests/`）；D1 schema 變更同步 `src/db.sql`（冪等）。
- 部署前跑 `scripts/portability-smoke.sh`；fresh-clone 重建用 `scripts/bootstrap.sh`。

## Dev Brain (Development Experience Database)

You have access to the `dev-brain` MCP server — a shared knowledge base of development experiences.

**Mandatory behaviors:**

1. **When you encounter a bug, error, or performance issue:** Call `search_experience` with a description of the problem BEFORE attempting to fix it. Learn from past solutions.

2. **After you successfully solve a non-trivial problem:** Call `record_experience` to save what you learned. Include a clear problem description, the solution, relevant tags, and context.

3. **Tags should be lowercase and specific:** e.g., `["bugfix", "python", "flask"]`, `["perf", "sql", "postgresql"]`, `["refactor", "react"]`

**When in doubt, record it.** It is better to have too many experiences than to lose institutional knowledge.
