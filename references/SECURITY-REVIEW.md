# SECURITY-REVIEW — 資安檢查機制（07 Phase A 掛點）

> SSoT：資安檢查的方法論全部在這裡。07-ALL-IN-ONE Phase A（掃描）只引用本檔，[NEVER] 抄錄條文。
> 設計原則：**機械可執行優先**——每條檢查項附指令或明確判準，agent 可直接跑出 PASS/GAP；[NEVER] 空泛條目（「加強安全」這種字 [NEVER] 出現）。
> 依賴安全通告的掃描與修補在 `references/DEPENDENCY-HEALTH.md`（DEP-HEALTH），本檔 [NEVER] 重複——本檔管的是**代碼與配置層的資安面**。
> 起源：mothership 2026-11-06 雙 security-reviewer 深審（MOTHERS-051）——「以為存在的防線實際沒開」（BA limiter workerd 靜默停用）是本機制要杜絕的失敗形態。

## §1 掃描（Phase A 掛點，SEC-REVIEW）

[MUST] 每 cycle 逐項跑，產出**資安面分級表**（併入 TODO-REVIEW，格式同 DEP-HEALTH 分級表）：

### 1a. 限流與重試限制覆蓋（auth 面）

對每個**公開 auth 端點**（sign-in / sign-up / password reset / email resend / invitation accept）列表回答「實際生效的限流有幾層」：

- [MUST] grep middleware 掛載點（例：`grep -rn "rateLimit\|rate-limit" src/`）——自建限流層的存在≠生效，[MUST] 確認掛在正確 route；
- [MUST] library 內建限流**實證 enabled**（[NEVER] 信 default——見 §2 陷阱 1）：Better Auth 檢查 `options.rateLimit?.enabled` 是否顯式設定＋建置產物 `grep -o "enabled: options.rateLimit" dist/server/chunks/*.mjs` 路徑；
- [MUST] 失敗計數（ban/lockout）跨 isolate（KV/D1/DO），且**只認 `cf-connecting-ip`**（[NEVER] x-forwarded-for 做 key——可偽造）；
- [GAP 判準] 任一 sign-in 類端點少於兩層（體積限流＋失敗計數）→ High。

### 1b. session 與 cookie

- [MUST] cookie 屬性四項：httpOnly / sameSite（lax+）/ secure（https）/ 正確 path；
- [MUST] sign-out 是 server-side 刪 session（[NEVER] 僅清 cookie）；
- [MUST] 改密碼路徑撤銷其他 session（BA：`revokeOtherSessions: true`）。

### 1c. CSRF 與匿名面

- [MUST] 每個 state-changing 端點（POST/PUT/PATCH/DELETE）回答「鑑權因子是什麼」：ambient cookie → [MUST] Origin 檢查；Bearer/HMAC → 可豁免（無 ambient credential）但 [MUST] 列明；
- [MUST] 每個**無登入端點**（webhook callback / 匿名查單 / 公開表單）列舉鑑權因子＋限流；識別碼隨機性用 CSPRNG（`crypto.getRandomValues`，[NEVER] `Math.random`）。

### 1d. security headers

- [MUST] 四項基準 header 存在於 API 與頁面回應：`X-Frame-Options: DENY`（或 CSP frame-ancestors）/ `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Strict-Transport-Security`（https 部署）；
- 驗證指令：`curl -sI <prod-url>/api/health | grep -iE "x-frame|nosniff|referrer|strict-trans"`。

### 1e. headers/限流的測試鎖定

- [MUST] §1a/1d 的結論以 unit/guard 測試鎖定（例：assert 四 header 存在、assert limiter options enabled）——[NEVER] 只靠人工 grep 一次。

## §2 CF 棧陷阱庫（workerd 環境的已知靜默失效模式）

審計時 [MUST] 對照本節逐條檢查；新發現的陷阱 [MUST] 回寫本節＋`putkm`（tags 含 `security`）：

1. **NODE_ENV 類 library 預設開關**：workerd 上 `process.env` 是空 polyfill → 任何 library 用 `NODE_ENV === 'production'` 決定 enabled 的功能（rate limiter / production check / debug guard）**默認關閉且零症狀**。修法：顯式設定該選項（[NEVER] 信 default）。實例：Better Auth limiter（dev-brain `8837d0d0928b`，mothership MOTHERS-051 H-1）。
2. **KV read-modify-write race**：get→+1→put 非原子，同步併發 burst 全部讀到同份 state → 限流與 ban 同時被穿透。緩解：失敗計數門檻＋最終一致收斂；嚴格配額用 D1 `UPDATE ... RETURNING`。
3. **KV eventual consistency（~60s 跨 PoP）**：限流是 best-effort（abuse reduction），[NEVER] 當嚴格配額宣稱。
4. **XFF 可偽造**：限流/ban key 只取 `cf-connecting-ip`；XFF fallback 取第一個 entry = 取攻擊者可控端。
5. **`Math.random` 非密碼學**：workerd 的 Math.random 非 CSPRNG——付款/查單識別碼、token 一律 `crypto.getRandomValues`。
6. **miniflare 常數 cf-connecting-ip**：E2E 環境所有請求同 IP——限流測試用 unit 直測 service 層＋環境 bypass 旗標（`ENVIRONMENT=development` bypass 要 fail-closed：未設值時保護在）。

## §3 findings 分級與修復時限

| 級別 | 判準 | 時限 |
|---|---|---|
| **Critical** | 未經鑑權可 RCE/資料外洩/跨租戶寫入 | 立即——當 cycle 修＋評估是否需下架 |
| **High** | 防線以為存在實際沒開／依賴 critical CVE／零基準 header | 當 cycle [MUST] 修（匯入 Phase B，走 02 THINK→驗證） |
| **Medium** | 單層防護被已知手法穿透（race/非 CSPRNG）／條件性提權路徑 | 下 cycle 前修；逐卡 |
| **Low** | defense-in-depth 缺口／前瞻性閘（未上線功能面的預防） | TODO-REVIEW 登錄 |

- [MUST] 審計產出開看板卡留紀錄（含分級表；跨維度結論掛 HTML 報告——per `~/Code/rules/references/10-ai-html-report.md` 兩層式）。
- [MUST] 執行 agent：安全審計 ≥ opus（07 §0 / 02 §3）；「檢查過沒問題」清單與 findings 同步產出（覆蓋證據，[NEVER] 只列問題）。
- [MUST] 修復項 regression 鎖定：每個修復帶 unit/guard 測試（04 §8 模板），CHANGELOG fix 條目帶 `(locked: D##)`。
