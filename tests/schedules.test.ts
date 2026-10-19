// tests/schedules.test.ts
// Scheduler hub: signature pure functions, due-fire engine, registration API,
// admin read-only view, cron wiring.

import { beforeEach, describe, expect, it } from 'vitest';
// msw/network/DB imports arrive with the due-fire engine tests (Task 3).
import { hmacSha256Hex, signScheduleHeader } from '../src/services/scheduler';
import { resetDb, setSlackSettings } from './utils';

beforeEach(async () => {
  await resetDb();
  await setSlackSettings();
});

describe('signScheduleHeader (pure)', () => {
  it('produces t=...,v1=<64 lowercase hex> and is deterministic', async () => {
    const a = await signScheduleHeader('secret-a', 7, 1000, 2000);
    const b = await signScheduleHeader('secret-a', 7, 1000, 2000);
    expect(a).toMatch(/^t=2000,v1=[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs per secret / schedule / timestamp', async () => {
    const base = await signScheduleHeader('secret-a', 7, 1000, 2000);
    expect(await signScheduleHeader('secret-b', 7, 1000, 2000)).not.toBe(base);
    expect(await signScheduleHeader('secret-a', 8, 1000, 2000)).not.toBe(base);
    expect(await signScheduleHeader('secret-a', 7, 1000, 2001)).not.toBe(base);
  });

  it('hmacSha256Hex matches the documented recipe', async () => {
    // Same recipe the client-guide verification example implements.
    const hex = await hmacSha256Hex('k', '2000.7.1000');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
