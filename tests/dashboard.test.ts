// tests/dashboard.test.ts
// Public homepage (GET /) — dual-tab shell + CF usage pane.
//
// The security invariant under test: the homepage is PUBLIC but must never
// leak the 32-hex CF account id — the route's SQL joins on it without
// selecting it, and this suite locks that at the HTML level (specific
// seeded ids + a generic 32-hex regex over the whole document).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { DB, reapplySchema, resetDb, seedCfAccount, seedCheck, seedProject, TEST_CF } from './utils';

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
    // Counts anchor on the rendered class ATTRIBUTE ('class="…'), because the
    // page ships its own <style> block where the same names appear as CSS
    // selectors (.cf-warn etc.) and would pollute bare-substring counts.
    expect((html.match(/cf-bar-fill"/g) ?? []).length).toBe(1); // plain fill: attr ends right after the base class
    expect((html.match(/cf-warn"/g) ?? []).length).toBe(1);
    expect((html.match(/cf-danger"/g) ?? []).length).toBe(1);
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
