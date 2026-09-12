// src/lib/auth.ts
// Shared authentication helpers for Watch-Dog Sentinel.

import type { Context } from 'hono';
import type { AppBindings, Project } from '../types';

/**
 * Constant-time string comparison.
 *
 * Uses the Workers-specific `crypto.subtle.timingSafeEqual` when available,
 * falling back to a manual XOR loop (constant-time for equal lengths).
 * Length mismatch returns early — token length is not treated as secret.
 *
 * Lengths are compared in **bytes** (UTF-8): crypto.subtle.timingSafeEqual
 * requires equal byteLength, so a UTF-16-only guard lets a multi-byte token
 * of equal code-unit length throw a TypeError (→ 500) instead of returning
 * false (TODO #20).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;

  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(aBuf.buffer as ArrayBuffer, bBuf.buffer as ArrayBuffer);
  }

  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * Extract the project token from a request: `Authorization: Bearer {token}`.
 * Legacy `X-Project-Token` header removed 2026-09-04 — cross-repo inventory
 * found zero remaining users (client_example.py already Bearer-only).
 */
export function extractProjectToken(c: Context<{ Bindings: AppBindings }>): string | undefined {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return undefined;
}

/**
 * Resolve and authenticate the project referenced by `projectId`.
 *
 * Returns the Project on success, or a 401/403/404 Response the caller
 * should return directly.
 */
export async function authenticateProject(
  c: Context<{ Bindings: AppBindings }>,
  projectId: string
): Promise<Project | Response> {
  const token = extractProjectToken(c);
  if (!token) {
    return c.json({ error: 'Missing Authorization header (use: Authorization: Bearer {token})' }, 401);
  }

  const project = await c.env.DB
    .prepare('SELECT * FROM projects WHERE id = ?')
    .bind(projectId)
    .first<Project>();

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }
  if (!timingSafeEqual(project.token, token)) {
    return c.json({ error: 'Invalid token for project' }, 403);
  }
  return project;
}
