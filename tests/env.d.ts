// tests/env.d.ts
// Type support for vitest-pool-workers (`cloudflare:test` module) and the
// Vite `?raw` import used for the schema fixture.

/// <reference types="@cloudflare/vitest-plugin/types" />

declare module '*.sql?raw' {
  const content: string;
  export default content;
}
