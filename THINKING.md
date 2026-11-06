# THINKING — 思考模板（Cloudflare Stack）

> 任何程式碼之前，[MUST] 輸出 THINK block。
> 遇到 BUG → [MUST] 先遵循 `05-FIX-SPEC.md` 修復流程。

---

## THINK Block（強制）

```
THINK:
1. ROOT CAUSE:     （根本原因，不是表面症狀。問「為什麼」至少兩次）
2. CORRECT LAYER:  （R2 Data / D1 / API Route / Component / i18n / CSS / Config）
3. AFFECTED FILES: （會動到哪些檔案，爆破半徑多大）
4. ASSUMPTIONS:    （這次修改依賴哪些假設？哪個最可能錯？）
5. SIMPLER PATH:   （有沒有更簡單的做法？能不能只改一行？）
6. RISK:           （改壞了最嚴重的後果？能不能 rollback）
7. VERDICT:        PROCEED / STOP（架構有問題則 STOP，先修架構）
```

---

## 規則

- **VERDICT 為 STOP → [NEVER] 寫程式碼。先修架構，再重來。**
- **SIMPLER PATH 有明確答案 → [MUST] 優先採用最簡單的路。**
- **ASSUMPTIONS 最可能錯的假設 → [MUST] 先驗證再繼續。**
- [NEVER] 因為「改動很小」就省略 THINK block。
- [MUST] THINK block 輸出後才開始寫程式碼，不可事後補寫。

---

## Cycle 2026-11-06 — 07-ALL-IN-ONE Phase B THINK blocks

### THINK N1 — security headers（TODO-REVIEW N1，SEC H-2）

```
THINK:
1. ROOT CAUSE:     app 從未掛 header middleware——歷史上每個功能輪只關心自己的路由，baseline header 無人擁有。
2. CORRECT LAYER:  Middleware（app.use('*')，src/index.ts）——所有回應（HTML+API）統一。
3. AFFECTED FILES: src/index.ts（+1 import +1 line）；tests（+header 斷言）。半徑 2 檔。
4. ASSUMPTIONS:    hono/secure-headers 的預設集＝X-Frame-Options DENY/nosniff/Referrer-Policy/HSTS。最可能錯：預設 Referrer-Policy 值或 HSTS 在 workers.dev（http）上的行為——需實測斷言確認。
5. SIMPLER PATH:   hono 內建 secureHeaders() 一行（vs 手寫四行 c.header）。已是最簡。
6. RISK:           htmx 同源輪詢不依賴 framing/第三方資源，DENY 無副作用；CDN script 載入不受這四 header 影響。Rollback＝拔一行。
7. VERDICT:        PROCEED
```

### THINK N2 — admin Basic Auth 限流（TODO-REVIEW N2，SEC H-1）

```
THINK:
1. ROOT CAUSE:     adminAuth 從建制起只有「驗證」沒有「節流」——單操作者內部工具的威脅模型假設 workers.dev URL 不公開，但 URL 已進 README（prod URL）＝假設破產。
2. CORRECT LAYER:  Middleware 層（adminAuth 內）＋ R2→D1（失敗計數跨 isolate 需持久層；KV 有 race/最終一致陷阱，SEC §2 陷阱 2/3）。
3. AFFECTED FILES: src/middleware/adminAuth.ts（計數邏輯）、src/db.sql（+login_failures 表）、src/lib/bindings.ts 不動（非 secret）、tests/admin.test.ts（+service 層直測）。半徑 3 檔＋schema。
4. ASSUMPTIONS:    (a) cf-connecting-ip 在 workers.dev 恒存在（平台保證）；(b) 攻擊者無法換 IP（單 IP 模型夠用——分散式攻擊是 WAF 層工作，此處 best-effort）。最可能錯：(a)——本地 wrangler dev 測試環境可能無此 header，計數需對缺 header 容錯（single bucket）。
5. SIMPLER PATH:   只做失敗計數（單表單 UPDATE…RETURNING）不做體積限流——SEC §1a 判準「兩層」要求體積＋失敗計數；但 admin 面流量＝單操作者，體積限流的實益＝擋 429 洪水，失敗計數已擋 credential stuffing。裁決：失敗計數為本輪核心，體積限流用同一計數的 429 邏輯覆蓋（每請求都過計數 gate＝事實上的體積上限）——一張表一個機制同時滿足兩層語義。
6. RISK:           D1 寫入放大——攻擊者灌 401 燒寫入額度。緩解：先 SELECT 已鎖定則直接 429 不寫（寫入上限＝threshold/window/IP）；正常操作失敗近零。Rollback＝middleware 拔除（表留著無害）。
7. VERDICT:        PROCEED
```

### THINK N3 — hono 安全升級 floor ↑ 4.13.16（TODO-REVIEW N3，DEP-HEALTH P0）

```
THINK:
1. ROOT CAUSE:     package.json hono ^4.11.7 floor 落後 4.13.16——4.13 帶 timing hardening（basicAuth/bearerAuth）與 serveStatic/CORS CVE 修補。
2. CORRECT LAYER:  Config（package.json floor）＋ lock（npm update hono）。
3. AFFECTED FILES: package.json、package-lock.json。半徑 2 檔，zero code change 預期。
4. ASSUMPTIONS:    4.11→4.13 semver 內無 breaking（minor）。最可能錯：hono/html 或 secure-headers 模組路徑變動——tsc+test 兜底。
5. SIMPLER PATH:   caret floor 上調（DEP-HEALTH §2 標準動作）；npm audit fix 收 transitive。無更簡。
6. RISK:           框架 runtime 行為修補（cookie 解析等）是主要回歸觀察點——測試套件（256 tests）兜底；N1 的 secureHeaders 同輪落地會一起驗證。
7. VERDICT:        PROCEED
```

