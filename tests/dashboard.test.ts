// tests/dashboard.test.ts
// Public homepage (GET /) — dual-tab shell + CF usage pane.
//
// The security invariant under test: the homepage is PUBLIC but must never
// leak the 32-hex CF account id — the route's SQL joins on it without
// selecting it, and this suite locks that at the HTML level (specific
// seeded ids + a generic 32-hex regex over the whole document).

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { SELF } from 'cloudflare:test';
import { resetResourceCaches } from '../src/services/cfResources';
import { network } from './network';
import {
  cfD1ListUrl,
  cfKvListUrl,
  DB,
  reapplySchema,
  resetDb,
  seedCfAccount,
  seedCheck,
  seedProject,
  seedResourceName,
  TEST_CF,
} from './utils';

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Seed one cf_usage_state row for today (the homepage reads day_utc = now). */
async function seedUsage(
  accountId: string,
  metric: string,
  value: number,
  projectedEod: number | null = null,
): Promise<void> {
  await DB.prepare(
    'INSERT INTO cf_usage_state (day_utc, account_id, metric, value, projected_eod, alerted_level) VALUES (?, ?, ?, ?, ?, 0)'
  )
    .bind(todayUtc(), accountId, metric, value, projectedEod)
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe('GET / — dual-tab homepage with CF usage pane', () => {
  it('renders both tabs, the CF pane (label + metric names + plan badge) and the status pane side by side', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
    await seedCfAccount({ label: 'helperp' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000);

    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // tab shell + hash-persisted tab state
    expect(html).toContain('服務狀態');
    expect(html).toContain('CF 用量');
    expect(html).toContain("location.hash === '#cf'");
    // status pane intact inside its tabpanel
    expect(html).toContain('Test Project');
    // CF pane: label (never the id), registry display name, plan badge
    expect(html).toContain('helperp');
    expect(html).toContain('D1 rows 讀取');
    expect(html).toContain('cf-plan-badge');
    // freshness uses the shared $time magic
    expect(html).toContain('$time(');
  });

  it('NEVER leaks the 32-hex account id into the public HTML (security)', async () => {
    await seedCfAccount({ label: 'A' });
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'B' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1);
    await seedUsage(TEST_CF.accountIdB, 'kv_ops', 1);

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).not.toContain(TEST_CF.accountId);
    expect(html).not.toContain(TEST_CF.accountIdB);
    // generic guard: no 32-hex run anywhere in the document
    expect(html.match(/[0-9a-f]{32}/)).toBeNull();
  });

  it('colors bars by threshold: <60% plain, >=60% warn, >=80% danger', async () => {
    await seedCfAccount();
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000);   // 20% of 5M — plain
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 65_000);   // 65% of 100k — warn
    await seedUsage(TEST_CF.accountId, 'workers_requests', 90_000);  // 90% of 100k — danger

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    // face renders the top (danger) metric; details re-renders all three —
    // the danger line therefore appears TWICE, warn/plain once (details only).
    // Regexes anchor on the attribute-closing quote because the <style> block
    // contains the same names as CSS selectors (bare substrings over-count);
    // blind spot: a projected row (cf-projected suffix) matches none of them,
    // so these counts are exact only for seeds without projected rows.
    expect((html.match(/cf-bar-fill"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-warn"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-danger"/g) ?? []).length).toBe(2);
  });

  it('marks projected-over-quota rows with stripes + warning flag + projected EOD text', async () => {
    await seedCfAccount();
    // 20% now, but the burn rate projects 150% of the 100k quota by UTC midnight
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 20_000, 150_000);
    await seedUsage(TEST_CF.accountId, 'kv_ops', 10_000); // non-projected control

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('cf-projected');
    expect(html).toContain('⚠');
    expect(html).toContain('預估'); // projected end-of-day value in the tooltip
  });

  it('colors by FORECAST ratio: low measured % + over-quota projection → danger color + chip + top rank (2026-09-14 ask)', async () => {
    // Burner: 20% measured but projecting 150% of quota — must look like a
    // breach; Steady: 30% measured, no projection. Before the fix the card
    // showed a plain bar, no chip, and sorted below Steady.
    await seedCfAccount({ label: 'Burner' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 20_000, 150_000);
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'Steady' });
    await seedUsage(TEST_CF.accountIdB, 'd1_rows_written', 30_000);

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    // Burner's row: measured 20% width but danger color from the forecast
    expect(html).toMatch(/class="cf-bar-fill cf-danger cf-projected"/);
    // chip counts the forecast-breach row; Burner ranks above the raw-30% card
    expect(html).toContain('1 項 ≥60%');
    expect(html.indexOf('Burner')).toBeLessThan(html.indexOf('Steady'));
  });

  it('renders unquoted metrics (workers_errors) as value-only, no bar', async () => {
    await seedCfAccount();
    await seedUsage(TEST_CF.accountId, 'workers_errors', 5);

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('Workers 錯誤');
    expect(html).toContain('>5<'); // raw count rendered
    // no rendered bar element anywhere (CSS selectors in <style> don't count —
    // anchor on the class attribute form)
    expect(html).not.toContain('class="cf-bar');
  });

  it('shows the empty state (pointing at /admin) when no accounts are configured', async () => {
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('尚無 CF 用量資料');
    expect(html).toContain('/admin');
    expect(html).not.toContain('class="cf-account-card"');
  });

  it('isolates a CF-side failure: status pane still renders, only the CF pane degrades', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedCheck('svc', { id: 'svc:health', name: 'health' });
    await DB.prepare('DROP TABLE cf_usage_state').run();
    try {
      const res = await SELF.fetch('http://localhost/');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Test Project');            // status pane survived
      expect(html).toContain('Error loading CF usage'); // CF pane degraded alone
    } finally {
      await reapplySchema(); // restore the dropped table
    }
  });
});

