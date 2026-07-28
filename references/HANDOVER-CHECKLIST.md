# HANDOVER-CHECKLIST — README 交接同位檢查（Cloudflare Stack）

> 對應 **D36（README Handover Parity，guard）**。
> 本檔定義 D36 對 `README.md` 的靜態檢查項——README 必須是**有效的交接入口**，不是過時裝飾。
> validator 下游實作於 `workers/tests/guards.test.ts`，每項 [MUST] 雙向驗證（fixed PASS / broken FAIL）。

---

## 為何需要（Why）

README 過時是交接最常見的斷層：接手者讀到的指令不存在、環境變數是 phantom、架構描述對不上。
**D36 把「README 反映現狀」從口號變成會 fail 的測試**——這是 README freshness 的硬性機制。

> 設計原則（同 D18）：prose「[MUST] 保持 README 更新」會被忽略；只有會 fail 的測試有強制性。
> 因此 D36 檢查的是**可靜態驗證**的具體事實，不是「README 品質好不好」的主觀判斷。

---

## D36 檢查項（全部 [MUST] PASS）

| # | 檢查 | 失敗條件 | 驗證來源 |
|---|---|---|---|
| 1 | **one-liner 存在** | title 後第一段為空 / 仍是模板佔位字（`<專案描述>` / `TODO`） | README |
| 2 | **技術棧一致** | README 宣稱的棧（astro/svelte/hono/drizzle）與 `package.json` dependencies 不符 | README ↔ package.json |
| 3 | **指令真實** | README 列的 `npm run <x>` script 在 `package.json` scripts 中不存在 | README ↔ package.json.scripts |
| 4 | **無 phantom 環境變數** | README 提及的每個 `ENV_VAR` 在 `wrangler.toml` `[vars]` / secret / 程式碼中找不到 | README ↔ wrangler.toml + code |
| 5 | **交接連結存在** | README 未連結 `01-CLAUDE.md` / 部署文件 / `/documentation/`（三者之一缺） | README |
| 6 | **Last-verified 標記** | README 無 `Last verified:` 日期或 cycle ref | README |

---

## Validator 模板（下游 instantiate）

```typescript
it('D36: README is a valid handover entry point (no drift)', () => {
  const readme = readFileSync('README.md', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const wrangler = readFileSync('wrangler.toml', 'utf8');

  // 1. one-liner 非空非佔位
  expect(firstParagraphAfterTitle(readme)).toBeTruthy();
  expect(readme).not.toMatch(/<專案描述>|<PROJECT_DESC>|TODO: describe/);

  // 2. 技術棧一致
  for (const stack of ['astro','svelte','hono','drizzle']) {
    if (new RegExp(`\\b${stack}\\b`, 'i').test(readme)) {
      expect(JSON.stringify(pkg.dependencies)).toMatch(stack);
    }
  }

  // 3. 指令真實——README 提到的每個 npm run <x> 必須是真 script
  for (const [, script] of readme.matchAll(/npm run ([a-z][\w-]*)/g)) {
    expect(Object.keys(pkg.scripts ?? {})).toContain(script);
  }

  // 4. 無 phantom env var——README 提到的 UPPER_VAR 必須存在於 wrangler/code
  for (const [, v] of readme.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const known = wrangler.includes(v) || grepCodeForVar(v);
    if (!known && !KNOWN_FRAMEWORK_VARS.includes(v)) expect.fail(`phantom env var: ${v}`);
  }

  // 5. 交接連結
  expect(readme).toMatch(/01-CLAUDE\.md/);
  expect(readme).toMatch(/deployment\.md|DEPLOYMENT\.md/);   // 連到 D35 文件
  expect(readme).toMatch(/documentation\//);

  // 6. last-verified
  expect(readme).toMatch(/Last verified:/i);
});
```

---

## 失敗時的處置（不在 guard 內，是流程）

- D36 fail → 登錄 `TODO-REVIEW.md` 為 `MISSING_DOC`（Critical）。
- 修法：跑 07 Phase D §5.2 同步 README，或走 05 fix flow 補齊。
- [NEVER] 為了通過 D36 而刪掉 README 中的指令/變數（那是隱瞞，不是修復）。

---

## 觸發 README 同步的日常路徑（02 / 05）

> README freshness 不只靠 07 手動觸發。下列變更發生時 [MUST] 同步 README（否則下次 D36 fail）：

| 本 cycle 變更 | [MUST] 同步 README 段落 |
|---|---|
| 新增/移除 npm script | 安裝/build/test 指令段 |
| 新增/移除環境變數或 secret | 環境變數段 |
| 新增/移除 API 端點、路由 | 架構 / API 概觀段 |
| 變更技術棧依賴 | 技術棧段 |
| 變更部署目標/env 矩陣 | 連結的 deployment.md + README 環境段 |

此表對應 02 §4 / 05 §4 的驗證清單新增項。
