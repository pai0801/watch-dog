# GUARD-TEMPLATES — Cloudflare Stack（D1–D37 guard 測試模板）

> 對應 `04-HARDENING_PROTOCOL.md` 各 `### D##`。本檔收 fenced 測試模板；04 主檔只留 matrix + heading + 描述 + failure-mode + Guard Index。
> 由 04 §8/§8.5-8.8 抽出（2026-07-23 瘦身）。

---

## §8 — 關鍵防線模板

### D1 — 租戶隔離 Guard

```typescript
it('D1: all UPDATE/DELETE WHERE includes tenant filter', () => {
  const files = globSync('src/**/*.ts', { ignore: ['src/tests/**'] });
  const violations: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect .update( or .delete( without storeId/slug in nearby WHERE
      if (/\.(update|delete)\(/.test(line)) {
        const context = lines.slice(Math.max(0, i - 2), i + 5).join('\n');
        if (!/storeId|store_id|slug/.test(context)) {
          violations.push(`${file}:${i + 1}`);
        }
      }
    }
  }
  expect(violations.length, `Violations:\n${violations.join('\n')}`).toBe(0);
});
```

### D2 — API 認證 Guard（ESLint 規則）

```javascript
// eslint.config.js
{
  files: ['src/pages/api/tenants/**/*.ts'],
  rules: {
    'local/require-tenant-auth': 'error'
  }
}
// Rule implementation: POST/PUT/DELETE/PATCH handler
// must check locals.tenant or locals.session
```

### D3 — Dev 端點保護 Guard（ESLint 規則）

```javascript
{
  files: ['src/pages/api/test/**/*.ts'],
  rules: {
    'local/require-prod-guard': 'error'
  }
}
// Rule implementation: exported function must contain
// import.meta.env.PROD check that returns early
```

### D4 — Cookie 安全 Guard（ESLint 規則）

```javascript
{
  files: ['src/**/*.ts'],
  ignores: ['src/tests/**'],
  rules: {
    'local/require-httponly-cookie': 'error',
    'local/no-unsafe-cookie-set': 'error'
  }
}
// Rule implementation: all set-cookie / cookie construction
// must include HttpOnly and Secure flags
// Must use buildSessionCookie() helper, not raw headers
```

### D5 — Import 隔離 Guard

```typescript
it('D5: cloudflare:workers only imported in gateway', () => {
  const files = globSync('src/**/*.ts', { ignore: [
    'src/tests/**', 'src/lib/runtime.ts' // gateway exempt
  ]});
  let violations = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    if (content.includes("from 'cloudflare:workers'")) {
      console.error(`VIOLATION: ${file}`);
      violations++;
    }
  }
  expect(violations).toBe(0);
});
```

### D8 — i18n 一致性 Guard

```typescript
it('D8: locale files have identical keys', () => {
  const locales = globSync('src/i18n/locales/*.json');
  const keySets = locales.map(f => {
    const content = JSON.parse(readFileSync(f, 'utf-8'));
    return { file: f, keys: new Set(Object.keys(content)) };
  });

  const base = keySets[0];
  for (const locale of keySets.slice(1)) {
    const missing = [...base.keys].filter(k => !locale.keys.has(k));
    const extra = [...locale.keys].filter(k => !base.keys.has(k));
    expect(missing.length, `${locale.file} missing keys: ${missing}`).toBe(0);
    expect(extra.length, `${locale.file} extra keys: ${extra}`).toBe(0);
  }
});
```

### D10 — Migration 同步 Guard

```typescript
it('D10: all migrations are applied', () => {
  const migrations = globSync('drizzle/migrations/sql/*.sql');
  const applied = new Set(APPLIED_MIGRATIONS); // project-specific constant
  const unapplied = migrations.filter(m => !applied.has(basename(m)));
  expect(unapplied.length, `Unapplied: ${unapplied}`).toBe(0);
});
```

### Budget Guard 模板（通用）

```typescript
// Adapt pattern for: as-any, raw SQL, eslint-disable, etc.
it('budget guard: [PATTERN_NAME] within limit', () => {
  const MAX_[PATTERN] = N; // Only decrease over time
  const files = globSync('src/**/*.ts', { ignore: ['src/tests/**'] });
  let count = 0;
  const violations: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const matches = content.match(/PATTERN_REGEX/g) || [];
    if (matches.length > 0) {
      violations.push(`${file}: ${matches.length}`);
      count += matches.length;
    }
  }
  if (count > MAX_[PATTERN]) console.error('Violations:', violations);
  expect(count).toBeLessThanOrEqual(MAX_[PATTERN]);
});
```

