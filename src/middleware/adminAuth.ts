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
import type { AppBindings } from '../types';

function challenge(c: Context<{ Bindings: AppBindings }>): Response {
  c.header('WWW-Authenticate', 'Basic realm="watch-dog-admin", charset="UTF-8"');
  return c.text('Unauthorized', 401);
}

export const adminAuth: MiddlewareHandler<{ Bindings: AppBindings }> = async (c, next) => {
  // CSRF guard: mutating requests must carry an XHR marker header. A
  // cross-origin <form> POST cannot set custom headers, which blocks
  // browser-replay of cached Basic credentials from other origins.
  // (htmx sends both accepted headers by default.)
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const isXhr =
      c.req.header('X-Requested-With') === 'XMLHttpRequest' || !!c.req.header('X-HX-Request');
    if (!isXhr) {
      return c.json({ error: 'Missing X-Requested-With header' }, 403);
    }
  }

  const expectedAccount = c.env.ADMIN_ACCOUNT;
  const expectedPassword = c.env.ADMIN_PASSWORD;
  if (!expectedAccount || !expectedPassword) {
    return c.text('Admin auth not configured: set the ADMIN_ACCOUNT and ADMIN_PASSWORD secrets', 503);
  }

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Basic ')) {
    return challenge(c);
  }

  let username: string;
  let password: string;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(':');
    if (sep === -1) {
      return challenge(c);
    }
    username = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  } catch {
    return challenge(c);
  }

  if (
    !username ||
    !password ||
    !timingSafeEqual(username, expectedAccount) ||
    !timingSafeEqual(password, expectedPassword)
  ) {
    return challenge(c);
  }

  await next();
};
