// tests/securityHeaders.test.ts
// Security-header baseline lock (TODO-REVIEW N1 / SEC-REVIEW 1d, 2026-11-06).
// Locks the four baseline headers from references/SECURITY-REVIEW.md §1d on
// BOTH the HTML surface and the API surface, plus the DENY frame override.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { resetDb } from './utils';

beforeEach(async () => {
  await resetDb();
});

const expectBaselineHeaders = (res: Response) => {
  expect(res.headers.get('X-Frame-Options')).toBe('DENY'); // overridden from hono's SAMEORIGIN default
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  // Defense-in-depth defaults that ship with hono secureHeaders().
  expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
};

describe('security headers baseline (secureHeaders middleware)', () => {
  it('HTML surface: GET / carries all four baseline headers', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    expectBaselineHeaders(res);
  });

  it('API surface: GET /api/status carries all four baseline headers', async () => {
    const res = await SELF.fetch('http://localhost/api/status');
    expect(res.status).toBe(200);
    expectBaselineHeaders(res);
  });

  it('error responses keep the headers too (401 path)', async () => {
    const res = await SELF.fetch('http://localhost/admin');
    expect(res.status).toBe(401);
    expectBaselineHeaders(res);
  });
});
