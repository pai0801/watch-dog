import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Read bindings (D1, cron) from the real Wrangler config; tests run
      // against the actual worker entry, fully inside workerd.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only bindings (overrides .dev.vars / secrets)
        bindings: { ADMIN_ACCOUNT: 'test-admin', ADMIN_PASSWORD: 'test-admin-token' },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    // guards 是 Node-pool 檔案掃描（node:fs），不在 workerd 跑——見 vitest.guards.config.ts
    exclude: ['tests/guards/**'],
    setupFiles: ['tests/setup.ts'],
  },
});
