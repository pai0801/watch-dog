# FIX-LOG — watch-dog

> 格式真源：`references/FIX-LOG-TEMPLATE.md`（05-FIX-SPEC §1/§4/§5；guard D19 驗證）。
> 每個 fix entry [MUST] 含：目標 / 原因 / 預期結果 / 範圍 ＋ 驗證四重奏（tsc/lint/test/build）。

## Entries

### [2026-09-05] WD-03 清償——admin 表單端點對 JSON body 415 fail-loud（拔掉「200＋靜默存空值」地雷）

**目標**：`POST /admin/settings/email`（及所有 parseBody 端點）收到 `content-type: application/json` 時不再「回 200 saved! 卻存入空值」——改為 **415 fail-loud**。
**原因**：操作者啟用 email 警報實測踩雷（WD-03）：JSON body 被 `parseBody()` 靜默忽略、三欄存空、測試信報 not configured，需自行排查改 form-urlencoded 才通。「成功回應＋靜默空值」是最壞組合；同型地雷還有 `checks/toggle`（JSON → monitor 靜默設 0＝悄悄暫停監控）。
**預期結果**：`rejectJsonBody` middleware（Content-Type 含 application/json → 415＋指路 WD-03 訊息）套用於六個表單端點——settings/slack、slack-test、settings/email、checks/toggle、checks/:id（編輯）、projects/new；maintenance 端點本就刻意雙格式（form→JSON fallback）不動；email-test 不讀 body 不需 guard。文件：README runbook ② 註記與排障段更新（415 語義）、接入段修正 WD-01 後仍殘留的「含 self check」字樣；backlog 劃記。
**範圍**：`src/routes/admin.ts`（middleware＋六路由）、`tests/admin.test.ts`（+3：email JSON→415 且**設定不被清空**、slack JSON→415、toggle JSON→415 且 monitor 不動）、`README.md`、`docs/backlog.md`。
**驗證**：app pool **86/86** ✓（83+3）guards 21/21 ✓；部署後線上——JSON body → 415、form-encoded → 200、既有 email 設定原封不動。

### [2026-09-05] 雙通道警報——服務中斷（critical/recovery）經 email-king gateway 另寄 email

**目標**：服務中斷不只 Slack——critical（DEAD）與 recovery 另寄 email，經操作者的 email-king gateway（`~/Code/email-king`，`POST /api/v1/send`、Bearer consumer token）。
**原因**：操作者指示；Slack 訊息易被淹沒，真中斷值得信箱層級的觸達。warning 維持 Slack-only——信箱留給真中斷，避免稀釋。
**預期結果**：Settings 擴充 EmailSettings（gateway URL＋consumer token＋收件人，D1 settings、遮罩留空保留——同 Slack 模型）；`sendEmailAlert`（ek-gw API 合約：`{to_email,subject,html_content,industry,company}` CRM 歸因、`AbortSignal 10s`、`{detail:{code}}` 錯誤解包、`{ok,error}` 回報）；`dispatchAlert` 扇出（Slack 恒發＋critical/recovery 並行 email，`Promise.all` 通道互相獨立——**gateway 掛掉（正是 watch-dog 監控的 ek-gateway）不擋 Slack**）；logic.ts 兩呼叫點換 `dispatchAlert`；`/admin/settings/email` 存檔＋`/admin/settings/email-test` 測試鈕（當場 ✓/✗ 含 ek 錯誤碼）。文件：usage Settings 段＋SECRETS.md email_api_token 列（D1 settings 模型，非 Worker secret）。
**範圍**：`src/services/{settings,alert,logic}.ts`、`src/routes/admin.ts`、`src/views/adminViews.ts`、`tests/{utils,admin,logic}.test.ts`（+7：設定存取×4、dispatch 行為×3）、`docs/usage.md`、`secrets-archive/SECRETS.md`。無 schema、無 Worker secret 變動。
**驗證**：app pool **83/83** ✓（76+7）guards 21/21 ✓；dispatch 行為鎖定——critical 雙通道（email 帶收件人＋主題）、warning 僅 Slack、gateway 500 不擋 Slack 且不 throw。**操作者後續**：經 SSH mint email-king consumer token → `/admin` → Settings → Email 填三欄 → 📧 Test Email 按鈕驗證（未設定時按鈕回 `not configured` 提示）。

### [2026-09-05] WD-01/WD-02 清償——拔除 self 模板 check（誤報產生器）＋ config API 補齊 check 管理面（replace-set＋monitor）

