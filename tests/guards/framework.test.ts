// D18/D19/D20/D21/D39 + D5（import 隔離）framework guards — vendored from references/GUARD-TEMPLATES.md
// （alliance-member 實例化先例）。watch-dog 本地適應：
// - D18 消費者版：本地 01-CLAUDE.md 依 01 §16 調整過（棧表/無 Drizzle 注記），count-based 等值
//   檢查會誤咬合法本地調整——canonical count-check 留在 rules repo；本版驗消費者有意義的不變量：
//   registry 覆蓋每個本地框架檔 + 無 dangling D##。
// - docs 清單含 07-ALL-IN-ONE.md（watch-dog 有拷貝 07）。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { globSync } from "fast-glob";

const REPO = resolve(__dirname, "..", "..");

// ---------- D18 — registry 完整性（消費者版） ----------
it("D18: ENFORCEMENT_REGISTRY 覆蓋全部框架檔且無 dangling D##", () => {
  const registry = readFileSync(join(REPO, "ENFORCEMENT_REGISTRY.md"), "utf-8");
  const docs = [
    "01-CLAUDE.md", "02-BUILD-SPEC.md", "03-DOC-AND-CODE-REVIEW.md",
    "04-HARDENING_PROTOCOL.md", "05-FIX-SPEC.md", "06-REFLECT.md", "07-ALL-IN-ONE.md",
  ];
  const violations: string[] = [];

  // 1. 每個本地存在的框架檔都必須有 registry 區塊
  for (const d of docs) {
    if (!existsSync(join(REPO, d))) continue;
    if (!registry.includes(`## ${d.replace(".md", "")}`)) violations.push(`${d}: 本地存在但 registry 無對應區塊`);
  }

  // 2. registry 引用的每個 D## 必須在 04-HARDENING 有定義
  const dIds = [...new Set([...registry.matchAll(/\bD(\d{1,2})\b/g)].map((m) => `D${m[1]!}`))];
  const doc04 = readFileSync(join(REPO, "04-HARDENING_PROTOCOL.md"), "utf-8");
  const dangling = dIds.filter((id) => !new RegExp(`\\b${id}\\b`).test(doc04));
  if (dangling.length > 0) violations.push(`registry 引用未定義 D##: ${dangling.join(", ")}`);

  expect(violations, `D18 registry 完整性:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- D19 — FIX-LOG artifact ----------
it("D19: FIX-LOG.md 存在，既有 entry 具四欄位（目標/原因/預期結果/範圍）", () => {
  const p = join(REPO, "FIX-LOG.md");
  expect(existsSync(p), "FIX-LOG.md 缺失（見 05-FIX-SPEC §1/§4/§5）").toBe(true);
  const content = readFileSync(p, "utf-8");
  const entries = [...content.matchAll(/^### \[[\d-]+\].*$/gm)];
  const missing = entries.filter((e) => {
    // slice 起點必須跳過 header 行本身——否則 split 邊界落在 offset 0，[0] 恆為空字串、
    // 任何 entry 都判「缺四欄位」（alliance 實測踩過的潛在 bug）。
    const block = content.slice((e.index ?? 0) + e[0].length).split(/^### /m)[0] ?? "";
    return !(["目標", "原因", "預期結果", "範圍"] as const).every((f) => block.includes(f));
  });
  expect(missing.length, `FIX-LOG entry 缺四欄位:\n${missing.map((m) => m[0]).join("\n")}`).toBe(0);
});

// ---------- D20 — REFLECT artifact ----------
it("D20: REFLECT.md 存在且 R1–R5 各段非空（無裸 N/A 逃避）", () => {
  const p = join(REPO, "REFLECT.md");
  expect(existsSync(p), "REFLECT.md 缺失（見 06-REFLECT §3/§4/§5）").toBe(true);
  const content = readFileSync(p, "utf-8");
  const violations: string[] = [];
  for (const r of ["R1", "R2", "R3", "R4", "R5"]) {
    const m = content.match(new RegExp(`### ${r}[^\\n]*\\n([\\s\\S]*?)(?=### |## |$)`));
    const body = m?.[1]?.trim() ?? "";
    if (body.length === 0) violations.push(`${r}: 段落空白`);
    else if (/^N\/A$/m.test(body)) violations.push(`${r}: 裸 N/A 逃避`);
  }
  expect(violations, `D20 REFLECT 完整性:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- D21 — THINK block artifact ----------
it("D21: THINKING.md 模板在位（non-trivial 變更引用 THINK block 的紀律入口）", () => {
  const p = join(REPO, "THINKING.md");
  expect(existsSync(p), "THINKING.md 缺失（見 02 §1 / 05 §3）").toBe(true);
  // diff 級強制（non-trivial commit 引用 THINK block）由 pre-push gate 與 code review 承載，
  // 本 guard 鎖模板存在性——模板消失 = 紀律入口消失。
});

// ---------- D39 — noUnusedParameters 介面收縮 ----------
it("D39: tsconfig noUnusedParameters/noUnusedLocals 啟用", () => {
  const raw = readFileSync(join(REPO, "tsconfig.json"), "utf-8");
  expect(/"noUnusedParameters"\s*:\s*true/.test(raw), "noUnusedParameters 未啟用（14 §2.2 介面收縮）").toBe(true);
  expect(/"noUnusedLocals"\s*:\s*true/.test(raw), "noUnusedLocals 未啟用").toBe(true);
});

// ---------- D5 — cloudflare:workers import 隔離（01 §2 Runtime Gateway） ----------
it("D5: cloudflare:workers 只能出現在 src/lib/runtime.ts（gateway 尚未建立 → 目前全禁）", () => {
  const files = globSync("src/**/*.ts", { cwd: REPO, absolute: true, ignore: ["src/lib/runtime.ts"] });
  // TODO-REVIEW #14：單/雙引號兩形態（repo 無 quotes lint 鎖風格）
  const violations = files.filter((f) => /from ['"]cloudflare:workers['"]/.test(readFileSync(f, "utf-8")));
  expect(violations, `cloudflare:workers import 隔離違規（01 §2 Runtime Gateway）:\n${violations.join("\n")}`).toHaveLength(0);
});

// ---------- AGENTS↔CLAUDE 同步（TODO-REVIEW #16 — header 宣稱 [MUST] 兩檔同步，機械鎖） ----------
it("AGENTS.md 與 CLAUDE.md body 一致（SSoT = CLAUDE.md；僅 header 可不同）", () => {
  const stripHeader = (s: string) => {
    const lines = s.split("\n");
    const firstContent = lines.findIndex((l) => l.startsWith("## "));
    return lines.slice(firstContent).join("\n");
  };
  const claude = stripHeader(readFileSync(join(REPO, "CLAUDE.md"), "utf-8"));
  const agents = stripHeader(readFileSync(join(REPO, "AGENTS.md"), "utf-8"));
  expect(claude, "CLAUDE.md 解析後為空（stripHeader regex 失效？）").not.toBe("");
  expect(agents, "AGENTS.md body 與 CLAUDE.md 不一致——AGENTS.md header 自稱 [MUST] 兩檔同步，改動請同步改兩邊（SSoT = CLAUDE.md）").toBe(claude);
});

// ============================================================================
// 07-ALL-IN-ONE cycle 2026-11-06 擴充——D16/D17/D26-D37（GUARD-TEMPLATES 實例化，
// hotel-cms 接線策略：structural proxy + violation-injection 非空證明）。
// 適配註記：本 repo guards 位於 tests/guards/（非 workers/tests/）；文檔集在
// documentation/；歷史檔（CHANGELOG/FIX-LOG/REFLECT/TODO-REVIEW）的 cite 是
// 缺陷發生時的所在，刻意不掃（D16 模板同款排除）。
// ============================================================================

const HISTORICAL_DOCS = ["CHANGELOG.md", "FIX-LOG.md", "REFLECT.md", "TODO-REVIEW.md", "THINKING.md"];

/** 最新（檔案頂第一個）cycle section 的原始文。 */
function firstCycleSection(content: string): string {
  return content.split(/^## (?!\[)/m)[1] ?? content;
}

// ---------- D16 — 現況文檔 code-path drift ----------
it("D16: 現況文檔的 code-path cite 必須指向存在的檔案", () => {
  // 01-CLAUDE.md 是框架副本（其 src/lib/runtime.ts 引用是 rules 的 gateway 預留位，
  // 已知刻意豁免——guard-coverage-report D5 註記）；docs/plans/、docs/log/ 為歷史歸檔。
  const docFiles = globSync(
    "{CLAUDE.md,AGENTS.md,README.md,documentation/**/*.md,docs/*.md}",
    { cwd: REPO, absolute: true }
  ).filter((f) => !HISTORICAL_DOCS.some((h) => f.endsWith(h)));
  // lookbehind 排除「更長路徑的中段」（~/Code/rules/scripts/… 是外部 repo 引用，非本 repo cite）
  const pathRe = /(?<![\w~/.-])(?:src|tests|scripts)\/[\w/.-]+\.(?:ts|tsx|js|sql|sh|py)/g;
  // 已知刻意豁免（文件化）：guard-coverage-report 記載 D5 的 gateway 預留位（runtime.ts 尚未建立=全禁）
  const D16_EXEMPT = new Set(["docs/guard-coverage-report.md::src/lib/runtime.ts"]);
  const violations: string[] = [];
  for (const doc of docFiles) {
    const content = readFileSync(doc, "utf-8");
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(content)) !== null) {
      const cited = m[0];
      if (cited.includes("{") || cited.includes("}")) continue;
      const rel = doc.slice(REPO.length + 1);
      if (D16_EXEMPT.has(`${rel}::${cited}`)) continue;
      if (!existsSync(join(REPO, cited))) violations.push(`${doc} cite 幽靈路徑：${cited}`);
    }
  }
  expect(docFiles.length, "D16 掃描到 0 檔——glob 失效（vacuous PASS 風險）").toBeGreaterThan(5);
  expect(violations, `doc-path drift:\n${violations.join("\n")}`).toEqual([]);
});

// ---------- D17 — Fix→Lock 標籤 parity ----------
it("D17: CHANGELOG 最新 cycle 每條 Fixed bullet 攜帶 lock/human tag", () => {
  const content = readFileSync(join(REPO, "CHANGELOG.md"), "utf-8");
  const cycle = firstCycleSection(content);
  const fixedSection = cycle.split(/^### Fixed/m)[1]?.split(/^### /m)[0] ?? "";
  const bullets = [...fixedSection.matchAll(/^- .+$/gm)].map((m) => m[0]);
  expect(bullets.length, "最新 cycle 無 Fixed 條目（本 guard 針對 fix 條目；無 fix 請註記）").toBeGreaterThan(0);
  // lock 家族：D##（04 定義）＋專案機制族（SEC-*/DEP-*，分級表真源 TODO-REVIEW）
  const bad = bullets.filter((b) => !/\(locked: (D\d+|SEC-[a-z0-9-]+|DEP-[A-Z0-9]+)\)$|\(human: .+\)$/.test(b));
  expect(bad, `Fixed bullet 缺 (locked: …)/(human: …) tag:\n${bad.join("\n")}`).toEqual([]);
});

// ---------- D26 — documentation 核心集 ----------
it("D26: /documentation/ 核心集 5 份＋architecture.md Related Documents 索引", () => {
  const core = ["architecture", "flows", "permissions", "variables", "tests"] as const;
  const missing = core.filter((f) => !existsSync(join(REPO, "documentation", `${f}.md`)));
  expect(missing, `D26 核心集缺檔: ${missing.join(", ")}`).toEqual([]);
  const arch = readFileSync(join(REPO, "documentation", "architecture.md"), "utf-8");
  const notIndexed = core.filter((f) => f !== "architecture" && !arch.includes(`${f}.md`));
  expect(notIndexed, `architecture.md Related Documents 未指名: ${notIndexed.join(", ")}`).toEqual([]);
  // Conditional 註記：能力存在與否必須明示（不發明空文檔）
  expect(arch, "architecture.md 缺條件文檔判定註記（emails/cron/seo/automation）").toMatch(/seo\.md N\/A|cron\.md|條件文檔/);
});

// ---------- D27 — Intent-vs-Implementation parity（structural proxy） ----------
it("D27: permissions.md 每條 rule row 附 code cite；flows.md 每節 ≥1 cite", () => {
  const perms = readFileSync(join(REPO, "documentation", "permissions.md"), "utf-8");
  // 矩陣資料列（含 ✅/❌ 者 = rule row）；cite = 檔案路徑（副檔名收尾，行號可選）
  const citeRe = /[\w/.-]+\.(?:ts|sql|jsonc|sh)(?::\d+)?/;
  const rows = [...perms.matchAll(/^\|.*[✅❌].*\|$/gm)].map((m) => m[0]);
  expect(rows.length, "permissions.md 矩陣 0 列——解析失效（vacuous PASS 風險）").toBeGreaterThan(10);
  const noCite = rows.filter((r) => !citeRe.test(r));
  expect(noCite, `rule row 無 code cite（D27 silent unverified）:\n${noCite.join("\n")}`).toEqual([]);

  const flows = readFileSync(join(REPO, "documentation", "flows.md"), "utf-8");
  const sections = flows.split(/^## /m).slice(1);
  expect(sections.length, "flows.md 無 section").toBeGreaterThan(0);
  const noCiteSec = sections.filter((s) => !citeRe.test(s)).map((s) => s.split("\n")[0]);
  expect(noCiteSec, `flows.md 節缺 cite: ${noCiteSec.join(", ")}`).toEqual([]);
});

// ---------- D28 — tests.md 測試地圖 ----------
it("D28: tests.md 三分離 section＋每條 rule row 帶 status", () => {
  const content = readFileSync(join(REPO, "documentation", "tests.md"), "utf-8");
  for (const h of ["## Existing coverage", "## Proposed tests", "## Gaps"]) {
    expect(content.includes(h), `tests.md 缺 section: ${h}`).toBe(true);
  }
  const rows = [...content.matchAll(/^\|(?![-\s|]*\|)[^\n]+$/gm)].map((m) => m[0])
    .filter((r) => !/^\|\s*(use-case|---)/.test(r));
  expect(rows.length, "tests.md 0 資料列——解析失效（vacuous PASS 風險）").toBeGreaterThan(10);
  const noStatus = rows.filter((r) => !/(existing|proposed|none)/.test(r));
  expect(noStatus, `rule row 缺 status:\n${noStatus.join("\n")}`).toEqual([]);
});

// ---------- D29 — ship-check gate 接線 ----------
it("D29: ship-check 腳本存在且接進 make ci", () => {
  const script = join(REPO, "scripts", "ship-check.sh");
  expect(existsSync(script), "scripts/ship-check.sh 缺失（07 §5.4 三項檢查）").toBe(true);
  const makefile = readFileSync(join(REPO, "Makefile"), "utf-8");
  expect(makefile.includes("ship-check"), "ship-check 未接進 Makefile ci target（gate 未生效）").toBe(true);
});

// ---------- D30 — Retro ----------
it("D30: REFLECT 最新 cycle 含 retro action items（owner+deadline）＋carry-over", () => {
  const content = readFileSync(join(REPO, "REFLECT.md"), "utf-8");
  const retro = content.split(/^### RETRO/m)[1]?.split(/^### /m)[0] ?? "";
  expect(retro, "最新 cycle 無 RETRO 段").not.toBe("");
  const actionRows = [...retro.matchAll(/^\| A\d+ \|.*\|$/gm)].map((m) => m[0]);
  expect(actionRows.length, "retro 無 action item row（| A# | … | Owner | Deadline |）").toBeGreaterThan(0);
  const incomplete = actionRows.filter((r) => {
    const cells = r.split("|").map((c) => c.trim());
    // | A# | action | owner | deadline | → 6 cells；slice(2, -1) 跳過首尾的拆分空字串
    return cells.length < 6 || cells.slice(2, -1).some((c) => c === "");
  });
  expect(incomplete, `action row 缺 owner/deadline:\n${incomplete.join("\n")}`).toEqual([]);
  expect(retro.includes("Carry-over"), "retro 缺 carry-over 段").toBe(true);
});

// ---------- D31 — Pre-mortem ----------
it("D31: 最新 cycle 含 PRE-MORTEM；launch-blocking Tiger 皆具 mitigation+owner+date", () => {
  const content = readFileSync(join(REPO, "REFLECT.md"), "utf-8");
  const pm = content.split(/^### PRE-MORTEM/m)[1]?.split(/^### /m)[0] ?? "";
  expect(pm, "最新 cycle 無 PRE-MORTEM 段（04 §1.5 前置）").not.toBe("");
  expect(pm.includes("Tigers"), "PRE-MORTEM 缺 Tigers 分類").toBe(true);
  const tigers = [...pm.matchAll(/^\| T\d+ \|.*\|$/gm)].map((m) => m[0]);
  expect(tigers.length, "PRE-MORTEM 無 Tiger row").toBeGreaterThan(0);
  const blocking = tigers.filter((r) => r.includes("launch-blocking"));
  expect(blocking.length, "無 launch-blocking Tiger（本次為 hardening cycle——應有）").toBeGreaterThan(0);
  const incomplete = blocking.filter((r) => {
    const cells = r.split("|").map((c) => c.trim());
    // | T# | risk | evidence | class | mitigation | owner | date | → 8 cells（首尾空）
    return cells.length < 8 || cells.slice(2, 8).some((c) => c === "");
  });
  expect(incomplete, `launch-blocking Tiger 缺 mitigation/owner/date:\n${incomplete.join("\n")}`).toEqual([]);
});

// ---------- D32 — Release-notes 使用者利益開頭（structural proxy） ----------
it("D32: CHANGELOG 最新 cycle New/Improved/Fixed/Breaking 條目以粗體利益句開頭", () => {
  const content = readFileSync(join(REPO, "CHANGELOG.md"), "utf-8");
  const cycle = firstCycleSection(content);
  const bad: string[] = [];
  for (const h of ["New", "Improved", "Fixed", "Breaking"]) {
    const sec = cycle.split(new RegExp(`^### ${h}`, "m"))[1]?.split(/^### /m)[0] ?? "";
    for (const b of sec.matchAll(/^- .+$/gm)) {
      if (!/^- \*\*/.test(b[0])) bad.push(`[${h}] ${b[0]}`);
    }
  }
  expect(bad, `條目未以使用者利益（粗體句）開頭:\n${bad.join("\n")}`).toEqual([]);
});

