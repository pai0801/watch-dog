# PORTABILITY-GUARDS — 09-PROJECT-PORTABILITY 護欄模板(跨 stack)

> 對應 `09-PROJECT-PORTABILITY.md` §1/§2。三條機器可驗 guard,貼上即用。
> Cloudflare 專案放 `workers/tests/portability.test.ts` 或併入既有 `guards.test.ts`;Python 專案轉成 pytest(等價 `glob`+`read`)。
> 採用 `fast-glob`(`globSync`) + Node `fs`;偵陽性優先(false positive 擋下比漏放好),例外走顯式 allowlist。

---

## §A — secret-not-in-vars(secret 與 [vars] 分離)

> §1.2:secret 必須走 `wrangler secret put` / dotenv,**[NEVER]** 明文進 `wrangler.toml` `[vars]` 或 git。
> 掃 `wrangler.toml` / `wrangler.*.toml` 的 `[vars]` 段,比對 `.portability.toml` `[secrets]` 清單——任一 secret key 出現在 `[vars]` → fail。

```typescript
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { globSync } from 'fast-glob';

const REPO = resolve(__dirname, '..', '..');

it('A: no secret key leaks into wrangler [vars] or source', () => {
  const manifest = join(REPO, '.portability.toml');
  if (!existsSync(manifest)) return; // manifest 存在性由 §C 把關
  const toml = readFileSync(manifest, 'utf-8');

  // 收集 [secrets] 段所有 key 名(worker=… / python_env=… / 或裸 "KEY")
  const secretsSection = toml.split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? '';
  const secretKeys = [...secretsSection.matchAll(/"?([A-Z][A-Z0-9_]{2,})"?\s*=/g)]
    .map(m => m[1])
    .flatMap(k => k.includes(',') ? k.split(',').map(s => s.trim()) : [k])
    .filter(Boolean);
  // 也抓裸列舉值(如 worker = ["A", "B"])
  const listed = [...secretsSection.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map(m => m[1]);
  const keys = new Set([...secretKeys, ...listed]);
  if (keys.size === 0) return;

  const violations: string[] = [];

  // 1. wrangler [vars] 段不得含任一 secret key
  for (const w of globSync('wrangler*.toml', { cwd: REPO, absolute: true })) {
    const content = readFileSync(w, 'utf-8');
    const varsSection = content.split(/\[vars\]/)[1]?.split(/^\[/m)[0] ?? '';
    for (const k of keys) {
      if (new RegExp(`\\b${k}\\b`).test(varsSection)) {
        violations.push(`${w}: secret key ${k} 出現在 [vars]`);
      }
    }
  }

  // 2. 源碼不得出現 "KEY = '<literal>'" 指派(明文 commit)
  for (const f of globSync(['src/**/*.ts', 'workers/**/*.ts'], { cwd: REPO, absolute: true, ignore: ['**/tests/**'] })) {
    const content = readFileSync(f, 'utf-8');
    for (const k of keys) {
      if (new RegExp(`['"]${k}['"]\\s*=\\s*['"][^'"]+['"]`).test(content)) {
        violations.push(`${f}: 明文指派 secret ${k}`);
      }
    }
  }

  expect(violations, `secret 洩漏:\n${violations.join('\n')}`).toHaveLength(0);
});
```

---

## §B — raw-SQL 掃描(框架級,升級 topreview-edge no-raw-sql)

> §2.1:DB 存取 **[MUST]** 走 ORM(Drizzle / SQLAlchemy),**[NEVER]** raw vendor SQL。
> 抓 D1 `db.execute(` / 裸字串 query;允許 `db.$with` / migration SQL / allowlist。

```typescript
import { readFileSync } from 'fs';
import { globSync } from 'fast-glob';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
// 顯式 allowlist:migration / seed / 一次性 script(那裡 raw SQL 合理)
const ALLOW = ['**/migrations/**', '**/drizzle/**', '**/seed/**', '**/scripts/**'];

it('B: no raw vendor SQL — DB access via ORM (Drizzle/SQLAlchemy) only', () => {
  const files = globSync(['src/**/*.ts', 'workers/**/*.ts', '**/*.py'],
    { cwd: REPO, absolute: true, ignore: ['**/tests/**', '**/node_modules/**', ...ALLOW] });
  const violations: string[] = [];

  // D1 / better-sqlite raw: db.execute( / .exec( 帶字串
  const rawTs = /\.(?:execute|exec)\s*\(\s*['"`]/;
  // Python 裸字串 query: execute("...") / execute('...') 含 SQL 關鍵字
  const rawPy = /\.(?:execute|executemany)\s*\(\s*[fr]?['"]/;

  for (const f of files) {
    const content = readFileSync(f, 'utf-8');
    const lines = content.split('\n');
    const pat = f.endsWith('.py') ? rawPy : rawTs;
    lines.forEach((line, i) => {
      if (pat.test(line)) {
        // 例外:字串內若只是 ORM 佔位(sql`...` Drizzle tag)不算——只抓裸 execute('...')
        violations.push(`${f}:${i + 1} ${line.trim()}`);
      }
    });
  }

  expect(violations, `raw SQL 違規(改走 ORM):\n${violations.join('\n')}`).toHaveLength(0);
});
```

---

## §C — manifest 存在性 + 結構檢查

> §1.1:每 repo **[MUST]** 有 `.portability.toml`,含五段。
> 缺檔或缺段 → fail。只驗「存在 + 段落齊全」,不驗內容正確(內容由 A/B/人工 review)。

```typescript
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const REQUIRED_SECTIONS = ['[machine_local]', '[secrets]', '[bootstrap]', '[verify]', '[vendor_lock]'];

it('C: .portability.toml exists with all 5 required sections', () => {
  const manifest = resolve(REPO, '.portability.toml');
  expect(existsSync(manifest), '.portability.toml 缺失(見 09-PROJECT-PORTABILITY §1.1)').toBe(true);
  const content = readFileSync(manifest, 'utf-8');
  const missing = REQUIRED_SECTIONS.filter(s => !content.includes(s));
  expect(missing, `.portability.toml 缺段:\n${missing.join('\n')}`).toHaveLength(0);
});
```

---

## 串接說明

- **[MUST]** 本三項接進該 stack `04-HARDENING_PROTOCOL` 的 guard 套件(`workers/tests/guards.test.ts` 或 pytest),由 pre-commit + CI 跑。
- 預算(raw SQL)**只減不增**:接進後首跑的計數即為基準,後續 **[ALWAYS]** ≤ 基準。
- guard 失敗訊息 **[MUST]** 指向 `09-PROJECT-PORTABILITY.md` 對應章節,讓修的人知道為什麼擋。
