// §A–§K portability guards — vendored from references/PORTABILITY-GUARDS.md（alliance-member 實例化先例）。
// 對應 ~/Code/rules/09-PROJECT-PORTABILITY.md §1/§2 + 10-SECRETS-CONTRACT.md §2/§3/§5（file-level reference）。
// 失敗訊息指向對應合約章節。§L/§M 為 python3 腳本（scripts/check-*.py，pre-commit/pre-push/smoke 跑）。
//
// watch-dog 本地適應：
// - §B：本 repo 無 ORM（01 §3 明示 D1 原生 prepared statements 為 sanctioned 模式）——防線改為
//   「.prepare() 的 SQL 必須靜態字面值；參數一律 .bind()」（禁內插 ${} / 字串串接）。
// - §H/§J：manifest 擴充 [secrets].optional_worker（10 §5.2 try* accessor 模式）——
//   宣告集 = worker ∪ optional_worker。
// - §I：變體 B（assertBindings repo）——src/types.ts（Env/AppBindings）↔ src/lib/bindings.ts 鎖。
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { globSync } from "fast-glob";

const REPO = resolve(__dirname, "..", "..");
const SECRETISH = /(?:SECRET|TOKEN|API_KEY|APP_ID|APP_SECRET|M2M_ID|M2M_SECRET)/;

function manifestToml(): string {
  return readFileSync(join(REPO, ".portability.toml"), "utf-8");
}

/** [secrets] 段內指定清單 key（"worker" 或 "optional_worker"）的名稱。
 *  \b 前界必備：optional_worker 內含子字串 "worker"，無 \b 會誤抓。 */
function manifestSecretKeys(listKey: "worker" | "optional_worker"): string[] {
  const secretsSection = manifestToml().split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? "";
  const block = secretsSection.match(new RegExp(`\\b${listKey}\\s*=\\s*\\[([^\\]]*)\\]`, "s"));
  return block ? [...block[1]!.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]!) : [];
}

/** §H/§J 用：完整宣告集 = worker ∪ optional_worker（10 §5.2 optional 擴充）。 */
function manifestDeclaredSecrets(): string[] {
  return [...manifestSecretKeys("worker"), ...manifestSecretKeys("optional_worker")];
}

