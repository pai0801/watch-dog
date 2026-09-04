# Guard 覆蓋率回報（Layer-2）— watch-dog

> Consumer 端 Layer-2 guard 覆蓋率回報（依 `~/Code/rules/CLAUDE.md`「Layer-2 guard 覆蓋率回報」節）。
> **[NEVER] 直接改 rules repo 的 `guard-coverage-map.toml`**——本檔是回報載體，由 rules-repo owner（@peter）序列化進 map。
> § 定義真源：`~/Code/rules/references/PORTABILITY-GUARDS.md`（canonical §A–§M）；status 詞彙 / via 語意見 rules `docs/2026-07-31-guard-coverage-map-design.md`。
>
> 首版 2026-09-04（框架採用輪，rules/CLAUDE.md Steps 1–7 補完）。

## 逐 § 狀態（§A–§M，13/13 impl，零 pending / 零 na）

| § | Guard | status | via（grep -F 可驗） | note |
|---|---|---|---|---|
| A | secret-not-in-vars | impl | `tests/guards/portability.test.ts::§A` | manifest [secrets] 鍵不進 wrangler `[vars]`（jsonc 物件掃描）＋src 無明文賦值 |
| B | raw-SQL 掃描 | impl | `tests/guards/portability.test.ts::§B` | **watch-dog 適應版**（01 §3 注記：無 Drizzle，D1 原生）：每個 `.prepare(` 參數區段必為靜態字面值，參數一律 `.bind()`；攔 `${` 內插與 `'+var` 串接（附行號）。附 §B 自驗 fixture（違規樣本應攔/合法樣本不誤殺，D38） |
| C | manifest 存在＋五段 | impl | `tests/guards/portability.test.ts::§C` | `.portability.toml` 五段齊 |
| D | manifest-consumed | impl | `tests/guards/portability.test.ts::§D` | bootstrap＋verify 兩入口皆驗存在＋可執行（`scripts/bootstrap.sh`、`scripts/portability-smoke.sh`） |
| E | binding-coverage | impl | `tests/guards/portability.test.ts::§E` | touchpoints 誠實化：`env.DB`/`c.env.DB`（原模板含不存在的 DurableObjectNamespace，已移除） |
| F | startup-check-present | impl | `tests/guards/portability.test.ts::§F` | `src/lib/bindings.ts` `assertBindings`＝Layer 2 主力；`src/index.ts` fetch 入口呼叫（§I(b) 斷言接線） |
| G | secrets-required-synced | impl | `tests/guards/portability.test.ts::§G` | Layer 1＝`wrangler.jsonc` `secrets.required`（committed 本檔，非 example）；#14258 首部署陷阱已註記於該檔。**版本敏感**：`secrets.required` 需 wrangler ≥4.62 schema（本 repo 已升 4.129.0——4.61 時期僅 warn 零強制＝安慰劑） |
| H | reverse-coverage | impl | `tests/guards/portability.test.ts::§H` | **watch-dog 適應版**：code 用的 SECRETISH ⊆ manifest `worker ∪ optional_worker`（或非機密 allowlist），捕 under-listing |
| I | env-types ↔ bindings 型別鎖 | impl | `tests/guards/portability.test.ts::§I` | **variant B**（assertBindings repo，無 gateway）：`src/types.ts`（Env+AppBindings 介面）↔ `REQUIRED_BINDING_KEYS` 兩向鎖＋斷言 `src/index.ts` 呼叫 `assertBindings(env)` |
| J | naming-convention | impl | `tests/guards/portability.test.ts::§J` | worker ∪ optional_worker 兩鍵全過 `{VENDOR}_{ROLE}_{TYPE}` 結構，`legacy_names` 空 |
| K | framework-baseline presence | impl | `tests/guards/portability.test.ts::§K` | `.framework-baseline/` 9 檔齊（merge-sync 防靜默退化） |
| L | manifest↔gitignore coherence | impl | `scripts/check-manifest-gitignore.py::§L` | vendored python3（tomllib），pre-commit 接線；`[machine_local].files` 顯式列示雙向 coherence |
| M | code↔env SECRETISH parity | impl | `scripts/check-secrets-coverage.py::§M` | vendored python3，pre-commit 接線；反向 warn 明細見下節（1 筆已歸屬，非真債） |

## 本地 D-guard 與專案 guard（rules 框架採用配套，非 § 對應）

