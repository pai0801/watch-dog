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
    await expect(
      worker.fetch(new Request('http://localhost/'), emptyEnv, ctx),
    ).rejects.toThrow(/missing required bindings\/secrets: ADMIN_TOKEN/);
  });

  it('直呼 assertBindings：缺值 throw、齊值通過（單元層）', async () => {
    const { assertBindings } = await import('../src/lib/bindings');
    expect(() => assertBindings(emptyEnv)).toThrow(/ADMIN_TOKEN/);
    expect(() => assertBindings({ ...emptyEnv, ADMIN_TOKEN: 'x' } as AppBindings)).not.toThrow();
  });
});
