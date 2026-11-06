# DEPENDENCY-HEALTH — 依賴健康掃描與升級批次（07 Phase A/B 掛點；跨棧共享）

> SSoT：依賴升級的方法論全部在這裡（root `references/` 與 {cloudflare,node,python} stack copies byte-identical，由 `validate-references-parity.sh` 鎖定）。07-ALL-IN-ONE Phase A（掃描）與 Phase B（執行）只引用本檔，[NEVER] 抄錄條文。
> 設計原則：**安全修補與版本躍遷分離**——安全批次走 semver 內修補（zero code change 預期），major 躍遷逐卡單獨驗證。
> 工具映射：JS 生態（cloudflare / node）→ `npm outdated` + `npm audit`；python → `pip list --outdated` + `pip-audit`。**同分級同規則**。

## §1 掃描（Phase A 掛點）

[MUST] 每 cycle 跑三項，產出**依賴健康分級表**（併入 TODO-REVIEW）：

```bash
npm outdated                    # 版本落後全景（Current / Wanted / Latest）
npm audit --omit=dev            # 生產依賴安全通告（direct 優先）
npm audit                       # 全量（含 dev/transitive）
```

（python 專案映射：`pip list --outdated` + `pip-audit`，產出同格式分級表。）

分級表三欄：
| 級別 | 定義 | 處置 |
|---|---|---|
| **P0 安全修補** | direct deps 的 high/mod 安全通告 | 本 cycle [MUST] 升級，匯入 Phase B 待辦 |
| **P1 semver 收斂** | caret 範圍內的 patch/minor 落後 | 本 cycle 順手 `npm update`（零風險面） |
| **P2 major 規劃** | 最新版與 range 的 major 差距 | [NEVER] 本批動——逐卡升級，卡上註明相容性配對（工具鏈類如 TS/ESLint/vitest 需配對驗證生態套件） |

transitive dev-only 通告：`npm audit fix`（非 force）收斂；不可修項逐條列理由（哪條通告、為何不動）。

## §2 執行規則（Phase B 掛點）

- [MUST] 維持既有 pin 風格：exact-pin 套件（如 `zod: "4.3.6"`）改版號繼續 pin；caret 套件上調 floor（如 `^3.4.0 → ^3.4.17`）確保 fresh install 拿到修補版。python 映射：requirements/pyproject 同步改 pin 版號（[NEVER] 只升環境不升 lock 檔）。
- [NEVER] `npm audit fix --force`（會混入 major 躍遷，破壞 P0/P2 分離）。
- 預期 **zero code change**：升級引發程式碼必須改動（API 變更、型別收緊）→ 該套件視同 P2，移出安全批次，走 05-FIX-SPEC 分類處理。
- [MUST] 升級後重跑驗證組（各棧 07 §5.1：JS = tsc/lint/test/build；python = ruff/mypy/pytest/pre-commit）——框架 runtime 行為修補（hono cookie 解析、SSR/hydration、ORM query 行為）是主要回歸觀察點，靠測試套件兜底。

## §3 記錄

- [MUST] CHANGELOG 記依賴層變更（哪條安全通告→哪個版本，可追溯）。
- [ALWAYS] 升級踩到非顯而易見的坑（行為變化、transitive 衝突）→ `putkm` 記錄（tags: `dependency`, `upgrade`, 生態名）。
- 範本實例：web-v01 2026-10-27 WEBV01-161——14 條 audit（7 high direct）、五套 pin 改版＋八套 caret floor 上調＋`npm audit fix` 收 transitive、全部 major 落後逐卡 defer。