**目標**：清償 email-king 接入實測暴露的兩個 footgun（docs/backlog.md）：WD-01 每個新 project 自動附加 `self` check——client 永不脈搏它 → 每接入一個服務就預約一條 DEAD 誤報（ek-dev/ek-gateway 實案）；WD-02 客戶端 API 無法完整表達 checks 生命週期（config 只 upsert 無刪除、monitor 只在 admin UI），迫使操作者 D1 直攻。
**原因**：WD-01 是活性誤報產生器（P1）；WD-02 違反「client 的 checks 清單即真相」的宣告式模型——backlog 修法建議雙方向擇一或並行，本輪並行落地。
**預期結果**：`POST /admin/projects/new` 不再建任何模板 check（project 的 checks 完全由 client `PUT /api/config` 宣告）；config PUT 新增——①頂層 `checks_replace: true`：該 project 未列於 payload 的 check（含 logs）被刪，回應帶 `checks_deleted`（預設 false 純 upsert 不變，避免破壞 partial-PUT 既有 client）；②check 條目 `monitor: 0|1`：直接在 API 設定監控開關（省略 = 保留現值）。§B guard 相容設計：monitor 走兩條靜態語句（非動態欄位清單）、replace 走逐列靜態刪除（非動態 IN 清單）。文件同步（client-guide 漏列即刪警告、api.md、usage、README features）。backlog 劃記。
**範圍**：`src/routes/{api,admin}.ts`、`src/types.ts`、`tests/{api,admin}.test.ts`（WD-01 斷言翻轉＋WD-02 +3）、`scripts/enroll.sh`（註解）、`docs/{client-guide,api,usage,backlog}.md`、`README.md`。無 schema、無 secret 變動。
**驗證**：app pool **76/76** ✓（+3）guards 21/21 ✓；部署 `65b4eed9` 後線上驗收——WD-01：新專案 checks=0（**首驗曾見殘留 self：部署後秒打 enroll 撞上舊版本傳播窗，8 秒後重驗歸零**——部署→線上驗證要留傳播間隔）；WD-02：a+b 註冊 → replace [a] 後 `checks_deleted` 如實（含殘留 self 共 2）、`monitor=0` 生效、跨 project 無波及；演示專案清除＋registry 同步 re-seal ✓。

### [2026-09-05] /admin 帳密成對驗證——ADMIN_ACCOUNT＋ADMIN_PASSWORD 取代單一 ADMIN_TOKEN

**目標**：把 admin 登入從「username 任意＋密碼=ADMIN_TOKEN」升級為操作者指定的帳密成對模型（`.env` 的 `ADMIN_ACCOUNT`/`ADMIN_PASSWORD`）。
**原因**：操作者設定並指示採用成對帳密；成對模型對即將上線的 Cloudflare Access（Zero Trust）第二層語義也更清晰（帳號身分＋密碼證明，而非半套憑證）。
**預期結果**：`adminAuth.ts` 帳密皆 `timingSafeEqual`（缺一 401；username 不再忽略；Basic 編碼無冒號直接 challenge）；三方同步換鑰——`wrangler.jsonc secrets.required`、`REQUIRED_BINDING_KEYS`、`.portability.toml [secrets].worker`（meta 三塊：兩新＋ADMIN_TOKEN 保留為歷史記錄）；**§J 命名規約裁定**：`_ACCOUNT`/`_PASSWORD` 非合法 `{VENDOR}_{ROLE}_{TYPE}` 尾綴，列入 `legacy_names` allowlist（成對語義優先於單值尾綴規約）；`vitest.config.ts` 測試 bindings、`.dev.vars.example`、`enroll.sh`（改讀 `.env` 帳密）、`.dev.vars`（同步兩鍵、刪 ADMIN_TOKEN）、文件（usage/README/SECRETS）同步；`ADMIN_TOKEN` worker secret 刪除。
**範圍**：`src/{middleware/adminAuth.ts,lib/bindings.ts,types.ts}`、`wrangler.jsonc`、`.portability.toml`、`vitest.config.ts`、`tests/{admin,bindings}.test.ts`、`scripts/enroll.sh`、`.dev.vars.example`、`docs/{usage.md,README.md}`、`secrets-archive/{SECRETS.md,env.7z}`（re-seal：.env/.dev.vars 變動）、`.dev.vars`（非 committed）。
**驗證**：app pool **73/73** ✓（+1：錯 username 401；「any username」測試改為成對）guards 21/21 ✓（§F/§G/§H 三方同步新鑰、§J 靠 legacy_names）；部署 `702a295f` 後線上——正確帳密 200、錯帳號 401、錯密碼 401、無認證 401、舊單密碼用法 401；`wrangler secret delete ADMIN_TOKEN` 完成（`secret list` 僅餘兩新鑰）。

