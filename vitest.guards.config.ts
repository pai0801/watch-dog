import { defineConfig } from "vitest/config";

// Node pool：tests/guards/（§A–§K portability + D18–D21/預算/D5 framework guards）——
// 純檔案/字串掃描，不需要 workerd。app 的 workerd 全保真測試走 vitest.config.ts（npm run test:app）。
// 刻意分離雙 pool（alliance-member 先例）：guard 掃描在 Node 秒級完成，
// 且 vitest.config.ts exclude tests/guards/** 避免 workerd pool 撿到 Node-only 測試。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/guards/**/*.test.ts"],
  },
});
