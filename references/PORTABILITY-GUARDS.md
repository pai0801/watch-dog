# PORTABILITY-GUARDS — 09-PROJECT-PORTABILITY 護欄模板(跨 stack)

> 對應 `09-PROJECT-PORTABILITY.md` §1/§2。五條機器可驗 guard,貼上即用。
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

## §D — manifest-consumed(manifest 入口真實可執行)

> §1.3:manifest `[bootstrap].script` / `[verify].script` 只聲明入口,**[MUST]** 指向真實存在且可執行的腳本,且 CI smoke job 引用同一入口(manifest 與 CI 不平行演化)。
> manifest 列了入口但腳本不存在 / 不可執行 → fail。防止 manifest 淪為與實際流程脫鉤的裝飾文件。

```typescript
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const manifest = readFileSync(resolve(REPO, '.portability.toml'), 'utf-8');

// 從 manifest 抽出 script = "..." 入口(容忍單/雙引號)
const scriptEntry = (section: string): string | null => {
  const re = new RegExp(`\\[${section}\\][\\s\\S]*?script\\s*=\\s*["']([^"']+)["']`);
  const m = manifest.match(re);
  return m ? m[1] : null;
};

for (const section of ['bootstrap', 'verify']) {
  it(`D: [${section}].script 指向存在且可執行的腳本`, () => {
    const entry = scriptEntry(section);
    expect(entry, `.portability.toml [${section}] 缺 script 入口(見 09 §1.1 SSoT 分工)`).not.toBeNull();
    const target = resolve(REPO, entry!);
    expect(existsSync(target), `[${section}].script 指向不存在:${entry}`).toBe(true);
    expect((statSync(target).mode & 0o111) !== 0, `${entry} 不可執行(chmod +x)`).toBe(true);
  });
}
```

> CI 對齊(非程式碼 guard,屬管線檢查):CI 的 fresh-clone job **[MUST]** 呼叫同一 `bootstrap` / `verify` 入口,不得另立平行步驟。review 時人工核對 CI yaml 與 manifest 入口一致。

---

## §E — binding-coverage(touchpoints 與實際程式碼對齊)

> §2.3:`[vendor_lock].touchpoints` **[MUST]** 是可掃描識別字,且**程式碼實際出現的 vendor binding 都被列進 touchpoints**。
> 程式碼有 binding、manifest 沒列 → fail。把 level 從「自評」升級成「被掃描戳得出來」,防止 refactor 後 touchpoints 漂走失準。

```typescript
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const manifest = readFileSync(resolve(REPO, '.portability.toml'), 'utf-8');

// manifest 列出的 touchpoints
const tpBlock = manifest.match(/\[vendor_lock\][\s\S]*?touchpoints\s*=\s*\[([^\]]*)\]/);
const listed = tpBlock
  ? [...tpBlock[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1])
  : [];

// 已知 vendor binding 字典(各 stack 自行擴充)
const KNOWN_BINDINGS = [
  'c.env.DB', 'env.DB', 'c.env.R2', 'env.R2',
  "from 'cloudflare:workers'", 'DurableObjectNamespace', 'env.KV',
];

it('E: 程式碼實際出現的 vendor binding 都在 touchpoints 內', () => {
  const present: string[] = [];
  for (const b of KNOWN_BINDINGS) {
    // grep 原始碼(排除 node_modules / 測試 fixture),只要任一出現即記
    const hit = (() => {
      try {
        execSync(`git -C "${REPO}" grep -lE -- ${JSON.stringify(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))} -- ':(exclude)node_modules' ':(exclude).wrangler'`, { stdio: 'pipe' });
        return true;
      } catch { return false; }
    })();
    if (hit) present.push(b);
  }
  const unlisted = present.filter(b => !listed.includes(b));
  expect(unlisted,
    `程式碼有 vendor binding 但 manifest touchpoints 沒列(見 09 §2.3):\n${unlisted.join('\n')}`,
  ).toHaveLength(0);
});
```

> `KNOWN_BINDINGS` 各 stack 擴充(如 Python 加 `os.environ`、`boto3.client`)。本 guard 只驉「程式碼有的都被盤點」,不強制抽象、不改 level 判定。

---

## 串接說明

- **[MUST]** 本五項(§A–§E)接進該 stack `04-HARDENING_PROTOCOL` 的 guard 套件(`workers/tests/guards.test.ts` 或 pytest),由 pre-commit + CI 跑。
- 預算(raw SQL)**只減不增**:接進後首跑的計數即為基準,後續 **[ALWAYS]** ≤ 基準。
- guard 失敗訊息 **[MUST]** 指向 `09-PROJECT-PORTABILITY.md` 對應章節,讓修的人知道為什麼擋。