### [2026-09-05] Admin 界面功能補全——測試警報／token 生命週期／Logs 檢視器（＋Zero Trust 前置文件）

**目標**：把管理界面做足——修三個盲區：① Slack 路由設定後無法當場驗證（此前只能靠手動 e2e 或等真事故）；② token 只能經 enroll.sh 一次性產生（UI 建立要手編、無輪替能力）；③ `logs` 表有 7 天 pulse 史但 admin 完全看不到。
**原因**：操作者指示「查管理界面、功能做足做全，自行規劃優化」；部署後的營運高頻操作（驗證警報鏈、token 輪替、排查 pulse 歷史）不該退回 curl。Zero Trust 為操作者後續計畫，先行文件預留。
**預期結果**：`sendSlackAlert` 回傳 `SlackSendResult{ok,error}`（token 未設／頻道未設／Slack API 錯誤／網路錯誤皆帶原因；cron 呼叫端忽略回傳值，行為不變）。新四端點：`POST /admin/settings/slack-test`（level ∈ critical|warning|recovery，真送一通並回報成敗）、`GET /admin/generate-token`（`crypto.getRandomValues` 48-hex，與 enroll.sh 同款）、`POST /admin/projects/:id/rotate-token`（舊值立即失效、新值 modal 只顯示一次＋提醒同步 client env／tokens.local.md）、`GET /admin/logs`（project 前綴過濾＋`escapeLikePattern` 防 sibling 洩漏＋limit clamp 1–200，回 tbody htmx 片段）。UI：Settings 測試警報三鈕（結果走純 DOM 更新——`hx-on` 內赋值寫不進 Alpine scope 的陷阱）；Projects 表 token 遮罩欄＋Rotate 鈕；New Project 對話框 🎲 產生鈕；第四個 Logs tab（專案過濾＋筆數＋htmx 載入）。文件：usage.md 四標籤＋**Zero Trust（Cloudflare Access）前置規劃**（至少蓋 `/admin*`；整域上線時 machine API 需 bypass／Service Auth 否則 pulse 被擋；Basic Auth 保留為第二層縱深；無需改碼）。
**範圍**：`src/services/alert.ts`（回傳型別）、`src/routes/admin.ts`（+4 端點＋dialog 產生鈕）、`src/views/adminViews.ts`、`tests/admin.test.ts`（+8）、`docs/usage.md`。無 schema、無 secret 變動。
**驗證**：app pool **72/72** ✓（64+8）guards 21/21 ✓ tsc+eslint ✓；部署 `b6a1e9f2` 後線上逐項——slack-test critical `{"ok":true}`（真訊息已達頻道）、無效 level 400、generate-token 48-hex、rotate 舊 token 403／新 token 200、logs 無認證 401／有認證回真實資料（首個真實專案 `ek-dev` 的 pulse 史）、admin 頁 Logs tab 在位；演示專案已清除（ek-dev 為操作者真實資料，未動）。

### [2026-09-05] 註冊封閉化（closed registration）＋ admin token 強度 server-side——TODO-REVIEW #17/#18 清償

**目標**：消除開放註冊的攻擊面：任何人可經 `PUT /api/config` 建 check → 不發 pulse → 判死警報打進操作者 Slack（**警報通道虐待**——alert fatigue 會淹掉真警報）；且 API 建立的 project token 無強度檢查，而 pulse 未帶 `project_id` 時以 token 反查專案 → 弱 token = 可猜身分。
**原因**：操作者提問「不是應該先確認身份才能讓專案註冊？」——重新審視後確認：單操作者系統的正確模型是**註冊 = 操作者動作**、客戶端只憑專案 token 報到。線上實證（auth-demo/weak-token-demo）：既有專案錯 token 403 ✓（劫持防護完整），但 1 字元 token 可註冊成功（admin UI 的 minlength=16 僅 client-side）。
**預期結果**：`PUT /api/config` 未知 project → 404（訊息導向「請操作者於 /admin 建立」）；既有 project 保持 token-gated（403）；display_name 更新由 upsert 改為 UPDATE（INSERT..ON CONFLICT 分支移除，`now` 變數一併清——noUnusedLocals）。`POST /admin/projects/new` 加 server-side `token.length >= 16`（htmx 錯誤片段，不回 echo payload）。測試 +2：api.test.ts「未知 project 404＋零副作用」（無 project/check 落地）、admin.test.ts「弱 token 拒絕」；原註冊測試改為 seed 前置（seedProject）。文件同步：client-guide（Token 取得改為操作者建立、30 秒閉環加前提、agent 塊、404 排序）、usage（唯一途徑=admin UI）、api.md（PUT config 語義＋404）。
**範圍**：`src/routes/{api,admin}.ts`、`tests/{api,admin}.test.ts`、`docs/{client-guide,usage,api}.md`、`TODO-REVIEW.md`（#17/#18 → 已清償）。無 schema、無 secret 變動。
**驗證**：app pool **64/64** ✓（62+2）guards 21/21 ✓；部署 version `f71ba735` 後線上實測六步全綠——①未知 project PUT config → **404**（且無資料落地）②admin 弱 token → 「at least 16 characters」拒絕 ③admin 合法建立 → 302 ④持 token PUT config → 200（checks_registered:1）⑤pulse `self` check → success ⑥admin delete → 200、projects:0。

