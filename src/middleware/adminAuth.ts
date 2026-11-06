// src/middleware/adminAuth.ts
// Basic-Auth gate for all /admin* routes.
//
// The account/password pair comes from the ADMIN_ACCOUNT / ADMIN_PASSWORD
// Worker secrets (set from .env by the operator); both are compared with
// timingSafeEqual — neither half of the pair is optional or ignored.
// Browsers cache Basic credentials per realm, so the server-rendered admin
// UI needs no client-side login code.

import type { Context, MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '../lib/auth';
import {
  LOCAL_IP_BUCKET,
  clearLoginFailures,
  isLoginLocked,
  registerLoginFailure,
} from '../services/loginGuard';
import type { AppBindings } from '../types';

function challenge(c: Context<{ Bindings: AppBindings }>): Response {
  c.header('WWW-Authenticate', 'Basic realm="watch-dog-admin", charset="UTF-8"');
  return c.text('Unauthorized', 401);
}

export const adminAuth: MiddlewareHandler<{ Bindings: AppBindings }> = async (c, next) => {
  // Failure-counter + lockout (SEC-REVIEW 1a / TODO-REVIEW N2, 2026-11-06):
  // key = cf-connecting-ip only (XFF is attacker-controlled). D1 errors in
  // the guard degrade to "counting unavailable" — the credential check
  // below stays the real gate, a D1 blip must not take the admin UI down.
  const ip = c.req.header('cf-connecting-ip') ?? LOCAL_IP_BUCKET;
  const now = Math.floor(Date.now() / 1000);
  try {
    if (await isLoginLocked(c.env.DB, ip, now)) {
      return c.text('Too many failed attempts — try again later.', 429);
    }
  } catch (e) {
    console.error(`loginGuard isLoginLocked failed (ip=${ip}):`, e);
  }

  /** Record a failed attempt (best-effort — see note above); always 401. */
  const fail = async (): Promise<Response> => {
    try {
      await registerLoginFailure(c.env.DB, ip, now);
    } catch (e) {
      console.error(`loginGuard registerLoginFailure failed (ip=${ip}):`, e);
    }
    return challenge(c);
  };

  // CSRF guard: mutating requests must carry an XHR marker header. A
  // cross-origin <form> POST cannot set custom headers, which blocks
  // browser-replay of cached Basic credentials from other origins.
  // htmx sends HX-Request by default (1.9.10 does NOT send
  // X-Requested-With — that convention belongs to jQuery/axios); the
  // X-Requested-With alternative stays accepted for the hx-headers
  // workarounds in adminViews and curl callers.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const isXhr =
      c.req.header('X-Requested-With') === 'XMLHttpRequest' || !!c.req.header('HX-Request');
    if (!isXhr) {
      return c.json({ error: 'Missing XHR marker header (HX-Request or X-Requested-With)' }, 403);
    }
  }

  const expectedAccount = c.env.ADMIN_ACCOUNT;
  const expectedPassword = c.env.ADMIN_PASSWORD;
  if (!expectedAccount || !expectedPassword) {
    return c.text('Admin auth not configured: set the ADMIN_ACCOUNT and ADMIN_PASSWORD secrets', 503);
  }

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Basic ')) {
    return fail();
  }

  let username: string;
  let password: string;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(':');
    if (sep === -1) {
      return fail();
    }
    username = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  } catch {
    return fail();
  }

  if (
    !username ||
    !password ||
    !timingSafeEqual(username, expectedAccount) ||
    !timingSafeEqual(password, expectedPassword)
  ) {
    return fail();
  }

  // Success: reset the counter (DELETE no-ops when clean — no per-request
  // write cost for normal operation).
  try {
    await clearLoginFailures(c.env.DB, ip);
  } catch {
    // Counter cleanup is cosmetic; a stale row just re-locks sooner.
  }

  await next();
};