// ---------- §A — secret-not-in-vars ----------
it("A: no secret key leaks into wrangler vars or source", () => {
  const keys = new Set(manifestDeclaredSecrets());
  if (keys.size === 0) return;
  const violations: string[] = [];

  // 1. wrangler 配置（toml [vars] / jsonc "vars"）不得含任一 secret key
  for (const w of globSync(["wrangler*.toml", "wrangler*.jsonc"], { cwd: REPO, absolute: true })) {
    const content = readFileSync(w, "utf-8");
    const varsSection =
      content.split(/\[vars\]/)[1]?.split(/^\[/m)[0] ??
      content.match(/"vars"\s*:\s*\{([\s\S]*?)\}/)?.[1] ??
      "";
    for (const k of keys) {
      if (new RegExp(`\\b${k}\\b`).test(varsSection)) {
        violations.push(`${w}: secret key ${k} 出現在 vars`);
      }
    }
  }

  // 2. 源碼不得出現明文指派 secret：帶引號鍵（"KEY" = 'v'）與無引號鍵（const KEY = 'v'）
  //    兩形態（TODO-REVIEW #11——原版只認帶引號鍵，註解比實際寬）。
  for (const f of globSync("src/**/*.ts", { cwd: REPO, absolute: true })) {
    const content = readFileSync(f, "utf-8");
    for (const k of keys) {
      const quoted = new RegExp(`['"]${k}['"]\\s*=\\s*['"][^'"]+['"]`);
      const bare = new RegExp(`\\b${k}\\s*=\\s*['"\`]\\S`); // const KEY = "..."（無引號鍵）
      if (quoted.test(content) || bare.test(content)) {
        violations.push(`${f}: 明文指派 secret ${k}`);
      }
    }
  }

  expect(violations, `secret 洩漏（見 10 §2）:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- §B — SQL 必須靜態字面值 + .bind() 參數化（watch-dog 適應版） ----------
/** §B 掃描核心：每個 `.prepare(` 的引數區（到第一個 `.bind(` 或 400 字元）：
 *  ① 主規則——引數首個非空白字元必須是 SQL 字面值引號（' " `）。
 *    非字面值開頭 = 變數/運算式 → 未參數化的動態 SQL（前導變數串接、join()、prebuilt var 全被涵蓋）。
 *  ② 反向樣式——區內出現 `${`（模板內插）或「引號貼鄰串接」（`'...' +` / `+ '...'`，雙向；
 *    引號鄰接排除 SQL 算術如 `failure_count + 1`）。誤報方向保守可接受。 */
function scanPrepareArg(content: string): Array<{ line: number; snippet: string; kind: string }> {
  const hits: Array<{ line: number; snippet: string; kind: string }> = [];
  let idx = 0;
  while ((idx = content.indexOf(".prepare(", idx)) !== -1) {
    const start = idx + ".prepare(".length;
    const bindAt = content.indexOf(".bind(", start);
    const region = content.slice(start, Math.min(bindAt === -1 ? start + 400 : bindAt, start + 400));
    // 主規則：跳過空白/換行後，首字元必須是引號（多行 .prepare(\n  `SELECT...` 合法）
    const firstChar = region.replace(/^[\s]+/, "")[0];
    const kind =
      firstChar !== undefined && !['\'', '"', '`'].includes(firstChar)
        ? "非字面值開頭"
        : region.includes("${")
          ? "模板內插 ${}"
          : /['"`]\s*\+/.test(region) || /\+\s*['"`]/.test(region)
            ? "字串串接 +"
            : null;
    if (kind) {
      const line = content.slice(0, idx).split("\n").length;
      hits.push({
        line,
        snippet: region.split("\n")[0]!.trim().slice(0, 80),
        kind,
      });
    }
    idx = start;
  }
  return hits;
}

it("B: .prepare() SQL 為靜態字面值，參數一律 .bind()（01 §3 D1 native 模式）", () => {
  const files = globSync("src/**/*.ts", { cwd: REPO, absolute: true });
  const violations: string[] = [];
  for (const f of files) {
    for (const h of scanPrepareArg(readFileSync(f, "utf-8"))) {
      violations.push(`${f}:${h.line} [${h.kind}] ${h.snippet}`);
    }
  }
  expect(violations, `SQL 內插/串接違規（改 .bind()，見 01 §3 + 04 raw-SQL 預算）:\n${violations.join("\n")}`).toHaveLength(0);
});

it("B 自驗（D38）：內插/串接/非字面值樣本都被攔；靜態字面值 + .bind() 不誤殺", () => {
  const bad = [
    { src: "db.prepare(`SELECT * FROM t WHERE id = ${id}`)", kind: "模板內插" },
    { src: "db.prepare('SELECT ' + cols + ' FROM t')", kind: "字串串接" },
    { src: "db.prepare(`INSERT INTO logs VALUES (${now})`)", kind: "模板內插" },
    // TODO-REVIEW #10 四逃逸向量（deslop 實測）——主規則「非字面值開頭」全攔
    { src: "const part = 'SELECT *'; db.prepare(part + ' FROM t')", kind: "前導變數串接" },
    { src: "db.prepare(['SELECT *','FROM t'].join(' '))", kind: "join() 拼裝" },
    { src: "const sql = 'SELECT * FROM t WHERE id=' + id; db.prepare(sql)", kind: "prebuilt var" },
    { src: "db.prepare(`SELECT * FROM t` + where)", kind: "背接串接" },
  ];
  for (const b of bad) {
    expect(scanPrepareArg(b.src), `應攔 (${b.kind}): ${b.src}`).toHaveLength(1);
  }
  // 限制（誠實記錄）：掃描是字面文本比對——註解/字串內含 `.prepare(` + 危險樣式同樣會被攔
  //（誤報方向，保守可接受）；「字面值開頭、區內純靜態」之外的重排混淆（如先 bind 後拼接）
  // 不在此層攔，由 code review + §B 保守面共同把關。
  const good = [
    "db.prepare('SELECT * FROM t WHERE id = ?').bind(id)",
    "db.prepare(`SELECT * FROM checks WHERE monitor = 1`).all()",
    "db.prepare(`INSERT INTO logs (check_id) VALUES (?)`).bind(checkId).run()",
    // 多行形式：.prepare( 換行後接字面值 —— 首個非空白字元是引號 → 合法
    "db.prepare(\n  `INSERT INTO logs (check_id, status)\n  VALUES (?, ?)`\n).bind(a, b)",
    // SQL 內含算術（failure_count + 1 / last_seen + c.interval）不觸發：無引號貼鄰
    "db.prepare(`UPDATE checks SET failure_count = failure_count + 1 WHERE id = ?`).bind(id)",
    "db.prepare(`SELECT * FROM checks WHERE (last_seen + interval + grace) < ?`).bind(now)",
  ];
  for (const g of good) {
    expect(scanPrepareArg(g), `不應誤殺: ${g}`).toHaveLength(0);
  }
});

// ---------- 預算 — as any = 0（只減不增；2026-09-04 從 20 清到 0） ----------
it("預算：src 無 `as any`（現值 0）", () => {
  const files = globSync("src/**/*.ts", { cwd: REPO, absolute: true });
  const violations: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/\bas\s+any\b/.test(line) || /<any>/.test(line)) {
          violations.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
        }
      });
  }
  expect(violations, `as-any 違規（型別收縮，改精確型別/generic）:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- §C — manifest 存在性 + 五段 ----------
it("C: .portability.toml exists with all 5 required sections", () => {
  const manifest = join(REPO, ".portability.toml");
  expect(existsSync(manifest), ".portability.toml 缺失（見 09 §1.1）").toBe(true);
  const content = readFileSync(manifest, "utf-8");
  const missing = ["[machine_local]", "[secrets]", "[bootstrap]", "[verify]", "[vendor_lock]"].filter(
    (s) => !content.includes(s),
  );
  expect(missing, `.portability.toml 缺段:\n${missing.join("\n")}`).toHaveLength(0);
});

// ---------- §D — manifest-consumed ----------
for (const section of ["bootstrap", "verify"]) {
  it(`D: [${section}].script 指向存在且可執行的腳本`, () => {
    const m = manifestToml().match(new RegExp(`\\[${section}\\][\\s\\S]*?script\\s*=\\s*["']([^"']+)["']`));
    expect(m, `.portability.toml [${section}] 缺 script 入口（見 09 §1.1 SSoT 分工）`).not.toBeNull();
    const target = resolve(REPO, m![1]!);
    expect(existsSync(target), `[${section}].script 指向不存在:${m![1]}`).toBe(true);
    expect((statSync(target).mode & 0o111) !== 0, `${m![1]} 不可執行（chmod +x）`).toBe(true);
  });
}

// ---------- §E — binding-coverage ----------
// 掃描範圍＝src/（程式碼）。框架文件/manifest/guard 測試對 binding 名的引用是文件引用非程式碼使用。
it("E: 程式碼實際出現的 vendor binding 都在 touchpoints 內", () => {
  const tpBlock = manifestToml().match(/\[vendor_lock\][\s\S]*?touchpoints\s*=\s*\[([^\]]*)\]/);
  const listed = tpBlock ? [...tpBlock[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
  const KNOWN_BINDINGS = [
    "c.env.DB", "env.DB", "c.env.KV", "env.KV", "c.env.R2", "env.R2",
    // TODO-REVIEW #14：單/雙引號兩形態（repo 無 quotes lint 鎖風格）
    "from 'cloudflare:workers'", 'from "cloudflare:workers"', "DurableObjectNamespace",
  ];
  const present: string[] = [];
  for (const b of KNOWN_BINDINGS) {
    const hit = (() => {
      try {
        execSync(
          `git -C "${REPO}" grep -lE -- ${JSON.stringify(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))} -- src`,
          { stdio: "pipe" },
        );
        return true;
      } catch {
        return false;
      }
    })();
    if (hit) present.push(b);
  }
  const unlisted = present.filter((b) => !listed.includes(b));
  expect(unlisted, `程式碼有 vendor binding 但 manifest touchpoints 沒列（見 09 §2.3）:\n${unlisted.join("\n")}`).toHaveLength(0);
});

// ---------- §F — startup-check-present ----------
it("F: assertBindings 引用 manifest [secrets].worker 的每個 name", () => {
  const workerKeys = manifestSecretKeys("worker");
  if (workerKeys.length === 0) return;
  const guardFiles = globSync(["src/**/bindings.ts", "src/**/env.ts", "src/index.ts"], {
    cwd: REPO,
    absolute: true,
  });
  if (guardFiles.length === 0) {
    throw new Error("§F: 找不到 app 層 env guard（預期 src/lib/bindings.ts，見 10 §5.2）");
  }
  const guardLiterals = new Set<string>();
  for (const f of guardFiles) {
    for (const m of readFileSync(f, "utf-8").matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) guardLiterals.add(m[1]!);
  }
  const unguarded = workerKeys.filter((k) => !guardLiterals.has(k));
  expect(unguarded, `manifest 有 secret 但 assertBindings 沒引用（見 10 §5.2 Layer 2）:\n${unguarded.join("\n")}`).toHaveLength(0);
});

// ---------- §G — secrets-required-synced ----------
it("G: wrangler secrets.required 與 manifest [secrets].worker 同步", () => {
  const manifestSecrets = manifestSecretKeys("worker");
  if (manifestSecrets.length === 0) return;
  const wranglerFiles = globSync(
    ["wrangler.jsonc", "wrangler.json", "wrangler.toml", "wrangler.*.toml", "wrangler.*.jsonc"],
    { cwd: REPO, absolute: true },
  );
  const declared = new Set<string>();
  for (const w of wranglerFiles) {
    const c = readFileSync(w, "utf-8");
    const block = c.match(/"required"\s*:\s*\[([^\]]*)\]|required\s*=\s*\[([^\]]*)\]/);
    if (!block) continue;
    for (const m of (block[1] ?? block[2] ?? "").matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) declared.add(m[1]!);
  }
  if (declared.size === 0) return; // Layer 1 缺席由首次部署流程處理（#14258），Layer 2（§F）是主力
  const missing = manifestSecrets.filter((k) => !declared.has(k));
  expect(missing, `manifest [secrets].worker 有但 wrangler secrets.required 沒列（見 10 §5.1）:\n${missing.join("\n")}`).toHaveLength(0);
  // 反向鎖（TODO-REVIEW #12）：wrangler 多列的名稱不在 manifest → 三方 ≡ 破局
  //（bindings.ts REQUIRED_BINDING_KEYS 不知情、§F 驗不到它）。
  const extra = [...declared].filter((k) => !manifestSecrets.includes(k));
  expect(extra, `wrangler secrets.required 有但 manifest [secrets].worker 沒列（三方 ≡，見 10 §5.1）:\n${extra.join("\n")}`).toHaveLength(0);
});

// ---------- §H — reverse-coverage（worker ∪ optional_worker 擴充） ----------
it("H: 程式碼使用的 secret 都在 manifest [secrets] worker/optional_worker 或非機密 allowlist", () => {
  const declared = new Set(manifestDeclaredSecrets());
  if (declared.size === 0) return;
  const NON_SECRET_ALLOW = new Set(["NODE_ENV", "MODE", "PROD", "DEV"]);
  const files = globSync("src/**/*.ts", {
    cwd: REPO,
    absolute: true,
    ignore: ["**/*.test.ts", "**/*.d.ts"],
  });
  const used = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf-8").matchAll(/(?:env|process\.env)\.([A-Z][A-Z0-9_]{2,})/g)) used.add(m[1]!);
  }
  const undeclared = [...used].filter((k) => !NON_SECRET_ALLOW.has(k) && SECRETISH.test(k) && !declared.has(k));
  expect(undeclared, `程式碼用機密 secret 但 manifest 沒列（見 10 §2，catch under-listing）:\n${undeclared.join("\n")}`).toHaveLength(0);
});

// ---------- §I — env-types ↔ REQUIRED_BINDING_KEYS（變體 B：assertBindings repo） ----------
it("I: src/types.ts ↔ REQUIRED_BINDING_KEYS 型別層鎖（assertBindings repo）", () => {
  const typesSrc = readFileSync(join(REPO, "src/types.ts"), "utf-8");
  // Env + AppBindings 兩個 interface 的宣告鍵（AppBindings extends Env → 取聯集）
  const declaredKeys = new Set<string>();
  for (const iface of ["Env", "AppBindings"]) {
    const block = typesSrc.match(new RegExp(`export interface ${iface}[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    for (const m of block.matchAll(/^\s*([A-Z][A-Z0-9_]+)(\?)?:\s*([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      declaredKeys.add(m[1]!);
    }
  }
  expect(declaredKeys.size, "§I: types.ts 解析 0 個宣告，regex 可能失效").toBeGreaterThan(0);

  const bindingsSrc = readFileSync(join(REPO, "src/lib/bindings.ts"), "utf-8");
  const rbBlock = bindingsSrc.match(/REQUIRED_BINDING_KEYS = \[([\s\S]*?)\]/)?.[1] ?? "";
  const requiredBindings = new Set([...rbBlock.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)].map((m) => m[1]!));
  expect(requiredBindings.size, "§I: REQUIRED_BINDING_KEYS 解析 0 個").toBeGreaterThan(0);

  // (a) REQUIRED_BINDING_KEYS 每個都要在 types.ts 宣告
  const notTyped = [...requiredBindings].filter((k) => !declaredKeys.has(k));
  expect(notTyped, `REQUIRED_BINDING_KEYS 有但 types.ts 沒宣告型別（§I）:\n${notTyped.join("\n")}`).toHaveLength(0);

  // (b) 接線實體检查：assertBindings 必須在 worker 入口被呼叫（10 §5.2 Layer 2 主力）
  const indexSrc = readFileSync(join(REPO, "src/index.ts"), "utf-8");
  expect(indexSrc, "§I: src/index.ts 未呼叫 assertBindings（10 §5.2 接線）").toMatch(/assertBindings\s*\(\s*env\s*\)/);
});

// ---------- §J — naming-convention（worker ∪ optional_worker） ----------
it("J: secret 命名遵循 {VENDOR}_{ROLE}_{TYPE}（既有進 legacy_names allowlist）", () => {
  const names = manifestDeclaredSecrets();
  if (names.length === 0) return;
  const secretsSection = manifestToml().split(/\[secrets\]/)[1]?.split(/^\[/m)[0] ?? "";
  const legacyMatch = secretsSection.match(/legacy_names\s*=\s*\[([^\]]*)\]/s);
  const legacy = new Set(legacyMatch ? [...legacyMatch[1]!.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]!) : []);

  const VALID_TYPE = /_(API_KEY|TOKEN|SECRET|ID|URL|DSN|ENDPOINT)$/;
  const BARE_KEY = /_(KEY)$/;
  const NUMERIC_VARIANT = /_?\d$/;
  const ENV_SUFFIX = /_(PROD|TEST|DEV|STAGING|PREVIEW)$/;
  const violations: string[] = [];
  for (const k of names) {
    if (legacy.has(k)) continue;
    const base = k.replace(ENV_SUFFIX, "");
    if (!/^[A-Z][A-Z0-9_]+$/.test(k)) violations.push(`${k}: 非全大寫 snake_case`);
    else if (!VALID_TYPE.test(base)) violations.push(`${k}: 結尾非合法 TYPE`);
    else if (BARE_KEY.test(base) && !/_API_KEY$/.test(base)) violations.push(`${k}: 裸 _KEY，改 _API_KEY`);
    else if (NUMERIC_VARIANT.test(base) && !/_V\d+$/.test(base)) violations.push(`${k}: 數字結尾，備援用 _BACKUP`);
  }
  expect(violations, `secret 命名違反 10 §3 結構:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- §K — framework-baseline presence ----------
it("K: framework 拷貝伴隨 .framework-baseline（防 merge-sync 靜默退化 MANUAL）", () => {
  const FW = [
    "01-CLAUDE.md", "02-BUILD-SPEC.md", "03-DOC-AND-CODE-REVIEW.md", "04-HARDENING_PROTOCOL.md",
    "05-FIX-SPEC.md", "06-REFLECT.md", "07-ALL-IN-ONE.md", "THINKING.md", "ENFORCEMENT_REGISTRY.md",
  ];
  const present = FW.filter((f) => existsSync(join(REPO, f)));
  if (present.length === 0) return;
  const violations: string[] = [];
  if (!existsSync(join(REPO, ".framework-baseline"))) {
    violations.push(`本地有 ${present.length} 個框架檔但無 .framework-baseline/ —— 跑 ./sync-framework.sh . --apply 建立`);
  } else {
    for (const f of present) {
      if (!existsSync(join(REPO, ".framework-baseline", f))) violations.push(`${f}: 本地有但 baseline 缺 → diverged 時退化 MANUAL`);
    }
  }
  expect(violations, `§K baseline 衛生:\n${violations.join("\n")}`).toHaveLength(0);
});