### [2026-09-05] 首次生產部署完成——helperp@gmail.com 帳號切換（D1 額度解法）＋ #14258 流程＋線上 e2e 驗證

**目標**：完成 watch-dog 首次生產部署（前次嘗試因 paipeter 帳號 D1 Free 額度滿中斷，操作者裁定改用 helperp@gmail.com 帳號建置）。
**原因**：① 舊帳號 D1 額度滿（10/10 全屬其他專案，無空殼可清）；② 操作者於 `.env` 換上 helperp 帳號憑證；③ 舊帳號端本 session 未建成任何資源（D1 create 被擋、無 deploy、其餘全程唯讀）——確認無需清理。
**預期結果**：helperp 帳號建 `watch-dog-db`（APAC）→ `wrangler.jsonc database_id` 更新（`2b2ec8c6-87bf-4005-98b9-56658bbda493`）→ 遠端套 `src/db.sql`（冪等）→ #14258 首次 deploy 流程（暫移 `secrets` 區塊 → `wrangler deploy --minify` → `wrangler secret put ADMIN_TOKEN` file-sourced pipe 自 `.dev.vars`（值不進 agent context）→ 區塊加回還原）→ 線上閘門與 e2e 驗證 → SECRETS.md 帳號/部署記錄同步。
**範圍**：`wrangler.jsonc`（新 database_id＋首次部署完成注記）、`secrets-archive/SECRETS.md`（ADMIN_TOKEN prod 設定、CF 憑證帳號切換、D1 前置段收尾、首次部署完成記錄段）、`.env`（操作者切換 helperp 憑證，非 repo 檔）。無 app 碼變動、無 schema 變動（schema 套的是既有 `src/db.sql`）。
**驗證**：線上閘門——dashboard 200 ✓、`/admin` 無憑證 401 ✓、`POST /api/pulse` 無 token 401 ✓、`/api/status` 200（D1 讀路徑活）✓；**e2e 煙霧**——`PUT /api/config` 註冊 `smoke-test` 專案＋check（checks_registered:1）→ `POST /api/pulse`（success，`smoke-test:deploy-smoke`）→ `/api/status/smoke-test` 驗 `last_seen` 已寫入、`is_stale=false` → 測試資料 D1 `DELETE` 清除（`/api/status` projects:0）✓；`wrangler secret list` = ADMIN_TOKEN ✓；deploy 輸出 `https://watch-dog.helperp.workers.dev`、cron `* * * * *` 已啟動、version `5d08ce4e`。**操作者後續**：`/admin` 設定 Slack 頻道（alert 鏈在 Slack token 未設時不發送，空態安全）；`env.7z` re-seal；舊 paipeter token 作廢確認。

### [2026-09-05] 雙軸 code-review 收尾輪：文件漂移三處＋sent-log 誤 commit＋去重兩形態＋環境升級現形的潛在測試 bug

