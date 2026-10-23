// src/index.ts
// Main entry point for Watch-Dog Sentinel: assembles the Hono app and
// exports the Worker fetch + scheduled handlers.
//
// No CORS middleware: every consumer is either the same-origin dashboard
// or a machine-to-machine API client sending Bearer tokens (immune to CSRF).
// Reflecting arbitrary requested headers on preflight would weaken the
// admin CSRF guard for no benefit.

import { Hono } from 'hono';
import type { AppBindings } from './types';
import dashboardRoutes from './routes/dashboard';
import apiRoutes from './routes/api';
import adminRoutes from './routes/admin';
import schedulesRoutes from './routes/schedules';
import { scheduled } from './cron';
import { piggybackOpsControlHeartbeat } from './services/crossMonitor';
import { assertBindings } from './lib/bindings';

const app = new Hono<{ Bindings: AppBindings }>();

app.route('/', dashboardRoutes);
app.route('/', apiRoutes);
// Public token-scoped API must mount BEFORE adminRoutes: admin registers
// `use('*', adminAuth)` which applies app-wide when mounted at '/', and
// middleware/handlers run in registration order (later-mounted handlers
// would be gated by Basic Auth). Same reason apiRoutes sits above.
app.route('/', schedulesRoutes);
app.route('/', adminRoutes);

export default {
  fetch: (request: Request, env: AppBindings, ctx: ExecutionContext): Response | Promise<Response> => {
    assertBindings(env); // per-request fail-fast (Workers have no startup hook)
    // Cross-monitor piggyback (throttled, fire-and-forget): keep the
    // ops-control heartbeat fresh from the fetch path — CF cron dispatch
    // jitter must not read as "worker dead". See crossMonitor.ts for the
    // semantics trade-off this implies.
    piggybackOpsControlHeartbeat(env, ctx);
    return app.fetch(request, env, ctx);
  },
  scheduled,
};