// ---------- D33 — Acceptance scenarios（structural proxy） ----------
it("D33: 最新 FIX-LOG entry 引用 user-story 與 acceptance criteria", () => {
  const content = readFileSync(join(REPO, "FIX-LOG.md"), "utf-8");
  const first = content.split(/^### \[/m).slice(1)[0] ?? "";
  expect(first, "FIX-LOG 無 entry").not.toBe("");
  expect(first.includes("user-story") || first.toLowerCase().includes("user story"),
    "最新 FIX-LOG entry 缺 user-story（02 §2.1 / D33）").toBe(true);
  expect(/acceptance criteri|驗收/i.test(first), "最新 FIX-LOG entry 缺 acceptance criteria（D33）").toBe(true);
});

// ---------- D35 — Deployment & Operations Doc ----------
it("D35: deployment.md 就位且含 7 必填 section", () => {
  const p = join(REPO, "documentation", "deployment.md");
  const alt = join(REPO, "docs", "DEPLOYMENT.md");
  const content = existsSync(p) ? readFileSync(p, "utf-8")
    : existsSync(alt) ? readFileSync(alt, "utf-8") : "";
  expect(content, "deployment.md（或 docs/DEPLOYMENT.md）缺失").not.toBe("");
  const headings = ["環境矩陣", "部署指令", "Secrets 與變數", "Migration 順序", "回滾程序", "部署後驗證", "維運 Runbook"];
  const missing = headings.filter((h) => !new RegExp(`^## .*${h}`, "m").test(content));
  expect(missing, `deployment.md 缺 section: ${missing.join(", ")}`).toEqual([]);
});

// ---------- D36 — README Handover Parity（6 項） ----------
it("D36: README 是有效交接入口（無漂移）", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf-8");
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));

  // 1. one-liner 非空非佔位
  expect(readme.split("\n")[2]?.trim(), "title 後無 one-liner").toBeTruthy();
  expect(readme, "one-liner 仍是模板佔位").not.toMatch(/<專案描述>|<PROJECT_DESC>|TODO: describe/);

  // 2. 技術棧一致（提及即須在 deps；astro/svelte/drizzle 非本專案棧）
  for (const stack of ["astro", "svelte", "drizzle"]) {
    if (new RegExp(`\\b${stack}\\b`, "i").test(readme)) {
      expect(JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }), `README 宣稱 ${stack} 但 deps 無此套件`).toMatch(stack);
    }
  }

  // 3. 指令真實——README 提到的每個 npm run <x> 必須是真 script
  for (const [, script] of readme.matchAll(/npm run ([a-z][\w-]*)/g)) {
    expect(Object.keys(pkg.scripts ?? {}), `README 提及不存在的 script: npm run ${script}`).toContain(script);
  }

  // 4. 無 phantom env var——UPPER_VAR 須存在於 wrangler/manifest/code 或為 documented client-side/外部系統 var
  const knownSources = [
    readFileSync(join(REPO, "wrangler.jsonc"), "utf-8"),
    readFileSync(join(REPO, ".portability.toml"), "utf-8"),
  ].join("\n");
  // client-side（受監服務的 env）與 runbook 內外部系統變數（email-king）——README 文中已載明歸屬
  const KNOWN_CLIENT_VARS = ["WATCHDOG_URL", "WATCHDOG_PROJECT", "WATCHDOG_TOKEN", "API_SECRET_TOKEN", "DEV_PORT"];
  const codeHits = globSync("src/**/*.ts", { cwd: REPO, absolute: true })
    .map((f) => readFileSync(f, "utf-8")).join("\n");
  // env var 慣例＝含底線（排除 SSH/HSTS 等英文字首字母組合的誤判）
  for (const [, v] of readme.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
    const known = knownSources.includes(v) || codeHits.includes(v) || KNOWN_CLIENT_VARS.includes(v);
    expect(known, `phantom env var: ${v}（不在 wrangler/manifest/code，也非 documented client var）`).toBe(true);
  }

  // 5. 交接連結（01-CLAUDE / deployment 文檔 / documentation/）
  expect(readme, "缺 01-CLAUDE.md 連結").toMatch(/01-CLAUDE\.md/);
  expect(readme, "缺 deployment 文檔連結").toMatch(/deployment\.md/);
  expect(readme, "缺 documentation/ 連結").toMatch(/documentation\//);

  // 6. Last-verified 標記
  expect(readme, "缺 'Last verified:' 標記").toMatch(/Last verified:/);
});