**目標**：清償 2026-09-05 雙軸 code-review（Standards/Spec 平行 sub-agent，範圍 `2fd00ff...HEAD` 30 commits）全部可行動 findings，並處理驗證途中現形的存量測試 bug。
**原因**：① TODO-REVIEW 舊債段標頭仍稱「剩 #7 open」（88b0a3c 時期文本，042c8d2 清償後未同步）——與 #7 row／FIX-LOG 宣稱自相矛盾；② `docs/99-llm-task-web-todo.md`（fleet sent-log 個人待辦鏡像）經 909c07a 誤 commit——`~/.gitignore_global` 只蓋 `-log-*` 變體；③ `.secrets-optional` 殘留 `SLACK_API_TOKEN`，違反自身「≡ optional_worker（=[]）」同步宣稱——正是 10-SECRETS-CONTRACT 要防的兩清單漂移；④ review smell：CAS claim SQL 兩處重複、tomllib python 挑選三處重複且已各自漂移（盲目 fallback vs 探測後 fallback）；⑤ 驗證時發現主機已升級（glibc 2.31→2.39、node 20→24、workerd 2026-09-03 可執行）——app pool 首次本機可跑，`tests/bindings.test.ts` 首跑現形失敗：fetch entry 是同步 throw（index.ts 非 async），`expect(...).rejects` 在參數求值時就接不到——該測試寫於 workerd 不可跑時期，此前從未在任何環境執行（本機 ❌＋CI runner 離線的雙重空窗）。
**預期結果**：TODO-REVIEW 標頭改「16 項全數清償、零未償」＋row 保留為歷史記錄的規則注記；todo 檔 `git rm --cached`（本地保留）＋global pattern 拓寬 `docs/99-llm-task-web-log-*.md`→`docs/99-llm-task-web-*`；`.secrets-optional` 刪 stale 行（空 allowlist ≡ optional_worker=[]；本地 `.env` 殘留 `SLACK_*` 陳年 key 由 §M 反向 WARN 如實揭露，清檔＋reseal 留操作者域 A 處理）；logic.ts 抽 `claimAlertSlot` 共用 helper（SQL 字面值仍在 helper 內 inline——§B guard 禁 `.prepare()` 非 literal 引數，文檔標準優先於 Duplicated Code smell 的去重邊界）；新增 `scripts/pick-python.sh` 單一真相源（Makefile/smoke/install-git-hooks 三處改引用）；bindings 測試改 async IIFE 收斂 sync-throw／rejected-promise 兩種 surface（鎖不變式：缺 ADMIN_TOKEN 必 fail-fast＋訊息指名 key）；CLAUDE.md＋AGENTS.md 環境限制表鏡像更新為 2026-09-05 實測（workerd ✅／wrangler ✅ node24／降級路徑保留給舊主機容器）。**裁定不動**（review findings 記錄處置）：node 探測 fail-handling 分歧（check-env.sh fail-closed vs smoke 降級）為 intentional 分工——前者 CI 全量環境 hard-fail、後者開發機誠實降級；`silencePeriod` 雙概念名（per-check cooldown vs global silence，有註解有測試）、api.ts invalid check name 靜默 drop 沿既有 idiom，低嚴重度留流動。
**範圍**：`TODO-REVIEW.md`、`.secrets-optional`、`docs/99-llm-task-web-todo.md`（退追蹤）、`src/services/logic.ts`（純抽取零行為變更）、`tests/bindings.test.ts`（斷言方式）、`scripts/pick-python.sh`（新增）、`Makefile`、`scripts/{portability-smoke.sh,install-git-hooks.sh}`、`CLAUDE.md`＋`AGENTS.md`（guard #16 鏡像）、`~/.gitignore_global`（非 repo 檔）。無 schema、無 secret 值、無 API 行為變動。
**驗證**：portability-smoke **全量模式**全綠（typecheck ✓ eslint ✓ **app pool 62/62 ✓** guards 21/21 ✓ build dry-run 126.88 KiB ✓ §L ✓ §M 反向 WARN 如預期現形 `SLACK_API_TOKEN`＋既有 `CLOUDFLARE_API_TOKEN`）——logic.ts 重構經 app pool 行為測試實測覆蓋（非僅 tsc）；bindings 測試修前以 stash 對照乾淨 HEAD 確認存量失敗（非本輪引入）；pick-python 實測輸出 python3（tomllib ✓）。CI runner 離線中——push 後 [MUST] 確認 runner 恢復後首跑綠。**操作者後續**：本地 `.env` 清 `SLACK_*` 陳年 key＋`seal.sh` reseal（域 A）。

### [2026-09-04] CI workflow 環境前置補齊——check-env.sh preflight + engines 宣告（第三個 gate 的環境誠實化）