// ---- resource detail fragment (Task 6) ----

const detailFixture = () => ({
  data: {
    viewer: {
      accounts: [
        {
          // rows without a time dimension land in today's bucket (defensive
          // path); the 2026-09-10 rows exercise the yesterday column. The
          // fragment route fetches with real Date.now(), so 'today' is the
          // real UTC day — any fixed past date deterministically reads as
          // yesterday.
          wkr: [
            { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 1000, errors: 2 } },
            { dimensions: { scriptName: 'watch-dog' }, sum: { requests: 500, errors: 0 } },
          ],
          pgs: [
            { dimensions: { scriptName: 'pages-worker--13581012-production' }, sum: { requests: 300 } },
            { dimensions: { scriptName: 'pages-worker--13581012-production', date: '2026-09-10' }, sum: { requests: 250 } },
          ],
          d1: [
            { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555' }, sum: { rowsRead: 4_000_000, rowsWritten: 10_000 } },
            { dimensions: { databaseId: '11111111-2222-3333-4444-555555555555', date: '2026-09-10' }, sum: { rowsRead: 1_000_000, rowsWritten: 8_000 } },
            { dimensions: { databaseId: '99999999-8888-7777-6666-555555555555' }, sum: { rowsRead: 100, rowsWritten: 5 } },
          ],
          kvo: [{ dimensions: { namespaceId: 'abcdef0123456789abcdef0123456789' }, sum: { requests: 42 } }],
          kvs: [{ dimensions: { namespaceId: 'ABCDEF01-2345-6789-ABCD-EF0123456789' }, max: { byteCount: 1024, keyCount: 7 } }],
          r2s: [{ dimensions: { bucketName: 'media-bucket' }, max: { payloadSize: 2_000_000_000, objectCount: 120 } }],
        },
      ],
    },
  },
});
const REST_EMPTY = { success: true, result: [] };

