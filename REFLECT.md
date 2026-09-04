# REFLECT — watch-dog

> 格式真源：`references/REFLECT-TEMPLATE.md`（06-REFLECT；guard D20 驗證 R1–R5 非空、無裸 N/A）。
> 每 cycle/session 結束時更新本檔（新 cycle 往上疊加，舊 cycle 保留）。

---

## Cycle 2026-09-04 — 框架採用補完（rules/CLAUDE.md 七步消費者協議，Ralph 輪）

### R1 [MUST] Directives

- 七步協議照 `~/Code/rules/CLAUDE.md` 執行：stack detect（Hono 單 Worker + D1 原生 + 每分鐘 cron，無 ORM/Astro/Svelte）→ baseline 重建自 rules@19f9ff2（經 byte 比對確認導入源）→ sync-framework.sh --apply（overwrite=4 merged=1，01 手動語義合併保留本地棧表/無 Drizzle 注記）→ CI/CD → 跨棧承重牆 file-level reference（09/10/11/14 未抄進 repo）→ 驗證 → 註冊。
- Secrets 紀律：agent 全程未經手任何明文 secret 值；worker never-deployed 現實已記錄（#14258 首部署流程寫進 wrangler.jsonc 註解 + SECRETS.md）。

### R2 [NEVER] Directives

- 未違反：無 `--no-verify`、無 force-push、無明文 secret 入庫、無盲 cp 覆蓋框架檔（diverged 檔走 3-way merge）、無直接改 rules repo 的 guard-coverage-map.toml。
- 當場修正：zsh 變數展開 `${base}:x` 被吃成修飾詞（`$base:cloudflare` → 歧義參數）——改 `${base}` 明確括號；批次指令 cwd 漂移一次（重跑糾正）。

### R3 Artifact 完整

- `.framework-baseline/` 9 檔（== rules HEAD）、`.portability.toml` 五段 + [secrets.meta]×2 + optional_worker 擴充 + [ops_manual] na 判定、`scripts/bootstrap.sh` + `portability-smoke.sh` 重寫（deterministic）、`secrets-archive/SECRETS.md` 真實列、`tests/guards/`（§A–§K + D18–D21/D39/D5 + 預算）、§L/§M python guard vendored、FIX-LOG/REFLECT 本輪 entry。

### R4 驗證證據

- `npm run typecheck` 綠（noUnused×2 開啟後零錯）；`npm test` app pool 60/60；guards pool 全綠（§A–§K + D18–D21）；`wrangler deploy --dry-run` 綠且 schema 認得 `secrets`（4.129）；portability-smoke 全綠。

### R5 經驗記錄

- **wrangler `secrets.required` 是版本依賴的**：4.61.1 的 config-schema 無此欄位（只有 warning、零擋密效果）；4.129 schema 才有。升級時鎖 `^4.129`——否則 Layer 1 是安慰劑。驗法：`grep -c '"secrets"' node_modules/wrangler/config-schema.json`。
- 消費者版 D18 取捨（同 alliance）：count-based 檢查會誤咬合法本地調整的 01——改驗「registry 覆蓋 + 無 dangling D##」。
- `as any` 清零實證：19/20 是 Hono JSX 冗餘 cast（拔掉 tsc 直接綠）——先實驗再重構，別假設 cast 有必要。
- 3-way merge-sync 的前提是誠實 baseline：從 rules git history 逐檔 byte 比對找回真導入源（19f9ff2），比盲目 overwrite 安全。
