// tests/setup.ts
// Vitest setup file: lifecycle for the shared MSW network mock.
// Handlers registered via network.use(...) are reset after each test.

import { afterAll, afterEach, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { network } from './network';

// Default handler for the cross-monitor piggyback heartbeat: the fetch-path
// refresh fires on the FIRST request of every isolate (throttle starts at 0),
// so any test driving the worker via SELF.fetch emits one stray heartbeat to
// OPS_CONTROL_HEARTBEAT_URL (test override: ops-ctl.test.local). Without a
// matching handler MSW passes through → unhandled rejection noise in every
// test file. Later network.use(...) registrations shadow this (one-time
// handlers take precedence), so per-test hit-counting still works.
const opsHeartbeatDefault = () =>
  http.post('https://ops-ctl.test.local/api/heartbeat', () => HttpResponse.json({ ok: true }));

beforeAll(() => {
  network.enable();
  network.use(opsHeartbeatDefault()); // 第一個測試也有保護（per-file fresh MSW）
});
afterEach(() => {
  network.resetHandlers();
  network.use(opsHeartbeatDefault());
});
afterAll(() => network.disable());
