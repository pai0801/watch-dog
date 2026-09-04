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
import { scheduled } from './cron';

const app = new Hono<{ Bindings: AppBindings }>();

app.route('/', dashboardRoutes);
app.route('/', apiRoutes);
app.route('/', adminRoutes);

export default {
  fetch: app.fetch,
  scheduled,
};
