// D18/D19/D20/D21/D39 + D5（import 隔離）framework guards — vendored from references/GUARD-TEMPLATES.md
// （alliance-member 實例化先例）。watch-dog 本地適應：
// - D18 消費者版：本地 01-CLAUDE.md 依 01 §16 調整過（棧表/無 Drizzle 注記），count-based 等值
//   檢查會誤咬合法本地調整——canonical count-check 留在 rules repo；本版驗消費者有意義的不變量：
//   registry 覆蓋每個本地框架檔 + 無 dangling D##。
// - docs 清單含 07-ALL-IN-ONE.md（watch-dog 有拷貝 07）。
import { readFileSync, existsSync } from "node:fs";
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
