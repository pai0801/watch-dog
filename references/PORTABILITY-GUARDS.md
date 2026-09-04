# PORTABILITY-GUARDS — 09-PROJECT-PORTABILITY + 10-SECRETS-CONTRACT 護欄模板(跨 stack)

> 對應 `09-PROJECT-PORTABILITY.md` §1/§2 與 `10-SECRETS-CONTRACT.md` §3/§5。十條機器可驗 guard(§A–§E 續 09;**§F/§G/§H/§I/§J 續 10**),貼上即用。
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

> `KNOWN_BINDINGS` 各 stack 擴充(如 Python 加 `os.environ`、`boto3.client`)。本 guard 只驗「程式碼有的都被盤點」,不強制抽象、不改 level 判定。

---

## §F — startup-check-present(app 層 env guard 存在且引用所有 secret)

> 對應 `10-SECRETS-CONTRACT.md` §5.2(Layer 2,可靠主力)。
> 合約 `[secrets].worker` 列的每個 name,**[MUST]** 出現在 app 進入點的啟動檢查(`assertBindings` 或等價)裡。缺一個 = 那個 secret 等於沒設防(undefined 靜默進線上)。
> 策略:找含 `missing required` / `assertBindings` / `missing.*secret` 字樣的 guard 檔,收集其 required 陣列的所有字串字面,比對 manifest `[secrets].worker`。manifest 有、guard 沒引用 → fail。

```typescript
import { readFileSync, existsSync } from 'fs';
import { globSync } from 'fast-glob';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');

it('F: assertBindings 引用 manifest [secrets].worker 的每個 name', () => {
  const manifestPath = resolve(REPO, '.portability.toml');
  if (!existsSync(manifestPath)) return; // manifest 存在性由 §C 把關
  const toml = readFileSync(manifestPath, 'utf-8');

  // 收集 [secrets] 段 worker 名稱(支援 worker = ["A","B"] 與裸 KEY =)
  const secretsSection = toml.split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? '';
  const workerBlock = secretsSection.match(/worker\s*=\s*\[([^\]]*)\]/);
  const workerKeys = workerBlock
    ? [...workerBlock[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map(m => m[1])
    : [];
  if (workerKeys.length === 0) return; // 無 worker secret 清單,本 guard 不適用

  // 找 app 層 guard 檔(常見命名),收集所有大寫 KEY 字面
  const guardFiles = globSync(
    ['src/**/bindings.ts', 'src/**/bindings.tsx', 'functions/**/bindings.ts', 'src/**/env.ts', 'src/index.ts'],
    { cwd: REPO, absolute: true },
  );
  if (guardFiles.length === 0) {
    throw new Error('§F: 找不到 app 層 env guard(預期 src/bindings.ts 或同等,見 10 §5.2)');
  }
  const guardLiterals = new Set<string>();
  for (const f of guardFiles) {
    const c = readFileSync(f, 'utf-8');
    for (const m of c.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) guardLiterals.add(m[1]);
  }

  const unguarded = workerKeys.filter(k => !guardLiterals.has(k));
  expect(unguarded,
    `manifest 有 secret 但 assertBindings 沒引用(見 10 §5.2 Layer 2):\n${unguarded.join('\n')}`,
  ).toHaveLength(0);
});
```

> 啟發式:`guardFiles` 的命名清單各 repo 可調整;找不到 guard 檔即 fail(寧願擋下)。Python 等價:找 `assert ... in os.environ` 的啟動模組,比對字面。

---

## §G — secrets-required-synced(wrangler `secrets.required` 與 manifest 同步)

