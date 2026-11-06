// tests/loginGuard.test.ts
// Admin Basic-Auth failure counter + lockout (TODO-REVIEW N2 / SEC-REVIEW 1a,
// 2026-11-06). Two layers of evidence (SECURITY-REVIEW §1e):
// 1. Service-layer direct tests with an injected clock (SEC §2 陷阱 6: the
//    miniflare environment pins cf-connecting-ip, so middleware-level tests
//    cannot exercise per-IP keys — unit-test the service).
// 2. Middleware-level lockout: 20 wrong passwords → the 21st request is 429
//    EVEN WITH correct credentials (locked = pre-credential rejection).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  LOGIN_FAILURE_MAX,
  LOGIN_FAILURE_WINDOW_S,
  LOCAL_IP_BUCKET,
  clearLoginFailures,
  isLoginLocked,
  registerLoginFailure,
} from '../src/services/loginGuard';
import { DB, resetDb } from './utils';

const ADMIN_ACCOUNT = 'test-admin';
const ADMIN_PASSWORD = 'test-admin-token';
const basic = (password: string, account: string = ADMIN_ACCOUNT) =>
  `Basic ${btoa(`${account}:${password}`)}`;

// Fixed clock: any epoch base works — service functions take `now` as input.
const T0 = 1_800_000_000;

beforeEach(async () => {
  await resetDb();
});

describe('loginGuard service layer (injected clock)', () => {
  it('locks only at the exported threshold, not before', async () => {
    for (let i = 1; i < LOGIN_FAILURE_MAX; i++) {
      const count = await registerLoginFailure(DB, '1.2.3.4', T0 + i);
      expect(count).toBe(i);
      expect(await isLoginLocked(DB, '1.2.3.4', T0 + i)).toBe(false);
    }
    const count = await registerLoginFailure(DB, '1.2.3.4', T0 + LOGIN_FAILURE_MAX);
    expect(count).toBe(LOGIN_FAILURE_MAX);
    expect(await isLoginLocked(DB, '1.2.3.4', T0 + LOGIN_FAILURE_MAX)).toBe(true);
  });

  it('window expiry resets the count to 1 (atomic single-UPSERT reset)', async () => {
    await registerLoginFailure(DB, '1.2.3.4', T0);
    await registerLoginFailure(DB, '1.2.3.4', T0 + 1);
    // First failure AFTER the window: count restarts at 1, not 3.
    const count = await registerLoginFailure(DB, '1.2.3.4', T0 + LOGIN_FAILURE_WINDOW_S + 5);
    expect(count).toBe(1);
    expect(await isLoginLocked(DB, '1.2.3.4', T0 + LOGIN_FAILURE_WINDOW_S + 5)).toBe(false);
  });

  it('expired-window rows do not lock (isLocked ignores stale counts)', async () => {
    await registerLoginFailure(DB, '1.2.3.4', T0);
    // Wind the clock past the window without a new failure.
    expect(await isLoginLocked(DB, '1.2.3.4', T0 + LOGIN_FAILURE_WINDOW_S + 1)).toBe(false);
  });

  it('per-IP isolation: one locked IP does not affect another', async () => {
    for (let i = 0; i < LOGIN_FAILURE_MAX; i++) {
      await registerLoginFailure(DB, '5.6.7.8', T0 + i);
    }
    expect(await isLoginLocked(DB, '5.6.7.8', T0)).toBe(true);
    expect(await isLoginLocked(DB, '9.10.11.12', T0)).toBe(false);
  });

  it('clearLoginFailures unlocks immediately', async () => {
    for (let i = 0; i < LOGIN_FAILURE_MAX; i++) {
      await registerLoginFailure(DB, '5.6.7.8', T0 + i);
    }
    await clearLoginFailures(DB, '5.6.7.8');
    expect(await isLoginLocked(DB, '5.6.7.8', T0)).toBe(false);
  });

  it('threshold constants are pinned (ops-control style coupling base)', () => {
    // 20 failures / 15 min — changing these is an operator-visible policy
    // change; the pin forces a conscious decision.
    expect(LOGIN_FAILURE_MAX).toBe(20);
    expect(LOGIN_FAILURE_WINDOW_S).toBe(900);
    expect(LOCAL_IP_BUCKET).toBe('local');
  });
});

describe('adminAuth middleware lockout (end-to-end, shared local bucket)', () => {
  // 22+ sequential workerd roundtrips (each with D1 SELECT/UPSERT) — slow
  // under full-suite parallel load; 20s ceiling keeps it honest without
  // flaking (default 5s observed insufficient 2026-11-06 full run).
  it('21st request is 429 even with correct credentials after 20 failures', async () => {
    // The test pool has no per-IP header unless we send one — exercise the
    // per-IP path explicitly with CF-Connecting-IP (the only key the
    // middleware may trust; SEC §2 陷阱 4).
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 20; i++) {
      const res = await SELF.fetch('http://localhost/admin', {
        headers: { ...ip, Authorization: basic('wrong-password') },
      });
      expect(res.status).toBe(401);
    }
    // Correct credentials — still locked out (pre-credential 429).
    const locked = await SELF.fetch('http://localhost/admin', {
      headers: { ...ip, Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(locked.status).toBe(429);

    // A different IP is unaffected.
    const other = await SELF.fetch('http://localhost/admin', {
      headers: { 'CF-Connecting-IP': '203.0.113.10', Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(other.status).toBe(200);
  }, 20_000);

  it('successful auth clears the counter (failure then success then no lock)', async () => {
    const ip = { 'CF-Connecting-IP': '203.0.113.11' };
    const fail = await SELF.fetch('http://localhost/admin', {
      headers: { ...ip, Authorization: basic('wrong-password') },
    });
    expect(fail.status).toBe(401);

    const ok = await SELF.fetch('http://localhost/admin', {
      headers: { ...ip, Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(ok.status).toBe(200);

    // Counter cleared: LOGIN_FAILURE_MAX - 1 more failures must NOT lock.
    for (let i = 0; i < LOGIN_FAILURE_MAX - 1; i++) {
      const res = await SELF.fetch('http://localhost/admin', {
        headers: { ...ip, Authorization: basic('wrong-password') },
      });
      expect(res.status).toBe(401);
    }
    const stillOpen = await SELF.fetch('http://localhost/admin', {
      headers: { ...ip, Authorization: basic(ADMIN_PASSWORD) },
    });
    expect(stillOpen.status).toBe(200);
  }, 20_000);
});