### Budget 追蹤表

| Guard | Detection Regex | Budget | 只減不增 |
|---|---|---|---|
| as-any | `as any` | 專案自訂 | [ALWAYS] |
| raw SQL | `db.execute\|\.execute(` | 0 | [ALWAYS] |
| import 隔離 | `from 'cloudflare:workers'` | 1 | [ALWAYS] |
| i18n key 差異 | locale JSON diff | 0 | [ALWAYS] |
| 硬編碼字串 | CJK/英文 in JSX | 0 | [ALWAYS] |
| 租戶隔離違規 | WHERE without storeId | 0 | [ALWAYS] |
| eslint-disable | `eslint-disable` | 專案自訂 | [ALWAYS] |

---

## §8.5 — Meta & Artifact Guards

### D18 — Registry 完整性 meta-guard

```typescript
it('D18: every tagged section in 01-06 is registered + guards exist', () => {
  const REPO = resolve(__dirname, '..', '..');          // 專案根
  const registry = readFileSync(join(REPO, 'ENFORCEMENT_REGISTRY.md'), 'utf-8');
  const docs = ['01-CLAUDE.md','02-BUILD-SPEC.md','03-DOC-AND-CODE-REVIEW.md',
                '04-HARDENING_PROTOCOL.md','05-FIX-SPEC.md','06-REFLECT.md'];

  // 1. Count-based coverage（穩健，免字串匹配漏洞）：
  //    每個 doc 的「含 [MUST]/[NEVER]/[ALWAYS] 的 section 數」必須等於
  //    registry 中該 doc 表格的列數。新增 section 沒補列 → 不等 → fail。
  const mismatches: string[] = [];
  for (const d of docs) {
    const content = readFileSync(join(REPO, d), 'utf-8');
    let taggedSections = 0, curHasTag = false, inHeading = false;
    const lines = content.split('\n');
    for (let i=0;i<lines.length;i++){ if(/^#{1,4} /.test(lines[i])){ if(curHasTag)taggedSections++; curHasTag=false; } else if(/\[MUST\]|\[NEVER\]|\[ALWAYS\]/.test(lines[i])) curHasTag=true; }
    if(curHasTag) taggedSections++;
    // registry 該 doc 區塊的表格列數（## NN-XXX.md 之後的 | 開頭列）
    const block = registry.split(new RegExp(`## ${d.replace('.md','')}`))[1]?.split(/^## /)[0] ?? '';
    const regRows = (block.match(/^\| [^|]+ \|/gm) || []).length;
    if (regRows !== taggedSections) mismatches.push(`${d}: doc=${taggedSections} sections vs registry=${regRows} rows`);
  }
  expect(mismatches.length, `Section/row count mismatch (unregistered sections):\n${mismatches.join('\n')}`).toBe(0);

  // 2. registry 中每個 D## 必須在 04 有定義
  const dIds = [...new Set([...registry.matchAll(/\bD(\d{1,2})\b/g)].map(m => `D${m[1]}`))];
  const doc04 = readFileSync(join(REPO, '04-HARDENING_PROTOCOL.md'), 'utf-8');
  const dangling = dIds.filter(id => !new RegExp(`\\b${id}\\b`).test(doc04));
  expect(dangling.length, `Registry D## not defined in 04:\n${dangling.join(', ')}`).toBe(0);
});
```

### D19 — FIX-LOG artifact guard（05-FIX-SPEC §1/§4/§5）

```typescript
it('D19: every CHANGELOG fix has a FIX-LOG entry with 4 fields + quartet', () => {
  // 讀 CHANGELOG 最新 cycle 的 fix bullets；每條對應 FIX-LOG.md 一個 entry
  // entry [MUST] 含：目標 / 原因 / 預期結果 / 範圍 + 驗證四重奏結果（tsc/lint/test/build）
  // 缺欄位或缺 entry → fail。carry/open Human Queue 項目豁免。
  // 與 D17 lock-tag 互補：D17 驗「有 guard」，D19 驗「有計畫+驗證紀錄」。
});
```

### D20 — REFLECT artifact guard（06-REFLECT §3/§4/§5）

```typescript
it('D20: REFLECT.md exists for the cycle with R1–R5 answered', () => {
  // 每個 session/cycle [MUST] 有 REFLECT.md，含 R1([MUST] 遵守) / R2([NEVER] 違反) /
  // R3 / R4 / R5(經驗記錄) 各段非空，且無裸 "N/A" 逃避。
  // 觸發點（end-of-session / pre-commit / post-task）未產 REFLECT → fail。
});
```

### D21 — THINK block artifact guard（02 §1, 05 §3）

```typescript
it('D21: non-trivial diffs reference a committed THINK block', () => {
  // 定義 non-trivial = tier >= standard（見 02 §1.5：>= 2 檔 或碰 critical-path）。
  // 這類變更 [MUST] 在 PR/commit 引用一個 THINK block（THINKING.md 7 欄位），
  // 記錄於 FIX-LOG / BUILD-PLAN / commit message。未引用 → fail。
  // trivial（≤1 檔 且 ≤10 行 且 不碰 critical-path）豁免。
});
```

### D16 — 現況文檔 code-path drift guard（升級：全文檔範圍）

```typescript
it('D16: 現況文檔的 code-path cite 必須指向存在的檔案', () => {
  const REPO = resolve(__dirname, '..', '..');
  // 只掃「現況文檔」——刻意排除歷史審計日誌（TODO-REVIEW.md 等 cite 是缺陷發生時的所在，非現況）
  const HISTORICAL = ['TODO-REVIEW.md', 'FIX-LOG.md', 'CHANGELOG.md', 'REFLECT.md'];
  const docFiles = globSync('{CLAUDE.md,AGENTS.md,README.md,documentation/**/*.md}')
      .filter(f => !HISTORICAL.some(h => f.endsWith(h)));
  // 完整 code-path：src/ workers/ tests/ 等 + 副檔名；在副檔名處停止（不捕行號）
  const pathRe = /(?:src|workers|tests|packages|apps)\/[\w/.-]+\.(ts|tsx|js|astro|svelte)/g;
  const violations: string[] = [];
  for (const doc of docFiles) {
    const content = readFileSync(join(REPO, doc), 'utf-8');
    let m;
    while ((m = pathRe.exec(content)) !== null) {
      const cited = m[0];
      if (cited.includes('{') || cited.includes('}')) continue; // brace 展開非字面路徑
      if (!existsSync(join(REPO, cited))) violations.push(`${doc} cite 幽靈路徑：${cited}`);
    }
  }
  expect(violations, `doc-path drift:\n${violations.join('\n')}`).toEqual([]);
});
```

### D34 — Anti-Phantom Enforcement Audit（meta-meta）

```typescript
it('D34: every registered guard is real, unique, and wired (anti-phantom)', () => {
  const REPO = resolve(__dirname, '..', '..');
  const registry = readFileSync(join(REPO, 'ENFORCEMENT_REGISTRY.md'), 'utf-8');
  const doc04 = readFileSync(join(REPO, '04-HARDENING_PROTOCOL.md'), 'utf-8');
  const dIds = [...new Set([...registry.matchAll(/\b(D\d{1,2})\b/g)].map(m => m[1]))];

  // 1. COLLISION: 04 內每個 D## 恰一個 ### 定義；registry 不引用未定義 D##
  const collisions = dIds.filter(id =>
    (doc04.match(new RegExp(`^### ${id}\\b`, 'gm')) || []).length > 1);
  const undefined_ = dIds.filter(id => !new RegExp(`\\b${id}\\b`).test(doc04));
  expect(collisions, `D## ID collisions:\n${collisions.join(', ')}`).toHaveLength(0);
  expect(undefined_, `registry cites undefined D##:\n${undefined_.join(', ')}`).toHaveLength(0);

  // 2. EXISTENCE + WIRING: guards.test.ts 存在且被 Makefile/pre-commit/CI 引用
  const guardFile = existsSync(join(REPO, 'workers/tests/guards.test.ts'));
  const cfg = [join(REPO,'Makefile'), join(REPO,'.pre-commit-config.yaml'),
               join(REPO,'.github/workflows/main.yml')].filter(p => existsSync(p))
              .map(p => readFileSync(p,'utf-8')).join('\n');
  const wired = guardFile && /guards\.test|vitest run|npm\s+test|make\s+test/.test(cfg);
  expect(guardFile, 'workers/tests/guards.test.ts missing').toBe(true);
  expect(wired, 'guards.test.ts not wired into Makefile/pre-commit/CI').toBe(true);

  // 3. IMPLEMENTATION: 每個 ### D## heading 下方 [MUST] 有一個 it('D##: 或對應 test
  const headings = [...doc04.matchAll(/### (D\d{1,2})[^]*?(?=^### |$)/gm)];
  const proseOnly = headings.filter(h => !/it\(['"]D\d|expect\(/m.test(h[0]))
                            .map(h => h[1]).filter(id => !['D19','D20','D21'].includes(id)); // artifact 類可降為 artifact guard
  //註：artifact 類（D19/D20/D21/D26-D33）的「implementation」由其 validator 存在間接保證，不要求 ### 區內含 it()
});
```

---

## §8.6 — 01 禁止事項 gap Guards

### D22 — Forbidden imports（Node.js / Express / tRPC）

```typescript
it('D22: no Node.js/Express/tRPC imports (Web API + Hono + Astro only)', () => {
  const files = collectTsFiles(WORKERS_SRC, [resolve(WORKERS_SRC,'tests')]);
  const forbidden = /\bfrom\s+['"](node:|express|@trpc|fs|path|crypto)['"]/;
  const violations = files.filter(f => forbidden.test(readFileSync(f,'utf-8')));
  expect(violations.length, `Forbidden imports:\n${violations.join('\n')}`).toBe(0);
});
// ESLint 補強：no-restricted-imports paths: ['node:fs','node:path','express','@trpc/server',...]
```

### D23 — No raw physical DELETE on core tables（軟刪除）

```typescript
it('D23: no physical DELETE on core tables (use deletedAt soft-delete)', () => {
  // flag .delete() / raw "DELETE FROM" on tables in CORE_TABLES set (專案自訂)
  // 例外：migration / cleanup scripts（明確 allowlist）
  expect(violations).toBe(0);
});
```

### D24 — No raw `r2.dev` domain in source

```typescript
it('D24: no raw r2.dev domain (use custom domain)', () => {
  const files = collectTsFiles(FRONTEND_SRC);
  const violations = files.filter(f => /r2\.dev/.test(readFileSync(f,'utf-8')));
  expect(violations.length).toBe(0);
});
```

### D25 — `R2.get()` results must be null-checked

```typescript
it('D25: R2.get() result is null-checked before use', () => {
  // 每個 .get( 後的 binding，附近 [MUST] 有 if (!x) / ?? / ?. null 處理
  // AST 層級較準；regex 版：抓 .get( 後 5 行內無 null-handling
  expect(violations).toBe(0);
});
```

---

## §8.7 — PM / Documentation Artifact Guards

### D26 — Documentation coverage（artifact）

```typescript
it('D26: /documentation/ core set present + architecture.md indexes them', () => {
  // 5 核心檔 existsSync；architecture.md body [MUST] 含其他 4 檔名
  // conditional 缺失時 architecture.md [MUST] 一行註記
});
```

### D27 — Intent-vs-Implementation parity（artifact）

```typescript
it('D27: every documented rule has code cite or honest finding', () => {
  // permissions.md + flows.md 每條 rule [MUST] 有 file:line cite
  // 或對應 TODO-REVIEW.md 一條 finding（含 4 欄位）；silent unverified → fail
});
```

### D28 — Test verification map（artifact）

```typescript
it('D28: tests.md has 3 sections + every rule row has status', () => {
  // tests.md [MUST] match ## Existing coverage / ## Proposed tests / ## Gaps
  // 每條 rule row [MUST] 有 status(existing/proposed/none)
});
```

### D29 — Ship-check gate（guard）

```typescript
it('D29: ship-check wired into pre-push/CI', () => {
  // .git/hooks/pre-push 或 CI workflow [MUST] 含 ship-check step（3 項檢查）
});
```

### D30 — Retrospective（artifact，augments D20）

```typescript
it('D30: retro block exists with action items (owner+deadline)', () => {
  // REFLECT.md/RETRO.md 含 retro block；≥1 action item 含 owner+deadline；carry-over 段存在
});
```

### D31 — Pre-mortem（artifact）

```typescript
it('D31: PreMortem artifact exists before release/harden commits', () => {
  // release/harden commit 前有 PreMortem artifact
  // 每條 launch-blocking Tiger 含 mitigation+owner+date
});
```

### D32 — Release-notes user-facing（artifact）

```typescript
it('D32: latest CHANGELOG entries lead with user benefit', () => {
  // 最新 cycle New/Improved/Fixed/Breaking 條目 [MUST] 以使用者影響開頭
  // Locked/Human Queue 段豁免
});
```

### D33 — Acceptance scenarios before build（artifact）

```typescript
it('D33: non-trivial features reference user-story + acceptance criteria', () => {
  // tier = major（見 02 §1.5）的 BUILD-PLAN/FIX-LOG [MUST] 引用 user-story + ≥1 acceptance criterion
});
```

---

## §8.8 — Handover & Deployment Guards

### D35 — Deployment & Operations Doc（artifact）

```typescript
it('D35: deployment.md exists with all required handover sections', () => {
  // existsSync('/documentation/deployment.md') || existsSync('docs/DEPLOYMENT.md')
  // body [MUST] 含 7 heading：環境矩陣/部署指令/Secrets 與變數/Migration 順序/回滾程序/部署後驗證/維運 Runbook
  // 缺任一 heading → fail
});
```

### D36 — README Handover Parity（guard）

```typescript
it('D36: README is a valid handover entry point (no drift)', () => {
  // 6 項全部 PASS（見 references/HANDOVER-CHECKLIST.md）
  // 任一項 fail → MISSING_DOC Critical 登錄 TODO-REVIEW
});
```

---

## §8.8 — Volatile-number SSoT

### D37 — Volatile-number SSoT（static drift detector）

> 跨現況檔掃描 **labeled** 揮發數字，assert 每個 metric ≤1 distinct value（無 drift）。
> **範圍刻意限 3 個 label**（schema v / test count / route count）——避免裸數字誤判行號/port。
> 其他揮發數值（coverage%、預算計數器 as-any/raw-SQL、table 數）不在此 guard，
> 由各自專屬 guard（D6/D7 預算）或 D16/D26 承載——勿假設 D37 涵蓋全部揮發數。

```typescript
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// `..` ×2 targets <repo>/workers/tests/. Projects with a flat <repo>/tests/
// layout MUST use a single `..` — otherwise REPO resolves one level too high
// and the guard scans nothing (vacuous PASS). Verify via broken-FIX (inject a
// conflicting value into 2 current-state docs → must FAIL).
const REPO = resolve(__dirname, '..', '..');
const HISTORICAL = ['CHANGELOG.md', 'FIX-LOG.md', 'REFLECT.md', 'TODO-REVIEW.md'];
// Lookbehind (?<![A-Za-z0-9]) on bare-digit metrics rejects guard-ID false
// positives like 'D28 tests.md' — the number must be a standalone token, not
// the digits of a D## ref or a suffix of a larger number.
const METRICS: Record<string, RegExp> = {
  schema_version: /schema(?:\s+version)?\s*v?(\d+)/gi,
  test_count: /(?<![A-Za-z0-9])(\d+)\s*(?:passed|tests)/gi,
  route_count: /(?<![A-Za-z0-9])(\d+)\s*(?:routes|endpoints)/gi,
};
function docs(): string[] {
  const root = readdirSync(REPO).filter(f => f.endsWith('.md'));
  const docDir = join(REPO, 'documentation');
  const sub = existsSync(docDir) ? readdirSync(docDir).filter(f => f.endsWith('.md')).map(f => 'documentation/' + f) : [];
  return [...root, ...sub].filter(f => !HISTORICAL.some(h => f.endsWith(h)));
}

it('D37: each labeled volatile metric has ≤1 distinct value across current-state docs', () => {
  const drifts: string[] = [];
  for (const [metric, pat] of Object.entries(METRICS)) {
    const seen: Record<string, string[]> = {};
    for (const doc of docs()) {
      const text = readFileSync(join(REPO, doc), 'utf8');
      let m: RegExpExecArray | null;
      pat.lastIndex = 0;
      while ((m = pat.exec(text))) (seen[m[1]] ??= []).push(doc);
    }
    if (Object.keys(seen).length > 1) drifts.push(`${metric}: ${JSON.stringify(seen)}`);
  }
  expect(drifts, 'volatile-number drift (D37):\n' + drifts.join('\n')).toEqual([]);
});
```