**目標**：補齊第三個 gate 的環境前置——CI runner 恢復在錯環境（node 20 / glibc < 2.32）時，失敗提前到第一步並給可行動訊息，而非 make ci 噴難懂 GLIBC/engines 錯。pre-push（91d9e10）與 smoke（a4894ee）已有探測，唯 CI 缺席。
**原因**：環境限制是本 session 才實測確立的（node 22 前置、glibc 2.32 斷點），workflow 寫於此之前；「同型 bug 成群」教訓的第三處呼叫點；package.json 亦無 engines 宣告。
**預期結果**：`scripts/check-env.sh`（hard-fail：node ≥ 22 + glibc ≥ 2.32，訊息指路 SECRETS.md；ldd 缺失 ⚠ 手動確認）成為 workflow 第一步；engines node >=22 宣告。CI [MUST] 全量環境故 hard-fail，與開發機降級模式互補（腳本註解明示分工）。
**範圍**：`scripts/check-env.sh`（新增）、`.github/workflows/main.yml`、`package.json`。無 app 碼、無 schema、無 secret 變動。
**驗證**：本機（node 20.20.2 + glibc 2.31）實測 rc=1 兩訊息齊全；mock node22+glibc2.35 stub 驗 ✓ 成功路徑 rc=0；開發中修掉兩個自產 bug——`ldd | head` pipefail SIGPIPE 提前炸（141）、非數字 NODE_MAJOR fail-open（mock stub 揭露）→ fail-closed 加固；tsc ✓ eslint ✓ guards 21/21 ✓。


### [2026-09-04] fresh-clone bootstrap 實測：node requires 20→22 更正 + restore.sh 同型 hang 修復
**目標**：驗證「fresh clone 可重建」承諾（09 §1.1 portability 承重牆）在本機的真實行為，並修實測發現的缺陷。
**原因**：① bootstrap [0/5] 宣稱 requires `node>=20` 但 wrangler 4.129 實測硬擋 <22（fresh clone 上 [2/5] cf-typegen 即敗）——requires 檢查說謊；② restore.sh 的 `get_pass` 有 seal.sh 已修的同型 hang（`read -rs` 無密碼非互動環境永久阻塞）——bootstrap [3/5] fresh clone 會 hang；③ #7 移除後仍有殘留引用（admin-settings-ui-summary.md 的 `getEnvWithFallback`、SECRETS.md/bindings.ts 的 `getEffectiveSettings`）。
**預期結果**：bootstrap [0/5] node 檢查改 ≥22（WARN 路徑含免 sudo recipe 指引）；`.portability.toml [bootstrap].requires` 同步 `node>=22`；restore.sh `</dev/null` stdin 隔離 + 空密碼 fail-fast（明確 ERROR）；殘留引用清理對齊 `getAllSettings` 最終設計。
**範圍**：`scripts/bootstrap.sh`、`secrets-archive/{restore.sh,SECRETS.md}`、`.portability.toml`、`docs/admin-settings-ui-summary.md`、`src/lib/bindings.ts`（註解）。無 schema 變動、無 secret 值變動。
**驗證**：fresh-clone 實測矩陣（glibc 2.31 + node 22 tarball）：[1/5] npm install ✓、[2/5] cf-typegen 生成 types ✓（但 exit 1：runtime types 階段 spawn workerd 死於 glibc——types 檔已足讓 typecheck ✓）、[3/5] restore 無密碼場景修復後 41ms fail-fast ✓（修前永 hang）、[4/5] d1 --local 確認死於 workerd glibc（預期內，記錄）、guards 21/21 ✓ eslint ✓ typecheck ✓ 於 fresh clone 全綠。node 20 主機 [0/5] WARN 如實觸發 ✓；§L guard ✓（manifest requires 變更後）。
**補記（portability-smoke 同款降級）**：smoke 的 `npm test` + `deploy --dry-run` 與 pre-push 同病——本機 workerd glibc 擋 app pool、node 20 擋 wrangler（實測 rc=1 卡 GLIBC）。套同款環境探測：workerd 不可執行 → guards-only + ⚠ 大聲標示（「本輪全綠 ≠ 全量已驗」）；node < 22 → 明確跳過 dry-run。降級路徑實測 rc=0 且三處 ⚠ 如實輸出；full 模式（glibc ≥ 2.32 + node ≥ 22 環境）行為不變。
**環境矩陣結論**（glibc 2.31 主機）：wrangler CLI（types/deploy dry-run）＝node 22 可解；workerd 依賴（d1 --local/dev/app pool）＝node 解不了，需 glibc ≥ 2.32 環境（容器/新主機）——與 SECRETS.md/AGENTS.md 環境限制表一致。

