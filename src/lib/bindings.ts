// src/lib/bindings.ts
// Layer 2 startup check (10-SECRETS-CONTRACT §5.2) — the reliable main net.
// Missing required secret → fail fast at the worker entry (src/index.ts),
// never let undefined silently reach production code.
//
// Three-way sync point (guards §F/§G/§H hold the line):
//   .portability.toml [secrets].worker  ≡  REQUIRED_BINDING_KEYS  ≡  wrangler.jsonc secrets.required
//
// Note on the trade-off: this throw fires at the fetch entry (src/index.ts
// wrapper) only — the scheduled/cron path deliberately bypasses
// assertBindings (cron needs no ADMIN_TOKEN and must keep alerting even when
// the admin secret is missing). Layer 1 (secrets.required) blocks a deploy
// without it, so a correctly deployed worker always passes; a runtime throw
// means the secret was deleted after deploy — fetch fails loud, cron keeps
// watchdogging.

import type { AppBindings } from '../types';

/** Required runtime secrets (= .portability.toml [secrets].worker). */
export const REQUIRED_BINDING_KEYS = ['ADMIN_TOKEN'] as const;

/**
 * Optional runtime secrets — read through accessors below.
 * SLACK_API_TOKEN is a legacy fallback: the D1 settings table is the primary
 * source (configured via /admin); the env var only applies when that DB
 * setting is empty (services/settings.ts getEnvWithFallback).
 */
export const OPTIONAL_BINDING_KEYS = ['SLACK_API_TOKEN'] as const;

export function assertBindings(env: AppBindings): void {
  const missing = REQUIRED_BINDING_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `missing required bindings/secrets: ${missing.join(', ')} — see .portability.toml [secrets] and ~/Code/rules/10-SECRETS-CONTRACT §5.2`,
    );
  }
}

/** Optional secret accessor (10 §5.2 try* pattern): undefined when unset. */
export function trySlackApiToken(env: AppBindings): string | undefined {
  return env.SLACK_API_TOKEN || undefined;
}
