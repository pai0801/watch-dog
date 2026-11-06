# tests.md — 測試地圖（D26 核心集 / D28）

> 由 derive-tests 產出：07-ALL-IN-ONE cycle 2026-11-06（03 §5b）。
> 3 段分離，每條 rule 帶 status。測試總數隨開發變動——以 `npm test` 當次輸出為準（D37：文檔不寫死）。

## Existing coverage

| use-case | rule | expected (incl. deny) | evidence (doc + code) | status | CI-gate |
|---|---|---|---|---|---|
| 服務上報心跳 | permissions.md §pulse：Bearer token 即身分 | 正確 token → 200 狀態推進；錯 token → 403；缺 header → 401；未知 check → 404 | permissions.md＋src/routes/api.ts:248；tests/api.test.ts | existing | gating-main |
| 封閉註冊 | permissions.md：未知 project `PUT /api/config` → 404 | 未知 project → 404（存在性遮蔽）；已知+對 token → 200 | permissions.md＋src/routes/api.ts:74；tests/api.test.ts | existing | gating-main |
| 公開 status 不洩 token | permissions.md：公開 feed 剝除 token | 回應無 `token` 欄位（deny：洩漏即 fail） | permissions.md＋src/routes/api.ts:382；tests/api.test.ts | existing | gating-main |
| admin Basic Auth gate | permissions.md：admin 帳密成對 | 缺憑證 → 401 challenge；錯密碼 → 401；對帳密 → 200 | permissions.md＋src/middleware/adminAuth.ts；tests/admin.test.ts | existing | gating-main |
| admin 失敗鎖定（N2） | permissions.md deny cases：20 次/15 分/IP 鎖定 | 第 21 次（即使憑證正確）→ 429；他 IP 不受影響；成功登入清計數；視窗過期重置 | permissions.md＋src/services/loginGuard.ts；tests/loginGuard.test.ts | existing | gating-main |
| admin CSRF guard | permissions.md：非 GET 需 XHR marker | 無 marker → 403（跨站表單 deny） | permissions.md＋src/middleware/adminAuth.ts:27；tests/admin.test.ts | existing | gating-main |
| security headers（N1） | architecture.md Known-risks/headers 基準 | HTML＋API＋401 回應皆含 XFO DENY/nosniff/Referrer-Policy/HSTS（deny：缺任一即 fail） | architecture.md＋src/index.ts secureHeaders；tests/securityHeaders.test.ts | existing | gating-main |
| check 狀態機 | flows.md §1：ok/error/dead 轉移＋CAS | error 不被併發 ok 洗掉（CAS）；dead 轉移不推進 last_seen；escalation 15 分窗 ≥3 | flows.md＋src/services/logic.ts；tests/logic.test.ts | existing | gating-main |
| 引擎隔離（不變式①） | flows.md §2：fail-dead 段外失敗不拖垮偵測 | scheduler/usage 錯誤後 dead-check 仍運轉（雙釘測試） | flows.md＋src/cron.ts；tests/cron.test.ts | existing | gating-main |
| scheduler 註冊/觸發 | flows.md §3：CRUD＋HMAC fire contract＋at-most-once | secret 回傳恰好一次；ownership mismatch → 404；先進位 next_run_at；簽名＝RFC 4231 KAT | flows.md＋src/routes/schedules.ts＋src/services/scheduler.ts；tests/schedules.test.ts | existing | gating-main |
| 外部觸發去重 | flows.md §2：recency guard 30s | 剛跑過 → skipped:true；錯 token → 401；缺 secret → 503 | flows.md＋src/routes/trigger.ts；tests/trigger.test.ts | existing | gating-main |
| issues 狀態機/保險絲 | flows.md §4：fingerprint 去重、attempt 保險絲、claim 維護 | 重複指紋不重複掛號；>2 attempts → escalated+critical；feedback 狀態轉移 409 deny cases | flows.md＋src/services/issues.ts；tests/issues.test.ts | existing | gating-main |
| CF 用量警示 | flows.md §5：閾值/投影/CAS claim | 60%/80% 分級；投影永不 critical；升級單次（CAS） | flows.md＋src/services/cfUsage.ts；tests/cfUsage.test.ts | existing | gating-main |
| 公開面 id 洩漏防護 | permissions.md：32-hex account_id 永不回應 | fragment/錯誤面板無 32-hex regex 命中 | permissions.md＋src/services/cfResources.ts；tests/dashboard.test.ts＋tests/cfResources.test.ts | existing | gating-main |
| secrets 合約 | variables.md：三方同步＋assertBindings | manifest ≡ bindings ≡ wrangler secrets.required；缺 required secret → fetch 拋 | variables.md＋src/lib/bindings.ts；tests/bindings.test.ts＋tests/guards/portability.test.ts §F/§G | existing | gating-main |
| 架構 guard 家族 | ENFORCEMENT_REGISTRY：§A-§N＋D16-D39 | 靜態 SQL/預算/import 隔離/文檔集/registry 完整性（結構驗證，非行為） | registry＋tests/guards/*.test.ts | existing | gating-main |

## Proposed tests

| use-case | rule | expected (incl. deny) | evidence | status | type |
|---|---|---|---|---|---|
| 匿名面限流（N10） | architecture.md Known-risks #1：公開端點 best-effort 限流 | 同 IP 高頻 GET /api/status → 429（best-effort，勿宣稱嚴格配額）；不同 IP 不互相影響 | TODO-REVIEW N10 | proposed | automated unit |
| admin 建 project token 熵（N12） | permissions.md：token 強度 | 自貼低熵值 → 400（deny：只驗長度的現狀）；CSPRNG 產生 → 200 | TODO-REVIEW N12 | proposed | automated unit |
| CDN script SRI（N13） | architecture.md Known-risks：第三方 script 完整性 | Layout 的 CDN `<script>` 帶 integrity 屬性（deny：無 integrity 即 fail） | TODO-REVIEW N13 | proposed | guarded live |

## Gaps

| use-case | rule | expected (incl. deny) | evidence | status | exposure |
|---|---|---|---|---|---|
| 換帳號 runbook 演練 | deployment.md §Migration：模式 B ID 替換 | 文件記載步驟可執行（人工演練） | documentation/deployment.md | none | LOW（單操作者、無搬移計畫） |
| Windmill heartbeat 自舉 check 端到端 | flows.md §4：automation:windmill-pulse 自舉 | heartbeat 後 check 存在且走 fail-dead（部分覆蓋於 issues.test；端到端 cron 路徑人工驗證） | flows.md＋docs/WINDMILL-CONTRACT.md | none | LOW |
