// src/lib/validate.ts
// Shared input validators for identifiers accepted from the outside world.
//
// Ids are interpolated into URLs, HTML attributes and (historically) Alpine
// expressions, so every ingestion point must constrain them to a safe
// charset. HTML-escaping alone is NOT enough for JS-valued attributes —
// the browser decodes entities before Alpine evaluates the expression.

/** Project ids: lowercase slug, URL-safe, no quotes/wildcards. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Check names: word-ish characters only (become `{projectId}:{name}` ids). */
export const CHECK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_PATTERN.test(id);
}

export function isValidCheckName(name: unknown): name is string {
  return typeof name === 'string' && CHECK_NAME_PATTERN.test(name);
}

/**
 * Coerce a numeric config field: finite numbers are floored and clamped to
 * `min`; anything else (undefined, NaN, strings) falls back to `fallback`.
 * Prevents nonsense like interval=0 that would mark a check dead instantly.
 */
export function clampInt(value: unknown, min: number, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

/** Escape SQLite LIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
