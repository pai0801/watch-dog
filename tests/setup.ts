// tests/setup.ts
// Vitest setup file: lifecycle for the shared MSW network mock.
// Handlers registered via network.use(...) are reset after each test.

import { afterAll, afterEach, beforeAll } from 'vitest';
import { network } from './network';

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
