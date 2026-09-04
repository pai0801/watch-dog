// src/services/maintenance.ts
// Maintenance-mode state transitions shared by the API and admin routes.

import { D1Database } from '@cloudflare/workers-types';
import type { Project } from '../types';

export interface MaintenanceResult {
  maintenance_mode: boolean;
  maintenance_until: number | null;
}

/**
 * Compute and persist the new maintenance window for a project.
 *
 * Semantics (matches the legacy POST /api/maintenance contract):
 * - enabled === false → clear maintenance
 * - enabled === true  → mute for `duration` seconds (default 3600)
 * - duration only     → mute for `duration` seconds
 * - neither           → toggle (clear if active, else mute 1h)
 */
export async function setMaintenance(
  db: D1Database,
  project: Project,
  body: { enabled?: boolean | string; duration?: number | string },
  now: number
): Promise<MaintenanceResult> {
  const enabled = body.enabled === true || body.enabled === 'true';
  const disabled = body.enabled === false || body.enabled === 'false';
  const duration =
    body.duration !== undefined && body.duration !== '' && Number.isFinite(Number(body.duration))
      ? Number(body.duration)
      : undefined;

  let until: number;
  if (disabled) {
    until = 0;
  } else if (enabled) {
    until = now + (duration !== undefined && duration > 0 ? duration : 3600);
  } else if (duration !== undefined) {
    until = now + duration;
  } else if (project.maintenance_until > now) {
    until = 0;
  } else {
    until = now + 3600;
  }

  await db
    .prepare('UPDATE projects SET maintenance_until = ? WHERE id = ?')
    .bind(until, project.id)
    .run();

  return {
    maintenance_mode: until > now,
    maintenance_until: until > now ? until : null,
  };
}