describe('GET /cf-usage/detail — resource detail fragment', () => {
  beforeEach(async () => {
    await resetDb();
    resetResourceCaches();
    network.use(
      http.post(TEST_CF.gqlUrl, () => HttpResponse.json(detailFixture())),
      http.get(cfD1ListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY)),
      http.get(cfKvListUrl(TEST_CF.accountId), () => HttpResponse.json(REST_EMPTY))
    );
  });

  it('renders named groups per resource type with resolved names and usage', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedResourceName(TEST_CF.accountId, 'd1', '11111111-2222-3333-4444-555555555555', 'Production DB');
    await seedResourceName(TEST_CF.accountId, 'kv', 'abcdef0123456789abcdef0123456789', 'site-cache');

    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const title of ['Workers', 'Pages', 'D1 Databases', 'KV Namespaces', 'R2 Buckets']) {
      expect(html).toContain(title);
    }
    // workers: dimension value is the name; adaptive rows accumulated
    expect(html).toContain('watch-dog');
    expect(html).toContain('1,500');
    // pages: internal deployment name parsed into a tagged distinguishable name;
    // NO pages.dev link (the digits map to no project via any API — 2026-09-14 fix)
    expect(html).toContain('pages-worker #13581012（production）');
    expect(html).not.toContain('pages.dev');
    expect(html).not.toContain('--13581012');
    // yesterday's column: d1 rowsRead 1,000,000 / pages requests 250
    expect(html).toContain('昨 1,000,000');
    expect(html).toContain('昨 250');
    // resolved names win
    expect(html).toContain('Production DB');
    expect(html).toContain('site-cache');
    // r2 bucket name
    expect(html).toContain('media-bucket');
  });

  it('merges KV ops + storage into one row (single site-cache occurrence, KiB formatting)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedResourceName(TEST_CF.accountId, 'kv', 'abcdef0123456789abcdef0123456789', 'site-cache');
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    const html = await res.text();
    expect((html.match(/site-cache/g) ?? []).length).toBe(1);
    expect(html).toContain('KiB'); // 1024 bytes → human-readable
    // kv_ops rendered standalone in its own cell (timestamp HH:MM can't fake it)
    expect(html).toMatch(/<td>\s*42\s*<div class="cf-res-prev">昨 —<\/div>/);
  });

  it('NEVER leaks 32-hex ids (unresolved resources degrade to 8-char short ids)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    const html = await res.text();
    expect(html).toContain('99999999…'); // unresolved d1 → short id
    expect(html).toContain('abcdef01…'); // unresolved kv → short id
    expect(html).not.toContain(TEST_CF.accountId);
    expect(html.match(/[0-9a-f]{32}/)).toBeNull();
  });

  it('returns 200 + a friendly panel for an unknown label (htmx never swaps non-2xx)', async () => {
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=ghost');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('找不到啟用中的帳號');
  });

  it('returns 200 + an error panel when the upstream fetch fails (degrades alone)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    network.use(http.post(TEST_CF.gqlUrl, () => new HttpResponse(null, { status: 500 })));
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('資源明細載入失敗');
    expect(html).toContain('HTTP 500');
    // no id leak on the error path either (TODO #26) — the panel carries
    // upstream-controlled text sliced to 200 chars, none of it ours to echo
    expect(html.match(/[0-9a-f]{32}/)).toBeNull();
  });

  it('guards the empty label and the over-long label (no service call)', async () => {
    const bare = await SELF.fetch('http://localhost/cf-usage/detail');
    expect(bare.status).toBe(200);
    expect(await bare.text()).toContain('缺少 label 參數');
    const long = await SELF.fetch(`http://localhost/cf-usage/detail?label=${'x'.repeat(101)}`);
    expect(long.status).toBe(200);
    expect(await long.text()).toContain('label 參數過長');
  });

  it('renders the empty-groups fallback when the account has zero usage today', async () => {
    await seedCfAccount({ label: 'Test Account' });
    network.use(
      http.post(TEST_CF.gqlUrl, () => HttpResponse.json({ data: { viewer: { accounts: [{}] } } }))
    );
    const res = await SELF.fetch('http://localhost/cf-usage/detail?label=Test%20Account');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('近兩日無任何資源用量');
  });
});

describe('homepage card sorting + collapsed face (Task 7)', () => {
  it('sorts cards by max quota ratio desc (High Use 90% before Low Use 20%)', async () => {
    await seedCfAccount({ label: 'Low Use' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1_000_000); // 20%
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'High Use' });
    await seedUsage(TEST_CF.accountIdB, 'd1_rows_written', 90_000); // 90%
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html.indexOf('High Use')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('High Use')).toBeLessThan(html.indexOf('Low Use'));
  });

  it('R2 storage never drives ranking: no float-up, no face takeover, no amber-chip count', async () => {
    await seedCfAccount({ label: 'R2 Heavy' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 500_000); // 10% — its rankable top
    await seedUsage(TEST_CF.accountId, 'r2_storage_bytes', 9_600_000_000); // 89% of 10 GiB — unranked
    await seedCfAccount({ account_id: TEST_CF.accountIdB, api_token: TEST_CF.tokenB, label: 'D1 Real' });
    await seedUsage(TEST_CF.accountIdB, 'd1_rows_written', 30_000); // 30% — outranks 10%

    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    // card order follows rankable ratios only (30% > 10%) — the 89% gauge
    // must not float R2 Heavy above D1 Real
    expect(html.indexOf('D1 Real')).toBeLessThan(html.indexOf('R2 Heavy'));
    // R2 Heavy's collapsed face shows its D1 line; R2 storage only appears
    // later inside <details> (R2 Heavy sorts last, so the slice is its card)
    const card = html.slice(html.indexOf('R2 Heavy'));
    expect(card.indexOf('D1 rows 讀取')).toBeGreaterThanOrEqual(0);
    expect(card.indexOf('D1 rows 讀取')).toBeLessThan(card.indexOf('R2 儲存量'));
    // the 89% R2 row does not count into any ≥60% amber chip
    expect(html).not.toContain('項 ≥60%');
  });

  it('face shows the warn chip and the details/fragment wiring', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_written', 65_000); // 65% → 1 項 ≥60%
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain('1 項 ≥60%');
    expect(html).toContain('cf-warn-chip');
    expect(html).toContain('全部指標與資源明細');
    expect(html).toContain('hx-get="/cf-usage/detail?label=Test%20Account"');
    expect(html).toContain('hx-trigger="toggle from:closest details"');
  });

  it('pauses the 30s auto-reload while a detail is open (hyperscript guard)', async () => {
    await seedCfAccount({ label: 'Test Account' });
    await seedUsage(TEST_CF.accountId, 'd1_rows_read', 1);
    const res = await SELF.fetch('http://localhost/');
    const html = await res.text();
    expect(html).toContain(
      "if no document.querySelector('details.cf-expand[open]') then location.reload()"
    );
  });
});