> 對應 `10-SECRETS-CONTRACT.md` §5.1(Layer 1,宣告式快篩)。
> Worker 的 `wrangler.jsonc` / `wrangler.toml` 若宣告了 `secrets.required`,**[MUST]** 與 manifest `[secrets].worker` 一致(否則兩份清單各自漂)。manifest 有、wrangler 沒列 → fail。
> **首次部署例外**(10 §5.1 / issue #14258):全新 Worker 第一次 deploy 需先拿掉 `secrets.required`。此 opt-out **[MUST]** 在該 repo 的 `deployment.md` / ops runbook 註記;guard 檔查 `deployment.md` 含 `first-deploy` / `首次部署` 字樣時允許 `secrets.required` 暫缺。

```typescript
import { readFileSync, existsSync } from 'fs';
import { globSync } from 'fast-glob';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');

it('G: wrangler secrets.required 與 manifest [secrets].worker 同步', () => {
  const manifestPath = resolve(REPO, '.portability.toml');
  const wranglerFiles = globSync(['wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'wrangler.*.toml', 'wrangler.*.jsonc'],
    { cwd: REPO, absolute: true });
  if (!existsSync(manifestPath) || wranglerFiles.length === 0) return;

  const toml = readFileSync(manifestPath, 'utf-8');
  const secretsSection = toml.split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? '';
  const workerBlock = secretsSection.match(/worker\s*=\s*\[([^\]]*)\]/);
  const manifestSecrets = workerBlock
    ? [...workerBlock[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map(m => m[1])
    : [];
  if (manifestSecrets.length === 0) return;

  // 收集 wrangler secrets.required 陣列內容(jsonc/json/toml 皆抓 "required" 後的 [...])
  const declared = new Set<string>();
  for (const w of wranglerFiles) {
    const c = readFileSync(w, 'utf-8');
    const block = c.match(/"required"\s*:\s*\[([^\]]*)\]|required\s*=\s*\[([^\]]*)\]/);
    if (!block) continue;
    for (const m of (block[1] ?? block[2]).matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) declared.add(m[1]);
  }

  // 首次部署例外:deployment.md 註記 → 允許 secrets.required 完全缺席
  const dep = resolve(REPO, 'deployment.md');
  const firstDeployOptOut = existsSync(dep)
    && /first-deploy|首次部署|#14258/.test(readFileSync(dep, 'utf-8'));

  if (declared.size === 0) {
    // 沒宣告 secrets.required:首次部署例外才允許;否則 Worker 應宣告(Layer 1)
    if (!firstDeployOptOut && wranglerFiles.some(w => /\.toml$|\.jsonc?$/.test(w))) {
      // 僅警告層級:Worker 鼓勵 Layer 1,但 Layer 2(§F)才是主力,此處不硬擋
    }
    return;
  }

  const missing = manifestSecrets.filter(k => !declared.has(k));
  expect(missing,
    `manifest [secrets].worker 有但 wrangler secrets.required 沒列(見 10 §5.1):\n${missing.join('\n')}`,
  ).toHaveLength(0);
});
```

> 取捨:`declared.size === 0` 時不硬 fail(Layer 1 有首次部署門檻,Layer 2 §F 才是主力)。但隻要宣告了 `secrets.required`,就 **[MUST]** 與 manifest 完全一致——半套的 `required` 比沒有更危險(給假安全感)。

---

## §H — reverse-coverage(程式碼用的 secret 必須在 manifest 內,捕 under-listing)

> 對應 `10-SECRETS-CONTRACT.md` §2(secret 合約是 SSoT,code 不得用未宣告的 secret)。
> §F 只驗單向(manifest 列的 → 有被防護);**§H 補反向**:程式碼實際讀取的 secret,**[MUST]** 出現在 manifest `[secrets].worker`(或顯式 non-secret allowlist)。否則 under-listing 隱形(如 hotel-cms-dev:code 用 15 個、manifest 只列 5 → §F 仍 pass,§H 才會抓)。
> 策略:掃程式碼 `env.KEY` / `process.env.KEY`(或 runtime gateway 的 throwing getter),扣掉 allowlist(非機密 vars),剩下的 **[MUST]** ⊆ manifest。

```typescript
import { readFileSync, existsSync } from 'fs';
import { globSync } from 'fast-glob';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');

it('H: 程式碼使用的 secret 都在 manifest [secrets].worker 或非機密 allowlist', () => {
  const manifest = resolve(REPO, '.portability.toml');
  if (!existsSync(manifest)) return;
  const toml = readFileSync(manifest, 'utf-8');
  const secretsSection = toml.split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? '';
  const workerBlock = secretsSection.match(/worker\s*=\s*\[([^\]]*)\]/);
  const declared = new Set(
    workerBlock ? [...workerBlock[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]) : [],
  );
  if (declared.size === 0) return;

  // 非機密 env(BASE_URLs / mode flag / test flag)— 不是 secret,不進 [secrets].worker。
  // 各 repo 按實況擴充;[NEVER] 把真機密塞進來躲避宣告。
  const NON_SECRET_ALLOW = new Set<string>([
    'NODE_ENV', 'MODE', 'PROD', 'DEV',
    // *_BASE_URL / *_ENDPOINT 通常是非機密 vars(走 [vars],authority C)
  ]);

  // 掃原始碼所有 env.KEY / process.env.KEY(排除測試 fixture / 生成檔 / 宣告檔)
  const files = globSync(['src/**/*.ts', 'workers/**/*.ts', '**/*.py'], {
    cwd: REPO, absolute: true,
    ignore: ['**/tests/**', '**/*.test.ts', '**/*.d.ts', '**/worker-configuration.d.ts', '**/env-secrets.d.ts'],
  });
  const used = new Set<string>();
  for (const f of files) {
    const c = readFileSync(f, 'utf-8');
    for (const m of c.matchAll(/(?:env|process\.env)\.([A-Z][A-Z0-9_]{2,})/g)) used.add(m[1]);
  }

  // 機密判斷:used 中「名字含 SECRET/TOKEN/KEY/API_KEY/M2M」且不在 allowlist → 必須宣告
  const SECRETISH = /(?:SECRET|TOKEN|API_KEY|M2M_ID|M2M_SECRET|APP_ID|APP_SECRET)/;
  const undeclared = [...used]
    .filter((k) => !NON_SECRET_ALLOW.has(k) && SECRETISH.test(k))
    .filter((k) => !declared.has(k));

  expect(undeclared,
    `程式碼用機密 secret 但 manifest [secrets].worker 沒列(見 10 §2,catch under-listing):\n${undeclared.join('\n')}`,
  ).toHaveLength(0);
});
```

> 各 repo 特化:
>
> - **有 runtime gateway 的 repo**(如 hotel-cms `src/lib/runtime.ts`):「required secret」更精確的訊號是 gateway 裡 **throwing getter**(`if (!v) throw`)。可把掃描源從 `env.KEY across src` 收窄成 `runtime gateway 的 throwing getter`,降低雜訊。此時 §H ≡「gateway 會 throw 的 key 必須在 manifest」。
> - `SECRETISH` 啟發式是寧可誤抓(false-positive 進 allowlist 即可);**[NEVER]** 把真機密加進 `NON_SECRET_ALLOW` 躲避宣告。
> - `env-secrets.d.ts`(若存在)是型別宣告的鏡像,鎖法見下方 **§I**(正式 guard,非僅本地檢查)。

---

## §I — env-types ↔ runtime gateway 型別層鎖(gateway repo 專用,治生成檔遮蔽)

> 對應 `10-SECRETS-CONTRACT.md` §5.2(b) runtime gateway pattern。實證於 hotel-cms-dev(治 getkm `08bb61bce49e`)。
> 病根:有 runtime gateway 的 repo 用 `wrangler types` 生成 `worker-configuration.d.ts`,它 augment `Cloudflare.Env` **任何 key** → **遮蔽**手維護 env 型別檔(如 `env-secrets.d.ts`)的過期。tsc 全綠但手維護檔已漂。
> §I 補這層(env-types ↔ gateway 實作),兩向鎖。dual-mode secret(同時有 `getX`/`tryGetX`)型別標 `?` 合理 → 不用 naive equals,改兩向:
>
> - **(a)** runtime 引用的 SECRETISH `env.KEY` **[MUST]** 在型別檔有宣告(捕:getter 加了型別沒補)。
> - **(b)** 型別檔每個 required(無 `?`)key **[MUST]** 有 throwing getter(捕:型別 required 但無 fail-fast)。

```typescript
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');

it('I: env-types ↔ runtime gateway throwing getter 兩向鎖(gateway repo)', () => {
  const typesFile = resolve(REPO, 'src/env-secrets.d.ts'); // 各 repo 路徑可能不同
  const gatewayFile = resolve(REPO, 'src/lib/runtime.ts');
  if (!existsSync(typesFile) || !existsSync(gatewayFile)) return; // 無 gateway repo 不適用

  const types = readFileSync(typesFile, 'utf-8');
  const gateway = readFileSync(gatewayFile, 'utf-8');
  const cfBlock = types.match(/interface Env \{([\s\S]*?)\}/)?.[1] ?? '';
  const declared = new Set([...cfBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+)\??: string;/gm)].map(m => m[1]));
  const required = new Set([...cfBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+): string;/gm)].map(m => m[1]));
  const throwingGetters = new Set([...gateway.matchAll(/throw new Error\('([A-Z][A-Z0-9_]{2,}) not configured'\)/g)].map(m => m[1]));
  const referenced = new Set([...gateway.matchAll(/env\.([A-Z][A-Z0-9_]{2,})/g)].map(m => m[1]));
  const SECRETISH = /(?:SECRET|TOKEN|API_KEY|M2M_ID|M2M_SECRET|APP_ID|APP_SECRET|ORG_ID|WEBHOOK_SECRET)/;
  const BINDING_ALLOW = new Set(['DB', 'SESSIONS', 'KV', 'R2', 'CACHE', 'QUEUES']);

  // (a) runtime 引用的 SECRETISH env.KEY 必須在型別檔有宣告
  const undeclared = [...referenced].filter(k => SECRETISH.test(k) && !BINDING_ALLOW.has(k) && !declared.has(k));
  expect(undeclared, `runtime 讀機密 env.KEY 但型別檔沒宣告(§I / getkm 08bb61bce49e):\n${undeclared.join('\n')}`).toHaveLength(0);
  // (b) 型別 required(無 ?)必須有 throwing getter
  const noGetter = [...required].filter(k => !throwingGetters.has(k));
  expect(noGetter, `型別檔標 required 但 runtime 無 throwing getter(§I):\n${noGetter.join('\n')}`).toHaveLength(0);
});
```

> 各 repo 特化:`typesFile` / `gatewayFile` 路徑按實況;`BINDING_ALLOW` 加該 repo binding 名。
> **兩種 Layer 2 實作 §I 都適用(不只 gateway repo)**——只要 repo 有「手寫 env 型別檔 + 生成檔遮蔽」就該鎖:
>
> - **(A) gateway repo**(runtime.ts throwing getters):鎖 env-types ↔ gateway throwing getters(見上方模板)。
> - **(B) assertBindings repo**(src/bindings.ts `REQUIRED_BINDING_KEYS`,如 topreview-hotel、pm):鎖 env-types ↔ `REQUIRED_BINDING_KEYS`。實證 topreview-hotel-dev:抓到 `GEMINI_API_KEY_2` env.ts 標 required 但語意 optional 的真 drift。

### 變體 B — assertBindings repo(env-types ↔ REQUIRED_BINDING_KEYS)

```typescript
it('I: env.ts ↔ REQUIRED_BINDING_KEYS 型別層鎖(assertBindings repo)', () => {
  const envSrc = readFileSync(resolve(REPO, 'src/env.ts'), 'utf-8');
  // close 用 \n\}(行首 }):避免註解內 {r} 等 non-greedy 誤截。
  const envBlock = envSrc.match(/export interface Env \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const envEntries = [...envBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+)(\?)?:\s*([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map(m => ({ key: m[1], opt: !!m[2], type: m[3] }));
  const envDeclared = new Set(envEntries.map(e => e.key));
  expect(envDeclared.size, '§I:env.ts 解析 0 個宣告,regex 可能失效').toBeGreaterThan(0);

  const bindingsSrc = readFileSync(resolve(REPO, 'src/bindings.ts'), 'utf-8');
  const rbBlock = bindingsSrc.match(/REQUIRED_BINDING_KEYS = \[([\s\S]*?)\]/)?.[1] ?? '';
  const requiredBindings = new Set([...rbBlock.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map(m => m[1]));
  expect(requiredBindings.size, '§I:REQUIRED_BINDING_KEYS 解析 0 個').toBeGreaterThan(0);

  const SECRETISH = /(?:SECRET|TOKEN|API_KEY|APP_ID|APP_SECRET|M2M_ID|M2M_SECRET)/;
  // (a) REQUIRED_BINDING_KEYS 每個都要在 env.ts 宣告
  const notTyped = [...requiredBindings].filter(k => !envDeclared.has(k));
  expect(notTyped, `REQUIRED_BINDING_KEYS 有但 env.ts 沒宣告型別(§I):\n${notTyped.join('\n')}`).toHaveLength(0);
  // (b) env.ts SECRETISH + string + required(無 ?)key 必須在 REQUIRED_BINDING_KEYS(被 fail-fast 保護)
  //     只認 string 型別(number/boolean config 如 *_MAX_PER_TOKEN 不算 secret,避 SECRETISH 子字串誤判)
  const SECRETISH_REQUIRED = new Set(
    envEntries.filter(e => !e.opt && e.type === 'string' && SECRETISH.test(e.key)).map(e => e.key));
  const noEnforce = [...SECRETISH_REQUIRED].filter(k => !requiredBindings.has(k));
  expect(noEnforce, `env.ts 標 required secret 但不在 REQUIRED_BINDING_KEYS(§I):\n${noEnforce.join('\n')}`).toHaveLength(0);
});
```

> dual-mode secret(env.ts 標 `?` 但 bindings required,如 LOGTO_ENDPOINT 只 scheduled 路徑強制)合理 → §I 不強制 required/optional 語意一致,(b) 只要求「env.ts required secret 必被 enforce」。語意不一致用註釋文件化,不硬改。

---

## §J — naming-convention(新 secret 命名結構,既有 allowlist)

> 對應 `10-SECRETS-CONTRACT.md` §3。新 secret [MUST] 結構化命名(`{VENDOR}_{ROLE}_{TYPE}`);既有 drift 進 `legacy_names` allowlist 不擋(漸進遷移)。
> 機器可驗:每個非 legacy 的 manifest secret 名 [MUST] (a)全大寫snake_case、(b)以合法 TYPE 結尾、(c)非裸 `_KEY` / `_2`/`2`(備援用 `_BACKUP`)。

```typescript
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');

it('J: 新 secret 命名遵循 {VENDOR}_{ROLE}_{TYPE}(既有進 legacy_names allowlist)', () => {
  const manifestPath = resolve(REPO, '.portability.toml');
  if (!existsSync(manifestPath)) return;
  const toml = readFileSync(manifestPath, 'utf-8');
  const secretsSection = toml.split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? '';
  const workerBlock = secretsSection.match(/worker\s*=\s*\[([^\]]*)\]/s);
  const names = workerBlock ? [...workerBlock[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]) : [];
  if (names.length === 0) return;

  // 既有 drift allowlist(manifest 內 legacy_names = [...],或本 guard 內顯式)。
  const legacyMatch = secretsSection.match(/legacy_names\s*=\s*\[([^\]]*)\]/s);
  const legacy = new Set(legacyMatch ? [...legacyMatch[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]) : []);

  const VALID_TYPE = /_(API_KEY|TOKEN|SECRET|ID|URL|DSN|ENDPOINT)$/;
  const BARE_KEY = /_(KEY)$/;          // 必須是 _API_KEY 不是 _KEY
  const NUMERIC_VARIANT = /_?\d$/;     // 備援用 _BACKUP,禁 _2 / GEMINI2 / API4_KEY
  const ENV_SUFFIX = /_(PROD|TEST|DEV|STAGING|PREVIEW)$/;  // 合法 ENV 後綴(同 runtime 多環境,10 §3.2)
  const violations: string[] = [];
  for (const k of names) {
    if (legacy.has(k)) continue;                          // 既有 allowlist 跳過
    // 先剝 ENV 後綴(_PROD/_TEST/...),再檢 TYPE(CMS_PULL_TOKEN_PROD → CMS_PULL_TOKEN → _TOKEN ✓)
    const base = k.replace(ENV_SUFFIX, "");
    if (!/^[A-Z][A-Z0-9_]+$/.test(k)) violations.push(`${k}: 非全大寫 snake_case`);
    else if (!VALID_TYPE.test(base)) violations.push(`${k}: 結尾非合法 TYPE(_API_KEY/_TOKEN/_SECRET/_ID/_URL/_DSN/_ENDPOINT)`);
    else if (BARE_KEY.test(base) && !/_API_KEY$/.test(base)) violations.push(`${k}: 裸 _KEY,改 _API_KEY`);
    else if (NUMERIC_VARIANT.test(base) && !/_V\d+$/.test(base)) violations.push(`${k}: 數字結尾,備援用 _BACKUP(禁 _2/API4)`);
  }
  expect(violations, `新 secret 命名違反 10 §3 結構(既有可加進 [secrets].legacy_names):\n${violations.join('\n')}`).toHaveLength(0);
});
```

> 各 repo:`legacy_names` 放既有 drift(如 `TG_BOT_TOKEN`(應 TELEGRAM_BOT_TOKEN)、`GEMINI_API_KEY_2`(應 _BACKUP)、`PROVISION_TOKEN`(應 TOPREVIEW_PROVISION_TOKEN));動到該 secret 時順手改名 + 從 allowlist 移除。

---

## §K — framework-baseline presence（merge-sync BASE 參考點存在，防靜默退化）

> 對應 `09-PROJECT-PORTABILITY.md` copy+merge-sync 分發模型。consumer 若本地有 `01–07` + `THINKING.md` + `ENFORCEMENT_REGISTRY.md` 任一框架拷貝，[MUST] 有 `.framework-baseline/` 且含對應 baseline 檔。缺 baseline 時 `sync-framework.sh` 把所有 diverged 檔退化成 case-5 `MANUAL`（無 BASE 無法 3-way merge）——且**靜默**（只標 MANUAL 不報錯），consumer 可能長期處於「永遠 MANUAL」而不自知，merge-sync 形同失效（實證 getkm `0c81f7f3b5e4`）。
> 機器可驗：consumer 若本地有任一框架檔，[MUST] 存在 `.framework-baseline/` 目錄；且對每個本地有的框架檔 [MUST] 有同名 baseline。首次採用或 baseline 缺失 → 跑 `./sync-framework.sh <repo> --apply` 建立（= 當前 rules HEAD 快照）。

```typescript
import { existsSync } from 'fs';
import { resolve, join } from 'path';

const REPO = resolve(__dirname, '..', '..');
const BASELINE = resolve(REPO, '.framework-baseline');
const FW = ['01-CLAUDE.md','02-BUILD-SPEC.md','03-DOC-AND-CODE-REVIEW.md','04-HARDENING_PROTOCOL.md','05-FIX-SPEC.md','06-REFLECT.md','07-ALL-IN-ONE.md','THINKING.md','ENFORCEMENT_REGISTRY.md'];

it('K: framework 拷貝伴隨 .framework-baseline（防 merge-sync 靜默退化 MANUAL）', () => {
  const present = FW.filter(f => existsSync(join(REPO, f)));
  if (present.length === 0) return;            // 無框架拷貝 → §K 不適用
  const violations: string[] = [];
  if (!existsSync(BASELINE)) {
    violations.push(`本地有 ${present.length} 個框架檔但無 .framework-baseline/ —— sync-framework 會把 diverged 檔全標 MANUAL（靜默退化）。跑 ./sync-framework.sh . --apply 建立`);
  } else {
    for (const f of present) {
      if (!existsSync(join(BASELINE, f))) violations.push(`${f}: 本地有但 .framework-baseline/${f} 缺 → 該檔 diverged 時退化 MANUAL`);
    }
  }
  expect(violations, `§K baseline 衛生:\n${violations.join('\n')}`).toHaveLength(0);
});
```

> baseline = 上次 sync 時的 rules HEAD 快照;`sync-framework.sh --apply` 在 MISSING→ADD / OVERWRITE / MERGED 時自動推進。失蹤常因 fresh clone 沒帶——09 §1.2 [MUST] 教 consumer 把 `.framework-baseline/` 入 git(merge-sync 的 BASE 參考點)。
>
> **na 例外:** consumer 若政策性 gitignore baseline(如 monorepo 體積/視為產生物),[MUST] 在 `.portability.toml [bootstrap]` 記錄替代還原(如 `sync-framework.sh --apply` 重建),guard §K 讀該宣告放行;否則 [MUST] 入 git(見 09 §1.2)。

---

## §L — manifest-gitignore-coherence([machine_local] 備份清單 ↔ .gitignore 一致)

> §1.1 + §1.2 [NEVER]:seal.sh 有 manifest 時按 `[machine_local].files` 打包(override);無 manifest 時退 **universal 預設 glob**(`.env*`/`.dev.vars`/`wrangler.*`,09 §1.1)。§L 確保:有 manifest 時,該清單列的檔 [MUST] 是 gitignored 且 disk 上 gitignored 的 secret/per-checkout 檔 [MUST] 進清單(防「gitignore 了卻沒備」)。名稱級(code 讀 ↔ env 檔)由 §M 把關。
> 解的失敗模式:新增 gitignored per-checkout 檔(如 `wrangler.toml` 含 D1/KV ID)卻沒加進 manifest → seal.sh 不備份 → 換機遺失(false coverage,比沒規範更危險,getkm `2c1fe0725d63`)。反向:manifest 列了其實在 git 裡的檔 → 備份冗餘或 secret 已洩。
> **雙向 coherence,class-level matcher**(非字面檔名,getkm `aa66b862e4f0`):

| 方向 | 規則 | fail |
|---|---|---|
| 正向(manifest ⊆ gitignore) | `[machine_local].files` 每個 pattern 都被 .gitignore 涵蓋 | **fail** |
| 反向(gitignored secret-ish ⊆ manifest) | disk 上 gitignored 的 secret-ish 檔都被某 manifest pattern 涵蓋 | **fail** |

secret-ish 檔類:`.env` / `.env.*` / `.dev.vars` / `wrangler*.toml` / `wrangler*.jsonc`(排除 `*.example` committed placeholder)。
觸發:pre-commit(改 .gitignore / .portability.toml 瞬間)+ CI/pre-push(防 `--no-verify` 繞過)。stack-agnostic python3 腳本(tomllib parse TOML,非 fragile bash matcher),非 vitest 專屬——跨 cloudflare/node/python 通用一份。

```python
#!/usr/bin/env python3
"""check-manifest-gitignore.py — §L: [machine_local].files ↔ .gitignore coherence。

正向 FAIL: [machine_local].files 每個 pattern 必須 gitignored(列了 tracked 檔 = 備份冗餘/secret 洩)。
反向 FAIL: disk 上 gitignored 的 secret-ish 檔必須被某 manifest pattern 涵蓋(漏 = 換機遺失)。

用法: check-manifest-gitignore.py [<repo-dir>]      # 預設 cwd,檢查該 repo
      check-manifest-gitignore.py --selftest         # 內建 fixture 自測(跨棧 portable)
exit: 0 一致 / 1 違規(印明細) / 2 設定錯誤(無 .portability.toml 等)。
"""
from __future__ import annotations
import fnmatch, glob, os, subprocess, sys, tempfile, tomllib

SECRETISH_GLOBS = (".env", ".env.*", ".dev.vars", "wrangler*.toml", "wrangler*.jsonc")


def _is_transient(rel: str) -> bool:
    """暫存/衍生檔,非 source-of-truth → 不該進備份清單,反向檢查略過。

    - *.example:committed placeholder(無值範本)。
    - *.bak.* / *.bak[-_...]:seal 還原(restore.sh)前自動產生的暫存備份
      (<name>.bak.<ts>),以及 *.bak-pre-* / *.bak_* 等歷史命名變體
      (getkm aa66b862e4f0 原始案例 .env.bak-pre-onnx);source(.env 本身)已在 manifest,
      .bak 是冗餘衍生品,遺失無害 → 備份它反而是冗餘。
    """
    lower = rel.lower()
    return (lower.endswith(".example")
            or ".bak." in lower or ".bak-" in lower or ".bak_" in lower
            or lower.endswith(".bak"))


def _patterns_from_manifest(repo: str) -> list[str]:
    pf = os.path.join(repo, ".portability.toml")
    if not os.path.isfile(pf):
        return []  # 無 manifest → caller 決定(檢查模式 exit 2;selftest fixture 控制)
    with open(pf, "rb") as f:
        data = tomllib.load(f)
    pats = (data.get("machine_local") or {}).get("files") or []
    return [p for p in pats if isinstance(p, str) and p]


def _ignored(repo: str, path: str) -> bool:
    """git check-ignore path(在 repo 內);exit 0 = ignored。"""
    r = subprocess.run(["git", "-C", repo, "check-ignore", "--quiet", path],
                       capture_output=True)
    return r.returncode == 0


def _concrete(pattern: str) -> str:
    """glob pattern → 一個符合它的具體路徑,供 git check-ignore 測試。"""
    return pattern.replace("*", "MATCH").replace("?", "X") or pattern


def check(repo: str) -> list[str]:
    """回傳違規明細(空 = 一致)。"""
    patterns = _patterns_from_manifest(repo)
    if not patterns:
        return ["[§L] 無 .portability.toml 或 [machine_local].files 為空(§C 應先擋存在性)"]
    violations: list[str] = []

    # 正向:每個 manifest pattern 必須 gitignored
    for p in patterns:
        if not _ignored(repo, _concrete(p)):
            violations.append(
                f"[§L 正向] manifest 列 '{p}' 但未被 .gitignore 涵蓋"
                f"(= tracked 檔 → 備份冗餘,或 secret 已洩進 git)。修:.gitignore 加 {p},或從 [machine_local].files 移除。")

    # 反向:disk 上 gitignored secret-ish 檔必須被某 manifest pattern 涵蓋
    candidates = set()
    for g in SECRETISH_GLOBS:
        for hit in glob.glob(os.path.join(repo, g)):
            rel = os.path.relpath(hit, repo)
            if not _is_transient(rel):
                candidates.add(rel)
    for c in sorted(candidates):
        if _ignored(repo, c) and not any(fnmatch.fnmatch(c, p) for p in patterns):
            violations.append(
                f"[§L 反向] '{c}' 被 .gitignore 但不在 [machine_local].files"
                f"(= 漏備份 → 換機遺失)。修:[machine_local].files 加 {c}。")

    return violations


def selftest() -> int:
    cases = [
        # (name, gitignore_lines, manifest_files, disk_files, expect_exit)
        ("reverse-fail", ["wrangler.toml"], [".env"], [".env", "wrangler.toml"], 1),
        ("forward-fail", [], ["config.json"], ["config.json"], 1),
        ("clean-pass", [".env", ".dev.vars", "wrangler.toml"],
         [".env", ".dev.vars", "wrangler.toml"], [".env", ".dev.vars", "wrangler.toml"], 0),
        ("example-no-falsepositive", [".env", ".env.*", "!.env.example"],
         [".env", ".env.*"], [".env", ".env.example"], 0),
        ("bak-no-falsepositive", [".env", ".env.bak.*"],
         [".env"], [".env", ".env.bak.20260731125816"], 0),
        ("bak-dash-no-falsepositive", [".env", ".env.bak*"],
         [".env"], [".env", ".env.bak-pre-onnx"], 0),
    ]
    fails = 0
    for name, gi, mf, disk, expect in cases:
        d = tempfile.mkdtemp(prefix=f"§L-{name}-")
        subprocess.run(["git", "-C", d, "init", "--quiet"], check=True)
        with open(os.path.join(d, ".gitignore"), "w") as f:
            f.write("\n".join(gi) + "\n")
        with open(os.path.join(d, ".portability.toml"), "w") as f:
            f.write("[machine_local]\nfiles = [" + ", ".join(f'"{x}"' for x in mf) + "]\n")
        for df in disk:
            open(os.path.join(d, df), "w").close()
        v = check(d)
        got = 1 if v else 0
        # forward-fail/clean-pass 的 disk 檔需 tracked 才能 git check-ignore 判定非 ignored;
        # git init 後未 commit → check-ignore 仍依 .gitignore 判定,OK。
        status = "✓" if got == expect else "✗"
        if got != expect:
            fails += 1
            print(f"{status} {name}: expect exit {expect}, got {got}; violations={v}")
        else:
            print(f"{status} {name}: exit {got}")
    print(f"selftest: {len(cases) - fails}/{len(cases)} passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    repo = os.path.abspath(argv[1]) if len(argv) == 2 else os.getcwd()
    if not os.path.isfile(os.path.join(repo, ".portability.toml")):
        print(f"[§L] {repo} 無 .portability.toml(§C 應先擋)", file=sys.stderr)
        return 2
    v = check(repo)
    if v:
        print("\n".join(v), file=sys.stderr)
        return 1
    print(f"[§L] {os.path.basename(repo)} manifest↔gitignore 一致 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

---

## §M — secrets-coverage-parity(code SECRETISH ↔ env 檔雙向)

> §L 管「檔案層」(`[machine_local]`↔`.gitignore`);**§M 管「名稱層」(code 讀的 secret ↔ env 檔的變數)**。
> 解的失敗模式:code 新增讀一個 SECRETISH 名(如 `getNewKey()`),但 `.env`/`.dev.vars`/`wrangler.*` 沒放 → 本機/runtime fail-fast,或(配合 §L universal backup)該 secret 根本沒被 seal 進 env.7z。反向:`.env` 留了 code 不再讀的陳年 secret(漂、輪替盲點)。
> **雙向 parity(class-level SECRETISH matcher,非「全大寫」——避 `MAX_TOKENS`/`NODE_ENV` FP)**:

| 方向 | 規則 | fail |
|---|---|---|
| 正向(code ⊆ env) | runtime code 引用的每個 SECRETISH 名,出現在 `.env`/`.dev.vars`/`wrangler.*` 或 optional-allowlist | **fail** |
| 反向(env ⊆ code ∪ allowlist) | `.env`/`.dev.vars`/`wrangler.*` 內每個 SECRETISH var,被 code 引用或在 allowlist | **warn**(可升 fail) |

SECRETISH = `[A-Z][A-Z0-9_]{2,}_(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|...](同 §H/§J)。
**Optional secret**(`LOGTO_WEBHOOK_SECRET` 等可缺席):顯式 allowlist 檔(如 `.secrets-optional`,每行一名)或 code 註解 `# §M-optional: NAME`。
排除:`tests/`、`build`/`dist`、`node_modules`/`.venv`、generated、`.example`/`.bak*`。
觸發:pre-commit(改 code 或 .env 瞬間)。stack-agnostic python3 腳本(同 §L)。先例:getkm `208665f09b02`(bidirectional env-parity)、§H(reverse-coverage)。
與 §L 互補:§L 保證「備到的檔就是 gitignored 的標準 secret 檔」;§M 保證「code 用的 secret 名都在那些檔裡」。兩層合 = secrets-archive 備份完整性。

```python
#!/usr/bin/env python3
"""check-secrets-coverage.py — §M: code「讀」的 SECRETISH ↔ env 檔變數 雙向 parity。

精準版:只匹配「secret 讀取模式」(env.X / process.env.X / os.getenv(X) / os.environ[X]),
不匹配註解/型別/字串裡的裸名稱(避 FP)。runtime 範圍(src/workers/functions/lib/api),
排除 scripts/(setup/seed/demo/bootstrap,非 request-path)+ tests/build/deps。

正向 FAIL: runtime code「讀」的 SECRETISH 名必須在 .env/.dev.vars/wrangler.* 或 allowlist。
反向 WARN: env 檔的 SECRETISH var 應被 code 讀(或在 allowlist),否則陳年漂。

用法: check-secrets-coverage.py [<repo-dir>] | --selftest
exit: 0 一致 / 1 正向違規(缺 secret) / 2 設定錯誤
"""
from __future__ import annotations
import glob, os, re, sys, tempfile

# secret「讀取」模式:process.env.X / env.X(CF c.env.X 含 .env.X)/ os.environ['X'] / os.getenv('X')
READ_PATTERN = re.compile(
    r"(?:process\.env|os\.environ|os\.getenv|os\.Getenv|getenv|\.env|env)"
    r"\s*(?:\.\s*|\[\s*['\"]?|\(\s*['\"]?)"
    r"([A-Z][A-Z0-9_]{2,})"
)
# 何謂 secret-ish 名(同 §H/§J):過濾 READ_PATTERN 抓到的名,只留真的像 secret 的。
SECRETISH_SUFFIX = re.compile(
    r"_(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|M2M_ID|M2M_SECRET|APP_ID|APP_SECRET|ORG_ID)$"
)
ENV_FILES = (".env", ".dev.vars", ".env.local", ".env.*", "wrangler*.toml", "wrangler*.jsonc")
EXCLUDE_DIRS = ("node_modules", ".venv", ".git", "dist", "build", ".wrangler", ".cloudflare",
                "tests", "test", "__tests__", "scripts")  # scripts=setup/seed/demo/bootstrap(非 runtime)
EXCLUDE_SUFFIX = (".example", ".bak", ".test", ".fixture", ".sample", ".md", ".d.ts")
CODE_GLOBS = ("src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "workers/**/*.ts", "**/*.py",
              "functions/**/*.ts", "lib/**/*.ts", "lib/**/*.py", "api/**/*.ts")


def _is_excluded(path: str) -> bool:
    lower = "/" + path.lower() + "/"
    if any(f"/{seg}/" in lower for seg in EXCLUDE_DIRS):
        return True
    return lower.endswith(EXCLUDE_SUFFIX)


def _code_secret_reads(repo: str) -> set[str]:
    """runtime code 實際「讀」的 SECRETISH 名(只匹配讀取模式,不匹配註解/字串裸名)。"""
    names: set[str] = set()
    for g in CODE_GLOBS:
        for hit in glob.glob(os.path.join(repo, g), recursive=True):
            if not os.path.isfile(hit) or _is_excluded(hit):
                continue
            try:
                content = open(hit, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for m in READ_PATTERN.findall(content):
                if SECRETISH_SUFFIX.search(m):
                    names.add(m)
    return names


def _env_var_names(repo: str) -> set[str]:
    vars_: set[str] = set()
    for pat in ENV_FILES:
        for hit in glob.glob(os.path.join(repo, pat)):
            if not os.path.isfile(hit) or _is_excluded(os.path.basename(hit)):
                continue
            try:
                for line in open(hit, encoding="utf-8"):
                    s = line.strip()
                    if not s or s.startswith("#") or "=" not in s:
                        continue
                    raw = s.split("=", 1)[0].strip()
                    key = raw.replace("export ", "").split()[0] if raw else ""
                    if key and key.replace("_", "").isupper():
                        vars_.add(key)
            except (OSError, UnicodeDecodeError):
                continue
    return vars_


def _optional(repo: str) -> set[str]:
    names: set[str] = set()
    opt = os.path.join(repo, ".secrets-optional")
    if os.path.isfile(opt):
        for line in open(opt, encoding="utf-8"):
            s = line.strip()
            if s and not s.startswith("#"):
                names.add(s)
    for g in CODE_GLOBS:
        for hit in glob.glob(os.path.join(repo, g), recursive=True):
            if not os.path.isfile(hit) or _is_excluded(hit):
                continue
            try:
                names.update(re.findall(r"§M-optional:\s*([A-Z][A-Z0-9_]{2,})", open(hit, encoding="utf-8").read()))
            except (OSError, UnicodeDecodeError):
                continue
    return names


def check(repo: str) -> tuple[list[str], list[str]]:
    code_reads = _code_secret_reads(repo)
    env_vars = {v for v in _env_var_names(repo) if SECRETISH_SUFFIX.search(v)}
    opt = _optional(repo)
    forward = sorted(n for n in code_reads if n not in env_vars and n not in opt)
    reverse = sorted(v for v in env_vars if v not in code_reads and v not in opt)
    return forward, reverse


def selftest() -> int:
    cases = [
        ("clean", {"src/a.ts": "const k = env.FOO_API_KEY;"}, {".env": "FOO_API_KEY=xxx"}, [], []),
        ("forward-fail", {"src/a.ts": "process.env.BAR_TOKEN"}, {".env": "OTHER=1"}, [], ["BAR_TOKEN"]),
        ("optional-ok", {"src/a.ts": "process.env.OPT_SECRET"}, {".env": ""}, ["OPT_SECRET"], []),
        ("comment-not-flagged", {"src/a.ts": "// uses PROVISION_TOKEN here\nno read"}, {".env": ""}, [], []),
        ("max-tokens-not-secretish", {"src/a.ts": "env.MAX_TOKENS"}, {".env": ""}, [], []),
        ("python-getenv", {"app/x.py": "v = os.getenv('DB_PASSWORD')"}, {".env": "DB_PASSWORD=p"}, [], []),
        ("scripts-excluded", {"scripts/seed.ts": "env.SEED_API_KEY"}, {".env": ""}, [], []),
    ]
    fails = 0
    for name, code, env, opt, exp_fwd in cases:
        d = tempfile.mkdtemp(prefix=f"§M-{name}-")
        for p, c in code.items():
            os.makedirs(os.path.join(d, os.path.dirname(p)) or d, exist_ok=True)
            open(os.path.join(d, p), "w").write(c)
        for p, c in env.items():
            open(os.path.join(d, p), "w").write(c)
        if opt:
            open(os.path.join(d, ".secrets-optional"), "w").write("\n".join(opt) + "\n")
        fwd, rev = check(d)
        ok_ = fwd == exp_fwd
        print(f"{'✓' if ok_ else '✗'} {name}: forward={fwd} reverse={rev}")
        if not ok_:
            fails += 1
    print(f"selftest: {len(cases) - fails}/{len(cases)} passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    repo = os.path.abspath(argv[1]) if len(argv) == 2 else os.getcwd()
    fwd, rev = check(repo)
    if fwd:
        print("[§M 正向] runtime code 讀但 env 檔/allowlist 缺的 SECRETISH:\n  " + "\n  ".join(fwd), file=sys.stderr)
        return 1
    if rev:
        print(f"[§M 反向 warn] env 檔有但 code 不讀(陳年 secret?輪替候選):\n  " + "\n  ".join(rev))
    else:
        print(f"[§M] {os.path.basename(repo)} code↔env SECRETISH parity 一致 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

```

---

## 串接說明

- **[MUST]** 本十二項（§A–§L）接進該 stack `04-HARDENING_PROTOCOL` 的 guard 套件（`workers/tests/guards.test.ts` 或 pytest），由 pre-commit + CI 跑。
  - §A–§E 續 09（可重建 + 反鎖死）；**§A / §F / §G / §H / §I 同時也是 10（secret 合約）的牙齒**（§F/§H manifest↔runtime 雙向、§I env-types↔runtime 型別層）。
  - §K 續 09（merge-sync 基礎設施：baseline 衛生，防 consumer 有框架拷貝但無 baseline → sync-framework 靜默退化 MANUAL）。
- 預算(raw SQL)**只減不增**:接進後首跑的計數即為基準,後續 **[ALWAYS]** ≤ 基準。
- guard 失敗訊息 **[MUST]** 指向 `09-PROJECT-PORTABILITY.md` / `10-SECRETS-CONTRACT.md` 對應章節,讓修的人知道為什麼擋。
- **[MUST]** 新增 § 條文(或既有消費者首次 port 某 §)時,**[MUST]** 同步更新 `references/guard-coverage-map.toml`--為每個服務加一列(`status` + `via`/`note`)。`scripts/validate-guard-coverage.sh`(由 `validate-framework-sync.sh` 在 sync 縫隙呼叫)以**本檔 canonical 版本的 §A–§L** 為真源檢查此 map;未更新 → advisory 印缺口。覆蓋率語意見 `docs/2026-07-31-guard-coverage-map-design.md`。
