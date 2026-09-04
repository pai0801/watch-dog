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
        bindings: { ADMIN_TOKEN: 'test-admin-token' },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
