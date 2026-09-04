// tests/network.ts
// Shared MSW network mock: intercepts outbound fetches (Slack API) inside
// workerd. Individual tests register handlers with network.use(...).

import { setupNetwork } from '@msw/cloudflare';

export const network = setupNetwork();
