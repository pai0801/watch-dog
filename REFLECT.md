# REFLECT — watch-dog

> 格式真源：`references/REFLECT-TEMPLATE.md`（06-REFLECT；guard D20 驗證 R1–R5 非空、無裸 N/A）。
> 每 cycle/session 結束時更新本檔（新 cycle 往上疊加，舊 cycle 保留）。

---

## Cycle 2026-09-04（晚）— 採用協議補完輪二（Step 4/6 缺口 + Layer-2 guard 補齊，TODO-REVIEW 16→2）

### R1 [MUST] Directives

- 七步協議逐項驗證：Step 2 baseline 九檔 byte-identical（無 merge-sync 需要）；Step 4 補 hooks 安裝＋baseline freshness 接 CI；Step 5 承重牆 09/10/11/14 產物全數驗證（11 六條自查、14 §5 四項）；Step 6 十項清單全過；Step 7 projects.conf 已註冊（rules 1414dd3）。
- Layer-2 guard 覆蓋率補齊：§B 主規則化（非字面值開頭即違規）＋§A/§E/§G/D5 樣式補洞＋#16 AGENTS↔CLAUDE guard＋#9 行為測試＋#15 grep -z。

### R2 [NEVER] Directives

- 未違反：無 --no-verify、無 force-push、無明文 secret 經手（detect-secrets 只掃不寫）、無盲 cp（01-CLAUDE.md 為本地調整空間的 N/A 注記，非框架覆蓋）。
- 當場修正：§B 首版 `\w\s*\+` 樣式誤咬 SQL 算術（`failure_count + 1`）→ 改引號貼鄰雙向；`npm install` 曾讓 lockfile 漂移（peer 標記）→ `npm ci` 對齊。

### R3 Artifact 完整

- 五個 commit：3ad4bf7（CI baseline+seal hang+gen 檔 untrack）、123d6dc（py3.12）、88b0a3c（guard 六向量+bindings 測試）、72e7225（CSS 去重+01 適配注記+TODO-REVIEW 清償）、本 entry 所在 docs commit。
- TODO-REVIEW 16→2（#7/#8 外部盤點債保留）；FIX-LOG 新 entry 四欄位齊。

### R4 驗證證據

- guards pool 21/21；tsc+eslint 綠；§L/§M/archive ✓；多行 JSONC 注入 D38 證明；baseline freshness exit 0；style 括號深度 0。app pool：本機 glibc 2.31 < workerd 需求 2.32 → 無法本機跑（pre-existing；CI runner 執行，workflows make ci 內含 npm test）。

### R5 經驗記錄

- **seal.sh --check hang 模式**：`get_pass` 的 `read -rs` 在非互動環境（stdin 開著）永久阻塞——合約說「降級 warn」但實作沒餵 `</dev/null`。任何 hook 內呼叫可能互動的函數都要顯式隔離 stdin。
- **guard 樣式設計**：抓「拼接」不能只用 `\w\s*\+`（SQL 算術全是誤報）——「引號貼鄰 +」才是 SQL 拼接的可區分特徵；主規則「引數必須字面值開頭」比列舉逃逸向量更強（四向量一次全攔）。
- **detect-secrets `scan --baseline` 會就地更新 baseline 檔**（加 self-exclusion filter + refresh generated_at）——第一次跑後 baseline 有 diff 是預期行為，之後冪等。

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