### [2026-09-04] TODO-REVIEW #7 清償：移除 SLACK_* env fallback——首次部署前落地，DB settings 單一真相源（TODO-REVIEW 16→0）
**目標**：消除「DB settings 為主、env 為 fallback」的雙真相來源，讓系統從首次部署起就是單一架構。
**原因**：原處置建議「兩個專案遷移到 DB settings 後刪 fallback」——但重審前提：**系統從未部署**（首次部署待辦），「等遷移」的條件不存在；現在移除 = 零部署受影響、零遷移成本，且與 #8（Bearer-only）同為「出生前收縮介面」模式。
**預期結果**：`getEnvWithFallback` 移除（初版曾導入 `getEffectiveSettings` 代理層，末輪自糾併回 `getAllSettings` 單一匯出名）；`sendSlackAlert`/`getSilencePeriod`/`processCheckResult` 簽名拔掉 `env` 參數（alert 鏈不再需要 env）；`trySlackApiToken` accessor 刪除、`OPTIONAL_BINDING_KEYS = []`；`Env` 型別 `SLACK_*` deprecated 欄位全刪；`.portability.toml` `optional_worker = []`＋meta 標歷史記錄；`.dev.vars.example` 移除 SLACK 區塊；SECRETS.md 該列改「已移除」。docs/plans/* 歷史文件保留原文（記錄性文件 [NEVER] 改）。
**範圍**：`src/services/{settings,alert,logic}.ts`、`src/{cron.ts,routes/api.ts,lib/bindings.ts,types.ts}`、`tests/logic.test.ts`（22 個呼叫點）、`.portability.toml`、`.dev.vars.example`、`secrets-archive/SECRETS.md`、`TODO-REVIEW.md`。無 schema 變動（settings 表不變）；無 secret 值變動。
**驗證**：tsc ✓（零 error）；eslint ✓；guards pool 21/21 ✓（§F/§G/§H 三方同步：manifest `optional_worker=[]` ≡ `OPTIONAL_BINDING_KEYS=[]` ≡ wrangler `required=[ADMIN_TOKEN]`）；§L/§M ✓；baseline freshness ✓。app pool（cron/alert 行為回歸）本機 workerd glibc 限制無法跑——測試簽名更新全數過 tsc，行為補驗留 CI runner 恢復後首跑（與 #9 同一批）。

### [2026-09-04] pre-push hook 環境探測（workerd glibc）＋ CI runner 離線發現
**目標**：讓本機（glibc 2.31，workerd 不可執行）推得出代碼，同時不靜默放棄 app pool 驗證；並把「CI 會補全量」的預設從未驗證假設改為已驗證事實。
**原因**：① `scripts/install-git-hooks.sh` 的 pre-push 無條件 `npm test`——app pool 跑在 workerd（glibc ≥ 2.32），host Ubuntu 20.04（glibc 2.31）永遠推不出去（實測 push 被 hook 擋）；② 推送時發現 CI run #1（d8a6c9c，03:46 UTC）queued 11+ 小時——self-hosted runner 離線，且本機無 runner 進程/service/家目錄（backup script 在本機、docker sock 無權限，推測容器化 runner 已停）；③ SECRETS.md/FIX-LOG 先前寫「CI 的 make ci 不受影響」「app pool 由 CI runner 執行」均為未驗證主張——`make ci` → `npm test` → `test:app` → workerd 同樣需要 glibc ≥ 2.32。
**預期結果**：pre-push 加 workerd 可執行性探測（`node_modules/.bin/workerd --version` exit code）——可執行跑全量 `npm test`；不可執行走「降級模式」typecheck+lint+guards，輸出大聲標示（⚠ 降級模式 + [MUST] 確認 CI 綠）絕不靜默；SECRETS.md「CI runner 離線」段落記錄 queued 實證 + runner 主機 glibc 前提 + 備份停擺影響面；FIX-LOG 舊條目兩處未驗證主張同步更正。
**範圍**：`scripts/install-git-hooks.sh`（pre-push 探測分支）、`secrets-archive/SECRETS.md`、`FIX-LOG.md`（本條目 + 舊條目驗證段更正）。無 schema 變動、無 secret 值變動。
**驗證**：降級路徑實測（typecheck ✓ + eslint ✓ + guards 21/21 ✓，輸出含 ⚠ 降級模式標示）；workerd 探測 exit=1 / vitest 探測 exit=0（區分度實測）；runner 離線證據 GitHub API run #1 queued；build＝本專案無 build step（wrangler deploy，環境前置 node ≥ 22 未滿足，首次部署待辦）。app pool 全量仍待 runner 恢復後由 CI 首跑補驗。
**補記（node 22 工具鏈驗證）**：user-space node v22.14.0 tarball（免 sudo/nvm）在本機實測 `wrangler --version` 4.129.0 ✓、`wrangler types` ✓、`wrangler deploy --dry-run` ✓（127.60 KiB bundle、D1 binding 認得）——首次部署工具鏈本機已證可用，recipe 更新至 SECRETS.md；`wrangler types` 重跑僅動 baseline `generated_at`（已還原，維持 read-only gate 紀律）。
**補記 2（dev 工作流斷點 + cycle-1 R4 幻覺更正）**：node 22 下 `wrangler dev` 實測**仍失敗**——workerd 是獨立 binary，node 版本救不了 glibc 需求；本機 bisect 實證 workerd 1.20231218.0 為最後 glibc-2.31 相容版（1.20240731.0 起全擋），即 AGENTS.md 記載的 dev-tunnel.sh 工作流在本機從未可跑（與 wrangler 升級無關，非本輪回歸）。回溯更正：cycle-1 REFLECT R4「`npm test` app pool 60/60 + dry-run 綠（4.129）」在本機物理上不可能成立（沿襲 d8a6c9c 修復的報告幻覺模式）——已劃記更正，正確驗證環境為 CI runner；AGENTS.md/CLAUDE.md「Dev 啟動」段補環境限制表（workerd ❌ / wrangler CLI ⚠ node≥22 / pre-push 降級），移除舊主機 IP 192.168.1.200 殘留。

### [2026-09-04] 採用協議補完輪二：Step 4/6 CI 缺口 + seal-check hang + Layer-2 guard 補齊（TODO-REVIEW 16→2）
**目標**：依 `~/Code/rules/CLAUDE.md` 七步協議逐項驗證補完——機械缺口（hooks 未裝、baseline 無人跑、guard 逃逸向量、文件殘留）全數落地，TODO-REVIEW 16 項清到剩 2 項外部盤點債。
**原因**：① git hooks 從未安裝（.git/hooks 空）；② `.secrets.baseline` 無任何機制跑它（#13）；③ `seal.sh --check` 的 `get_pass` 在非互動環境讀 stdin 永久阻塞（違反合約「密碼不可得降級 warn」——§L/§M 直跑被 hang 13 分鐘實證）；④ 系統 python3=3.8 無 tomllib，Makefile/smoke/hook 的 §L/§M 必炸；⑤ guard 六個逃逸向量（#9–#12/#14/#15）+ AGENTS↔CLAUDE 無機械鎖（#16）+ CSS 重複定義與不平衡 @media（#1）+ 01-CLAUDE.md 五段範本殘留（#2–#6）；⑥ `worker-configuration.d.ts`（cf-typegen 產物）被追蹤造成 baseline 六個 RFC 範例字串假陽性。
**預期結果**：hooks 就位（python3.12 探測）；CI 加 baseline freshness step（ENGINEERING_GUIDE §5.2）；seal-check `</dev/null` 不再 hang；§B 主規則「.prepare( 引數非字面值開頭即違規」（四向量 fixture 鎖定）＋引號貼鄰串接（SQL 算術不誤報）；§A 無引號鍵、§G 反向鎖、§E/D5 雙引號、1b `grep -z` 全文（多行 JSONC 注入證明）、AGENTS↔CLAUDE body guard、tests/bindings.test.ts 行為測試；layout.ts 括號深度 0 單一 status-badge；01-CLAUDE.md 五段適配注記；gen 檔 untrack+gitignore。
**範圍**：`.github/workflows/main.yml`、`.gitignore`、`.secrets.baseline`（refresh）、`secrets-archive/{seal.sh,pre-commit-check.sh}`、`scripts/{install-git-hooks.sh,portability-smoke.sh}`、`Makefile`、`tests/guards/{portability,framework}.test.ts`、`tests/bindings.test.ts`（新）、`src/views/layout.ts`、`01-CLAUDE.md`、`TODO-REVIEW.md`。無 schema 變動、無 secret 值變動。
**驗證**：guards pool 21/21 ✓；tsc+eslint ✓；§L/§M/archive 三件套 ✓；seal-check 無密碼場景 WARN exit 0（hang 修復）✓；多行 JSONC 注入 FAIL→還原綠（D38）✓；baseline freshness `scan --baseline` exit 0 ✓；style 區括號深度 0 ✓。app pool 本機 glibc 2.31<2.32 無法跑（pre-existing 環境限制；runner 狀態見後續「CI runner 離線」條目）。
**事後修正（2f0aabb）**：本輪曾把 `worker-configuration.d.ts`（cf-typegen 產物）untrack+gitignore——回歸：CI fresh checkout 的 typecheck TS2688（tsconfig `types` 引用它；本機/runner node 20 跑不動 wrangler 4.129 的 `wrangler types`（需 node 22），無法再生）。revert 回 committed 策略；教訓：untrack 一個 tsconfig 引用的生成檔前，[MUST] 先驗「無此檔時 typecheck 仍綠」。

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
