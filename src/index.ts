// src/index.ts
// Main entry point for Watch-Dog Sentinel: assembles the Hono app and
// exports the Worker fetch + scheduled handlers.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppBindings } from './types';
import dashboardRoutes from './routes/dashboard';
import apiRoutes from './routes/api';
import adminRoutes from './routes/admin';
import { scheduled } from './cron';

const app = new Hono<{ Bindings: AppBindings }>();

// Enable CORS for all routes
app.use('*', cors());

app.route('/', dashboardRoutes);
app.route('/', apiRoutes);
app.route('/', adminRoutes);

export default {
  fetch: app.fetch,
  scheduled,
};