// ---------- D37 — Volatile-number SSoT（static drift detector） ----------
it("D37: 揮發性數值（labeled）在現況文檔間無 drift（每 metric ≤1 值）", () => {
  const root = readdirSync(REPO).filter((f) => f.endsWith(".md"));
  const docDir = join(REPO, "documentation");
  const sub = existsSync(docDir) ? readdirSync(docDir).filter((f) => f.endsWith(".md")).map((f) => `documentation/${f}`) : [];
  const docs = [...root, ...sub].filter((f) => !HISTORICAL_DOCS.some((h) => f.endsWith(h)));
  const METRICS: Record<string, RegExp> = {
    schema_version: /schema(?:\s+version)?\s*v?(\d+)/gi,
    test_count: /(?<![A-Za-z0-9])(\d+)\s*(?:passed|tests)/gi,
    route_count: /(?<![A-Za-z0-9])(\d+)\s*(?:routes|endpoints)/gi,
  };
  const drifts: string[] = [];
  for (const [name, re] of Object.entries(METRICS)) {
    const values = new Set<string>();
    for (const doc of docs) {
      const content = readFileSync(join(REPO, doc), "utf-8");
      for (const m of content.matchAll(re)) values.add(`${doc}: ${m[1]}`);
    }
    const distinct = new Set([...values].map((v) => v.split(": ")[1]));
    if (distinct.size > 1) drifts.push(`${name}: ${[...values].join(" vs ")}`);
  }
  expect(drifts, `揮發性數值 drift（收斂到單一真源——見 DOCUMENTATION-SET §D37）:\n${drifts.join("\n")}`).toEqual([]);
});
