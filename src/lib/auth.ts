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
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    const encoder = new TextEncoder();
    return subtle.timingSafeEqual(
      encoder.encode(a).buffer as ArrayBuffer,
      encoder.encode(b).buffer as ArrayBuffer
    );
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
