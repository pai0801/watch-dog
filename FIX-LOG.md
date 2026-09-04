# FIX-LOG — watch-dog

> 格式真源：`references/FIX-LOG-TEMPLATE.md`（05-FIX-SPEC §1/§4/§5；guard D19 驗證）。
> 每個 fix entry [MUST] 含：目標 / 原因 / 預期結果 / 範圍 ＋ 驗證四重奏（tsc/lint/test/build）。

## Entries

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
