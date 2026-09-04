// tests/bindings.test.ts
// TODO-REVIEW #9 — assertBindings 的執行路徑測試（app pool，直接呼叫 worker handler）。
// §I guard 只驗「接線存在」（index.ts 有呼叫），本檔驗「行為」：缺 ADMIN_TOKEN 時
// fetch 在進 app code 前就 throw——undefined 不會潛入 production code
//（10-SECRETS-CONTRACT §5.2 Layer 2 主力）。直接 import worker default handler
//（SELF 走 runtime 注入的完整 env，無法模擬「secret 被刪」情境）。
//
// 注意 cron 刻意繞過 assertBindings（見 bindings.ts 註解 trade-off）——本檔只鎖 fetch 路徑。

import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { AppBindings } from '../src/types';

const emptyEnv = { DB: {} } as unknown as AppBindings; // 模擬 deploy 後 ADMIN_TOKEN 被刪

describe('assertBindings (Layer 2 fail-fast, fetch entry)', () => {
  it('missing ADMIN_TOKEN → fetch throws before entering app code', async () => {
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    // index.ts 的 fetch wrapper 非 async——assertBindings 同步 throw，不會變成
    // rejected promise。async IIFE 把「同步 throw」與「rejected promise」兩種
    // surface 都收斂成 rejected promise 再斷言（不變式：缺 secret 必 fail-fast、
    // 訊息指名 key；至於 sync throw 或 1101 由 runtime 決定，非本測試鎖定範圍）。
    const fetchEntry = (async () =>
      worker.fetch(new Request('http://localhost/'), emptyEnv, ctx))();
    await expect(fetchEntry).rejects.toThrow(/missing required bindings\/secrets: ADMIN_TOKEN/);
  });

  it('直呼 assertBindings：缺值 throw、齊值通過（單元層）', async () => {
    const { assertBindings } = await import('../src/lib/bindings');
    expect(() => assertBindings(emptyEnv)).toThrow(/ADMIN_TOKEN/);
    expect(() => assertBindings({ ...emptyEnv, ADMIN_TOKEN: 'x' } as AppBindings)).not.toThrow();
  });
});
