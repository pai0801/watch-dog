# FIX-LOG — watch-dog

> 格式真源：`references/FIX-LOG-TEMPLATE.md`（05-FIX-SPEC §1/§4/§5；guard D19 驗證）。
> 每個 fix entry [MUST] 含：目標 / 原因 / 預期結果 / 範圍 ＋ 驗證四重奏（tsc/lint/test/build）。

## Entries

### [2026-09-04] 採用協議補完輪二：Step 4/6 CI 缺口 + seal-check hang + Layer-2 guard 補齊（TODO-REVIEW 16→2）
**目標**：依 `~/Code/rules/CLAUDE.md` 七步協議逐項驗證補完——機械缺口（hooks 未裝、baseline 無人跑、guard 逃逸向量、文件殘留）全數落地，TODO-REVIEW 16 項清到剩 2 項外部盤點債。
**原因**：① git hooks 從未安裝（.git/hooks 空）；② `.secrets.baseline` 無任何機制跑它（#13）；③ `seal.sh --check` 的 `get_pass` 在非互動環境讀 stdin 永久阻塞（違反合約「密碼不可得降級 warn」——§L/§M 直跑被 hang 13 分鐘實證）；④ 系統 python3=3.8 無 tomllib，Makefile/smoke/hook 的 §L/§M 必炸；⑤ guard 六個逃逸向量（#9–#12/#14/#15）+ AGENTS↔CLAUDE 無機械鎖（#16）+ CSS 重複定義與不平衡 @media（#1）+ 01-CLAUDE.md 五段範本殘留（#2–#6）；⑥ `worker-configuration.d.ts`（cf-typegen 產物）被追蹤造成 baseline 六個 RFC 範例字串假陽性。
**預期結果**：hooks 就位（python3.12 探測）；CI 加 baseline freshness step（ENGINEERING_GUIDE §5.2）；seal-check `</dev/null` 不再 hang；§B 主規則「.prepare( 引數非字面值開頭即違規」（四向量 fixture 鎖定）＋引號貼鄰串接（SQL 算術不誤報）；§A 無引號鍵、§G 反向鎖、§E/D5 雙引號、1b `grep -z` 全文（多行 JSONC 注入證明）、AGENTS↔CLAUDE body guard、tests/bindings.test.ts 行為測試；layout.ts 括號深度 0 單一 status-badge；01-CLAUDE.md 五段適配注記；gen 檔 untrack+gitignore。
**範圍**：`.github/workflows/main.yml`、`.gitignore`、`.secrets.baseline`（refresh）、`secrets-archive/{seal.sh,pre-commit-check.sh}`、`scripts/{install-git-hooks.sh,portability-smoke.sh}`、`Makefile`、`tests/guards/{portability,framework}.test.ts`、`tests/bindings.test.ts`（新）、`src/views/layout.ts`、`01-CLAUDE.md`、`TODO-REVIEW.md`。無 schema 變動、無 secret 值變動、worker-configuration.d.ts untrack（cf-typegen 再生）。
**驗證**：guards pool 21/21 ✓；tsc+eslint ✓；§L/§M/archive 三件套 ✓；seal-check 無密碼場景 WARN exit 0（hang 修復）✓；多行 JSONC 注入 FAIL→還原綠（D38）✓；baseline freshness `scan --baseline` exit 0 ✓；style 區括號深度 0 ✓。app pool 本機 glibc 2.31<2.32 無法跑（pre-existing 環境限制，CI self-hosted runner 執行；bindings.test.ts 隨 `npm test` 進 CI）。

### [2026-09-04] deslop 修復輪：§M fresh-checkout 必紅（CI 接線）＋ coverage report 兩處幻覺＋ repo URL
**目標**：清除 deslop 審查（commit 3b87c86）必修三項——push 前讓 CI 首跑可綠、回報文檔不攜帶幻覺進 rules map、repo 遠端 URL 兩邊一致。
**原因**：① §M forward 要求 code 讀的 SECRETISH 出現在 env 檔，但 `.env`/`.dev.vars` 為 gitignored——fresh checkout（CI runner，無值檔）必 exit 1，本地綠只是機器相依僥倖；② `docs/guard-coverage-report.md` D5 row 宣稱「runtime.ts 存在」（檔案不存在，guard 實為全禁＋ignore 未存在路徑）與「detect-secrets baseline 已接 pre-commit」（`.secrets.baseline` 無任何機制跑它）；③ CLAUDE.md/AGENTS.md 寫 `paipeter0801/watch-dog`，實際 `git remote` = `pai0801/watch-dog`。
**預期結果**：① §M env 名稱來源納入 `.dev.vars.example`（committed 鍵名契約檔）——fresh clone 無值檔時 parity 仍可驗；② D5 row 改「runtime.ts 尚未建立＝實質全禁」、detect-secrets 改「一次性掃描證據，接線待辦 TODO-REVIEW #13」；③ URL 改 `pai0801`。同輪零風險順修：bindings.ts 註解精確化（throw 只在 fetch 入口；cron 刻意繞過——原註解宣稱 whole worker 含 cron 皆死，不實）、workflow step 名對齊實際（make ci 無 build）、§B fixture 死元素（slice(0,3) 永不執行）改為誠實限制註解、pre-commit-check.sh staged 掃描加 `--diff-filter=ACMR`（合法刪檔不誤報）＋ `/tmp` 可預測路徑改 `mktemp`。deslop guard 強化向量（§B 四逃逸向量/§A 無引號鍵/§G 反向/雙引號 import/多行 JSONC/AGENTS.md 漂移）記入 TODO-REVIEW #10–#16 留下輪。
**範圍**：`scripts/check-secrets-coverage.py`（ENV_FILES＋專屬 ENV_EXCLUDE_SUFFIX＋selftest 案例）、`CLAUDE.md`＋`AGENTS.md`（URL）、`docs/guard-coverage-report.md`（D5 row＋接線段）、`src/lib/bindings.ts`（僅註解）、`.github/workflows/main.yml`（step 名）、`tests/guards/portability.test.ts`（僅 §B fixture/註解）、`secrets-archive/pre-commit-check.sh`、`TODO-REVIEW.md`（+7 行）。無 secret 值變動、無 schema 變動。
**驗證**：§M `--selftest` 8/8（新增 example-env-counts 案例）✓；fresh-clone 模擬 D38——舊 checkout 舊腳本 exit 1 重現 deslop 發現 → 同 clone 修復腳本 exit 0 ✓；§L 於 clone exit 0 ✓；`make ci` 全綠 ✓（tsc＋ESLint＋app/guards 雙 pool）。

### [2026-09-04] 安全：現役 CLOUDFLARE_API_TOKEN 明文洩漏（docs/plans 舊計畫文件）redact + 強制輪替
**目標**：消除 committed 明文現役 token（`docs/plans/2026-02-02-watch-dog-sentinel.md:33`）。
**原因**：2026-02-02 的計畫文件把 `export CLOUDFLARE_API_TOKEN="<值>"` 逐字寫進範例指令塊並 commit（10327ec）——值與 `.env` 現役 token 相同（byte 比對確認 = LIVE 洩漏），且 repo 有 GitHub remote。由 2026-09-04 框架採用輪的 `.secrets.baseline`（detect-secrets）掃描發現。
**預期結果**：工作樹不再含該值（redact 為註記）；git 歷史舊值靠 **token 輪替**作廢（值 file-sourced、agent 不經手——使用者於 CF dashboard 作廢舊 token → 新值進 `.env` → `seal.sh`）；SECRETS.md 該列「上次更換」標 [MUST] 輪替中；baseline 後續掃描不再出現該 finding。
**範圍**：`docs/plans/2026-02-02-watch-dog-sentinel.md`（1 行 redact）＋`secrets-archive/SECRETS.md`（輪替欄）＋本 entry。歷史改寫（filter-repo/force-push）不做——main 歷史 [NEVER] force-push，輪替已使歷史值無效化。
**驗證**：`git grep` 全 repo 無第二副本 ✓；redact 行不再觸發 detect-secrets ✓；輪替完成判定 = 使用者確認（pending，不阻塞框架採用收尾）。


### [2026-09-04] 安全腳本設計衝突：pre-commit 對 tracked wrangler.jsonc 的檔名級禁令 → 值級掃描
**目標**：解除「wrangler.jsonc 被 git 追蹤（框架 §G guard 讀它、Layer 1 `secrets.required` 載體）但 pre-commit-check.sh 檔名級禁令禁止 staged」的死鎖——照舊任何 wrangler.jsonc 變更都無法 commit。
**原因**：pre-commit-check.sh 與 seal.sh 承襲 env-tools 家族模型（該家族 wrangler.toml 為 gitignored 值檔），把 `wrangler.toml`/`wrangler.jsonc` 列為「plaintext secret file」並納入 seal 範圍；但 watch-dog 的 wrangler.jsonc 是 tracked 公開配置——secret 只放名稱（`secrets.required`），值一律走 `wrangler secret put`（10-SECRETS-CONTRACT）。兩個模型對同一檔案的假設矛盾。
**預期結果**：① 檔名級禁令收斂到真正的值檔（`.env*`/`.dev.vars`/`wrangler.*.toml|.jsonc` 變體，`.example` 除外）；② tracked wrangler 配置改由值級掃描把關（SECRETISH 形態的鍵帶非空值 → FAIL，名稱清單合法）；③ seal 範圍移除 wrangler.jsonc/toml 本體（它在 git 裡，封進 env.7z 是冗餘真相源）；④ 注入證明（D38）：塞 `"ADMIN_TOKEN": "fake"` → hook FAIL → 還原 → 綠。
**範圍**：`secrets-archive/pre-commit-check.sh`（§1 改寫 + §1b 新增，含 grep 部分-檔-不存在回 exit 2 的 if 假分支陷阱修正）、`secrets-archive/seal.sh`（SECRET_PATTERNS 移除本體、保留 env 變體）＋ re-seal（env.7z manifest 重建）。`.env`/`.dev.vars` 值檔的絕對禁令不變。
**驗證**：注入 `"ADMIN_TOKEN": "fake-secret-value"` → `FAIL: wrangler config carries a secret VALUE` ✓ → 還原 → silent ✓；`pre-commit-check.sh` 直跑 exit 0 ✓（seal re-sync 後）。


### [2026-09-04] 框架採用補完輪：portability-smoke.sh 假腳本修復 + as-any 清零 + 死碼移除 + Layer 1 成真
**目標**：把 7/29 部分採用留下的四個「口頭有、機械無」缺口變成 guard 防線：假 smoke 腳本、20 處 `as any`、6 處死碼、無效的 wrangler `secrets.required`（舊版 wrangler 不認得此欄位）。
**原因**：① `portability-smoke.sh` 內容是字面 `npm run dev → curl /health`（非腳本、必炸），fresh-clone 驗收形同虛設；② 20 處 `as any`（19 處 Hono JSX 冗餘 cast + `logic.ts:183` DB 結果轉型）繞過型別檢查；③ `cron.ts` selfProject、`dashboard.ts` html import、測試 3 處 unused；④ wrangler 4.61.1 的 config schema 無 `secrets` 欄位 → Layer 1 部署期擋密實際不存在（每次 deploy 只出 warning）。
**預期結果**：smoke = deterministic typecheck+test+build dry-run（+§L/§M python guard），任何回歸紅燈；`as any` 預算 0 由 guard 鎖死；wrangler ^4.129 使 `secrets.required` 真正擋部署（缺 ADMIN_TOKEN → deploy fail）。
**範圍**：`scripts/portability-smoke.sh` 重寫、`scripts/bootstrap.sh` 重寫、`src/routes/{dashboard,admin}.ts` + `src/services/{logic,settings}.ts` + `src/cron.ts` + `src/index.ts` + `src/lib/bindings.ts`（新）、`tests/{api,cron,logic}.test.ts`、`tsconfig.json`（noUnused×2）、`wrangler.jsonc`（secrets 區塊）、`package.json`（wrangler ^4.129 + workers-types ^5）、`.portability.toml` 全段重寫、`tests/guards/` 新增雙檔、`secrets-archive/SECRETS.md` 補齊。零 schema migration、零 secret 值變動。
**驗證**：tsc ✓ / test ✓（60 app + guards pool）/ build ✓（deploy --dry-run）＋portability-smoke ✓