| Guard | status | via | note |
|---|---|---|---|
| D18 registry 完整性 | impl | `tests/guards/framework.test.ts::D18` | 消費者版：registry 覆蓋全框架檔（含 07-ALL-IN-ONE.md）＋無 dangling D## vs 04 |
| D19 FIX-LOG artifact | impl | `tests/guards/framework.test.ts::D19` | entry 具目標/原因/預期結果/範圍四欄位 |
| D20 REFLECT artifact | impl | `tests/guards/framework.test.ts::D20` | R1–R5 各段非空、禁裸 N/A 逃避 |
| D21 THINKING 模板 | impl | `tests/guards/framework.test.ts::D21` | 模板在位 |
| D39 noUnused flags | impl | `tests/guards/framework.test.ts::D39` | tsconfig `noUnusedLocals`/`noUnusedParameters`（14 §2.2 介面收縮） |
| D5 cloudflare:workers 隔離 | impl | `tests/guards/framework.test.ts::D5` | gateway `src/lib/runtime.ts` **尚未建立**（src 目前 0 處 import）——允許清單僅列該（未存在）路徑＝實質全禁；未來引入時集中該檔 |
| as-any 預算 | impl | `tests/guards/portability.test.ts::預算` | `src/` 掃 `as any`/`<any>`，預算 0（2026-09-04 從 20 清到 0，ESLint error 雙鎖） |

## §M 反向 warn 誠實記載（2026-09-04 快照，exit 0 warn 級）

| 名稱 | 解釋 | 實際管轄 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy-time shell env（wrangler CLI 讀取），非 worker runtime binding。**曾於 `docs/plans/2026-02-02:33` 明文洩漏（已 redact，待操作者輪替）** | `.portability.toml` [secrets] meta＋SECRETS.md 表列（[MUST] 輪替中） |

## 接線（guard 何時真的在跑）

- **pre-commit**（framework `pre-commit` hooks，`scripts/install-git-hooks.sh` 為 raw 備援）：§L＋§M＋`secrets-archive/pre-commit-check.sh`。`.secrets.baseline` 為**一次性** detect-secrets 掃描證據（據以發現 docs/plans 洩漏並 redact），未接持續掃描 hook——待辦見 TODO-REVIEW #13。
- **pre-push**：`npm test`（workerd app pool 60＋guards pool 20）。
- **verify 入口**：`./scripts/portability-smoke.sh`（`.portability.toml [verify]` SSoT）。
- **CI**：`.github/workflows/main.yml`（self-hosted runner，braingo 模式）→ `make install` → `make ci` → backup → cleanup。

## 驗證證據（2026-09-04 實跑）

- `npm run test:guards` → **20/20 綠**（portability 14、framework 6）。
- `npm run test:app` → **60/60 綠**（workerd pool）。
- `python3 scripts/check-manifest-gitignore.py` → exit 0（一致 ✓）；`python3 scripts/check-secrets-coverage.py` → exit 0（正向綠；反向 1 warn 如上節）。
- D38 non-vacuous 證明：7 項注入違規 → guard FAIL → 還原 → 綠（證據表記於 session progress.txt）。

## 供 rules owner 序列化的回報行

```text
watch-dog: A=impl(via=tests/guards/portability.test.ts::§A), B=impl(via=tests/guards/portability.test.ts::§B,note=D1 原生適應版 .prepare 靜態字面值+.bind() 含自驗 fixture), C=impl(via=tests/guards/portability.test.ts::§C), D=impl(via=tests/guards/portability.test.ts::§D), E=impl(via=tests/guards/portability.test.ts::§E,note=touchpoints 誠實化 env.DB/c.env.DB), F=impl(via=tests/guards/portability.test.ts::§F,note=src/lib/bindings.ts assertBindings index.ts 接線), G=impl(via=tests/guards/portability.test.ts::§G,note=wrangler.jsonc committed 本檔 需 ≥4.62 schema 本 repo 4.129), H=impl(via=tests/guards/portability.test.ts::§H,note=worker ∪ optional_worker 適應), I=impl(via=tests/guards/portability.test.ts::§I,note=variant B src/types.ts↔REQUIRED_BINDING_KEYS+index.ts 呼叫斷言), J=impl(via=tests/guards/portability.test.ts::§J), K=impl(via=tests/guards/portability.test.ts::§K), L=impl(via=scripts/check-manifest-gitignore.py::§L,note=vendored python pre-commit), M=impl(via=scripts/check-secrets-coverage.py::§M,note=vendored python 反向 warn 1 筆已歸屬 CLOUDFLARE_API_TOKEN deploy-time 待輪替)
```
