# Scheduler Hub（排程觸發樞紐）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 watch-dog 升級為排程觸發樞紐（dumb ticker）——受監專案用既有 project token 註冊固定間隔的 HTTPS 回呼，watch-dog 每分鐘 cron tick 到期主動 POST 叫醒對方，1 條既有 cron slot 服務全部專案。

**Architecture:** 單一新深模組 `src/services/scheduler.ts`（due 撈取 → 先推進 `next_run_at` → HMAC 簽名 POST → 記錄結果 → 可選 Slack 警報），新 route 檔 `src/routes/schedules.ts`（專案自助 CRUD），admin 加一個唯讀 GET。scheduled handler 內走獨立 try/catch（比照 usagePoll 先例），不變式① fail-dead 語義零改動。cron `*/5` → `*/1`（頻率不佔額外 slot——上限計條數）。

**Tech Stack:** Hono 4、D1 原生 prepared statements（靜態字面值 + `.bind()`）、Web Crypto HMAC-SHA256、@cloudflare/vitest-plugin（workerd 全保真）+ MSW。

**設計真源:** `docs/plans/2026-10-19-scheduler-hub-design.md`（決策全在那裡，本 plan 只管怎麼蓋）。

---

## 0 — 合規欄位（02-BUILD-SPEC §1 / §1.5 / §2.1 / §2.3）

**tier: major**（新增 load-bearing flow + D1 schema 變更 + >5 檔——§1.5 三條全中，無豁免）

### THINK block（§1，D21）

```
THINK:
1. ROOT CAUSE:     帳號 Workers Free 5-cron 上限已滿（兩次 deploy 10072），20+ 專案搶 slot。
                   再問一層：為何不付費/不加 slot？——Free 上限固定，集中樞紐用 1 條既有
                   slot 服務全部專案才是根解。
2. CORRECT LAYER:  D1（schedules 表，schema 真源 src/db.sql）+ scheduled handler
                   （cron.ts，新模組獨立 try/catch）+ API route（routes/schedules.ts）。
3. AFFECTED FILES: db.sql / cron.ts / index.ts / types.ts / admin.ts / wrangler.jsonc /
                   scheduler.ts(新) / schedules.ts(新) / schedules.test.ts(新) / utils.ts +
                   6 份文件。爆破半徑最大處 = cron handler（不變式①）——緩解：模組放
                   fail-dead 路徑之外、獨立 try/catch、內部 Promise.allSettled 不外拋。
4. ASSUMPTIONS:    (a) */1 不增 slot 佔用（getkm ef457dc42d3a 實證：上限計條數非頻率）；
                   (b) 註冊方 callback 能收 POST+JSON；(c) subrequest 預算 20×2+5=45≤50 夠；
                   (d) cron tick 延遲可接受（dumb ticker，目標端自癒）。最可能錯：(a)——
                   已有兩次事故經驗背書，但部署後仍以 D1 副作用驗證 tick 真的在跑
                   （getkm 95b8fbd3a89f：wrangler tail 看不到 scheduled 事件）。
5. SIMPLER PATH:   併入 ops-control 等既有每分 cron worker？——跨專案耦合、無 token/警報
                   基礎，反而更貴。不簽 HMAC 只帶 token？——省 30 行換安全性降級，不划算。
6. RISK:           cron handler 複雜化動到 fail-dead（緩解如上）；D1 額度（每 tick 1 條
                   SELECT、fire 才寫、LIMIT 20）；被當 open relay（緩解：閉合註冊——
                   project 由 operator 建，token 才發得出去）。Rollback：移除模組 +
                   DROP TABLE schedules，schema 全冪等無遷移負擔。
7. VERDICT:        PROCEED
```

getkm 已查（§1）：`ef457dc42d3a`（cron 額度計條數、schedules API 盤點法）、`95b8fbd3a89f`（cron 觸發以 D1 副作用為 ground truth、tail 陷阱）。已納入。

### User Story + 驗收條件（§2.1，D33）

**Story**（3 C's + INVEST）：
> As a 已註冊於 watch-dog 的專案維護者，I want 向 watch-dog 註冊一個固定間隔的 HTTPS 回呼排程（callback URL + interval，及自選的 retry／連敗警報門檻），so that 我不需要自己擁有 Cloudflare cron slot 也能讓我的服務被定期觸發。

**Acceptance criteria**（皆 testable）：

| # | 條件 |
|---|---|
| AC1 | 專案持 Bearer token 可建立/列出/修改/刪除**自己的** schedule；用自己 token 存取他人 schedule 得 404（無存在性 oracle）；無 token 401、錯 token 403 |
| AC2 | 到期 schedule 在 cron tick 內收到 POST，header 帶 `X-Schedule-Signature: t=<unix>,v1=<hex>`（HMAC-SHA256(secret, `${t}.${schedule_id}.${scheduled_at}`)），body 為 JSON `{schedule_id, scheduled_at, fired_at}`；2xx 記 `last_status='ok'` |
| AC3 | fire **前**推進 `next_run_at = now + interval×60`：失敗目標等滿一週期，同一 tick 內絕不重複、下個 tick 絕不重錘 |
| AC4 | `retry_count=1` 時失敗當場補一次（同簽名同 body）；`alert_after_failures=N>0` 時連敗**跨越** N 發 Slack warning（level=warning）；成功歸零連敗；**任何路徑都不自動暫停** |
| AC5 | admin 持 Basic Auth 可 `GET /admin/schedules` 唯讀總覽（靜態欄位清單、secret 欄永不被 SELECT）；admin 面向零寫入端點 |
| AC6 | 單 tick 最多 20 fires（ORDER BY next_run_at 最逾期優先），超量順延至下個 tick |
| AC7 | 高精度 pattern（註冊 `interval_minutes=1` + 目標端自行節流）與目標端驗簽範例載於 `docs/client-guide.md` 與 README |

### 模組形狀檢查（§2.3 ↔ 14-DESIGN-PRINCIPLES）

- **§0 兩問**：
  - *接口測試*：`runDueSchedules(db, now, scheduledTimeMs)` 的行為可完全由 DB 副作用 + msw 攔截的 callback 觀察，不需內部知識 ✓；`signScheduleHeader` 純函數直接斷言 ✓。
  - *擁有權測試*：schedules 表的寫入只存在於 `scheduler.ts`（cron 路徑）與 `schedules.ts`（API 路徑）；`admin.ts` 僅唯讀 SELECT（遵循本 repo admin 直查各表的既有模式）✓。
- **§2 四條**：HMAC 簽名/編碼**唯一實作**（`hmacSha256Hex`/`toHex` 單一來源，client 文件範例照抄同一 recipe，[NEVER] 第二份實作）；新 route 檔不帶舊參數；route/handler 只留傳輸層（驗證 + json），排程語義全在 service；無共用邏輯複本需盤點（全新表）。
- **新舊債分流**：本 plan 不重構任何既有檔案（admin.ts 只加一個 handler；cron.ts 只加一個隔離區塊）。

### /documentation/ 對照（§2.2，repo 適配版 docs/）

- `docs/api.md`：新端點須補（D16）→ Task 7。
- `docs/client-guide.md`：註冊方指南 + 驗簽範例 → Task 7。
- `docs/testing.md`：D28 Proposed 測試覆蓋段 → Task 7。
- 無新 env var／secret（schedule secret 是 D1 runtime 資料，同 `cf_accounts.api_token` 先例）→ 不動 variables/deployment；`.portability.toml` 不變。

---

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/db.sql` | Modify | +`schedules` 表 + `idx_schedules_due`（冪等） |
| `src/types.ts` | Modify | +`Schedule`、`ScheduleCreatePayload`、`ScheduleUpdatePayload` |
| `src/services/scheduler.ts` | Create | 深模組：簽名純函數 + `runDueSchedules`（唯一排程語義所在） |
| `src/routes/schedules.ts` | Create | 專案自助 CRUD（運輸層薄殼） |
| `src/routes/admin.ts` | Modify | +1 唯讀 `GET /admin/schedules` |
| `src/index.ts` | Modify | mount schedules route |
| `src/cron.ts` | Modify | +獨立 try/catch 區塊 call `runDueSchedules` |
| `wrangler.jsonc` | Modify | crons `*/5` → `*/1` + 註解更正 |
| `tests/utils.ts` | Modify | resetDb +schedules、`seedSchedule`/`getSchedule` |
| `tests/schedules.test.ts` | Create | 全部新行為的測試 |
| README / `docs/api.md` / `docs/client-guide.md` / `docs/testing.md` / `FIX-LOG.md` / `CLAUDE.md` + `AGENTS.md` | Modify | D16/D35/D36 + D19 同步 |

---

### Task 0: 分支 + 開工卡

**Files:** 無 repo 檔（market-ops 看板 + git branch）

- [ ] **Step 0.1: 建分支**

```bash
cd /home/peter/Code/watch-dog && git checkout -b feat/scheduler-hub
```

- [ ] **Step 0.2: 開工卡（market-ops 推卡紀律）**

```bash
# 板已存在（boards/watch-dog/）——用 card-set 建 implementing 卡；流水號=現有最大+1
~/Code/market-ops/tools/kanban/bin/card-set.mjs watch-dog <NEXT_ID> title "Scheduler Hub：dumb ticker 排程觸發樞紐" stage implementing
# 手寫四段式 content【背景】【要做】【現況】【驗收】後跑 card-lint 再 commit（規則見 market-ops README）
node ~/Code/market-ops/tools/kanban/bin/card-lint.mjs
```

（若 `card-set.mjs` 不支援此用法，依 `~/Code/market-ops/tools/kanban/README.md` 手寫卡 JSON：`stage: implementing`、`agent: claude`、resources 帶本 plan 絕對路徑。）

---

### Task 1: Schema + 型別 + 測試 fixtures

**Files:**
- Modify: `src/db.sql`（檔尾 `settings` 區塊之前插入）
- Modify: `src/types.ts`（檔尾附加）
- Modify: `tests/utils.ts`

- [ ] **Step 1.1: db.sql 加表**（放在「Settings Table」註解區塊之前）

```sql
-- ============================================================================
-- Schedules Table (2026-10-19) — scheduler hub
-- ============================================================================
-- Dumb-ticker callback registry (docs/plans/2026-10-19-scheduler-hub-design.md):
-- the hub wakes each target at its registered interval and does NOTHING else
-- (precision/debounce/idempotency live in the target). next_run_at advances
-- BEFORE firing → at-most-once per period; failing targets are never
-- re-hammered. secret is D1 runtime data (cf_accounts.api_token precedent),
-- returned exactly once at creation, never selected by admin queries.
CREATE TABLE IF NOT EXISTS schedules (
    -- Numeric id (also the signature domain — targets bind it in HMAC)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Owning project (closed registration: operator-created, token-authed)
    project_id TEXT NOT NULL,
    -- Human label, unique within the project
    name TEXT NOT NULL,
    -- https:// callback URL the hub POSTs on every fire
    callback_url TEXT NOT NULL,
    -- Fire interval in minutes (1..10080; actual granularity = 1-min tick)
    interval_minutes INTEGER NOT NULL,
    -- Per-schedule HMAC secret (64 hex chars, generated at creation)
    secret TEXT NOT NULL,
    -- Optional immediate retry on failure (0 = off, 1 = one retry) —
    -- registration choice, never hub policy
    retry_count INTEGER NOT NULL DEFAULT 0,
    -- Slack warning when consecutive failures CROSSES this value
    -- (0 = off). No auto-pause exists by design (operator decision).
    alert_after_failures INTEGER NOT NULL DEFAULT 0,
    -- Due-fire bookkeeping: fired when <= now
    next_run_at INTEGER NOT NULL,
    -- Unix ts of last fire attempt (null = never fired)
    last_run_at INTEGER,
    -- 'ok' (2xx ack) | 'fail' (null = never fired)
    last_status TEXT,
    -- Reset to 0 on any ack; incremented on each failure
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    -- Project-side maintenance mute (1 = skip; only the project sets it)
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(project_id, name),
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(paused, next_run_at);
```

- [ ] **Step 1.2: types.ts 加型別**（檔尾附加）

```ts
/**
 * Schedule entity — a registered periodic callback (scheduler hub).
 * Design: docs/plans/2026-10-19-scheduler-hub-design.md (dumb ticker).
 */
export interface Schedule {
  /** Numeric id (signature domain — bound into the HMAC message) */
  id: number;
  /** Owning project id */
  project_id: string;
  /** Human label, unique within the project */
  name: string;
  /** https:// callback URL the hub POSTs on every fire */
  callback_url: string;
  /** Fire interval in minutes (1..10080; granularity = 1-min tick) */
  interval_minutes: number;
  /** Per-schedule HMAC secret — write-only after creation (never in reads) */
  secret: string;
  /** Optional immediate retry on failure (0 = off, 1 = one retry) */
  retry_count: number;
  /** Slack warning when consecutive failures crosses this (0 = off) */
  alert_after_failures: number;
  /** Unix ts of next due fire (fired when <= now) */
  next_run_at: number;
  /** Unix ts of last fire attempt (null = never) */
  last_run_at: number | null;
  /** 'ok' (2xx ack) | 'fail' (null = never) */
  last_status: 'ok' | 'fail' | null;
  /** Consecutive failures (reset on any ack) */
  consecutive_failures: number;
  /** Project-side maintenance mute (1 = skip) */
  paused: number;
  /** Unix ts of creation */
  created_at: number;
}

/** Payload for POST /api/schedules */
export interface ScheduleCreatePayload {
  project_id: string;
  name: string;
  callback_url: string;
  /** Default 60 */
  interval_minutes?: number;
  /** 0 | 1, default 0 */
  retry_count?: number;
  /** Default 0 = off */
  alert_after_failures?: number;
}

/** Payload for PUT /api/schedules/:id (all fields optional) */
export interface ScheduleUpdatePayload {
  name?: string;
  callback_url?: string;
  interval_minutes?: number;
  retry_count?: number;
  alert_after_failures?: number;
  paused?: 0 | 1;
}
```

- [ ] **Step 1.3: tests/utils.ts** — `resetDb` 的 batch 加一行 `DB.prepare('DELETE FROM schedules'),`（放在 `DELETE FROM cf_resource_names` 之後）；import 型別行加 `Schedule`；檔尾（CF fixtures 區塊前）加：

```ts
// ============================================================================
// Scheduler hub fixtures
// ============================================================================

export async function seedSchedule(projectId: string, overrides: Partial<Schedule> = {}): Promise<Schedule> {
  const s: Schedule = {
    id: 101,
    project_id: projectId,
    name: 'tick',
    callback_url: 'https://cb.test.local/tick',
    interval_minutes: 60,
    secret: 'sch-secret-0123456789abcdef0123456789abcdef',
    retry_count: 0,
    alert_after_failures: 0,
    next_run_at: 0, // due immediately by default
    last_run_at: null,
    last_status: null,
    consecutive_failures: 0,
    paused: 0,
    created_at: nowSec(),
    ...overrides,
  };
  await DB.prepare(`
    INSERT INTO schedules (
      id, project_id, name, callback_url, interval_minutes, secret,
      retry_count, alert_after_failures, next_run_at, last_run_at, last_status,
      consecutive_failures, paused, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      s.id, s.project_id, s.name, s.callback_url, s.interval_minutes, s.secret,
      s.retry_count, s.alert_after_failures, s.next_run_at, s.last_run_at, s.last_status,
      s.consecutive_failures, s.paused, s.created_at
    )
    .run();
  return s;
}

export async function getSchedule(id: number): Promise<Schedule | null> {
  return DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first<Schedule>();
}
```

- [ ] **Step 1.4: 跑既有測試確認 schema 無破壞**

Run: `npm run test:app -- tests/utils.test.ts tests/api.test.ts 2>&1 | tail -5`
Expected: PASS（utils 沒有獨立測試檔也無妨——跑 api.test.ts 即可，beforeEach 的 resetDb 會套用新 schema；若任何 FAIL → STOP 修復）

- [ ] **Step 1.5: Commit**

```bash
git add src/db.sql src/types.ts tests/utils.ts
git commit -m "feat(scheduler): schedules schema + types + test fixtures" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 簽名純函數（TDD）

**Files:**
- Create: `src/services/scheduler.ts`
- Create: `tests/schedules.test.ts`

- [ ] **Step 2.1: 寫失敗測試** — 建 `tests/schedules.test.ts`：

```ts
// tests/schedules.test.ts
// Scheduler hub: signature pure functions, due-fire engine, registration API,
// admin read-only view, cron wiring.

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { hmacSha256Hex, signScheduleHeader } from '../src/services/scheduler';
import { network } from './network';
import { DB, getSchedule, resetDb, seedProject, seedSchedule, setSlackSettings } from './utils';

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
```

- [ ] **Step 2.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -8`
Expected: FAIL — `Cannot find module '../src/services/scheduler'`（或對應 import 錯誤）

- [ ] **Step 2.3: 最小實作** — 建 `src/services/scheduler.ts`：

```ts
// src/services/scheduler.ts
// Scheduler hub (dumb ticker): fires registered callbacks on their interval.
//
// Design contract (docs/plans/2026-10-19-scheduler-hub-design.md):
// - The hub is deliberately dumb: it wakes targets at their registered
//   interval and nothing else. Precision control, debouncing, idempotency
//   and missed-tick self-healing all live in the TARGET (register
//   interval_minutes=1 and self-throttle for high precision).
// - next_run_at is advanced BEFORE firing (at-most-once per period): a
//   failing target waits a full period, never gets re-hammered each tick.
// - No auto-pause (operator decision 2026-10-19): a paused job is a silent
//   failure. Failures are made visible (last_status/consecutive_failures
//   + optional Slack warning), not acted on.
// - Subrequest budget: <=20 fires x (1+retry) + <=5 alerts = <=45 external
//   fetches per tick (Free plan cap: 50/invocation).

import type { D1Database } from '@cloudflare/workers-types';
import type { Schedule } from '../types';
import { sendSlackAlert } from './alert';

/** Max callbacks fired per tick (subrequest budget, see header). */
const FIRE_BATCH_LIMIT = 20;
/** Max schedule-failure Slack alerts per tick (subrequest budget). */
const ALERT_BATCH_LIMIT = 5;
/** Per-attempt callback timeout (ms). */
const FETCH_TIMEOUT_MS = 10_000;

/** Hex-encode helper — single implementation shared by signing and
 *  secret generation (14-DESIGN-PRINCIPLES §2 rule 1: no second copy). */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256(secret, message) as lowercase hex (Web Crypto only). */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * Build the callback signature header: `t=<firedAt>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${firedAt}.${scheduleId}.${scheduledAt}`).
 *
 * Targets verify with the same recipe (docs/client-guide.md) and reject
 * timestamps outside a freshness window (replay defense).
 */
export async function signScheduleHeader(
  secret: string,
  scheduleId: number,
  scheduledAt: number,
  firedAt: number
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${firedAt}.${scheduleId}.${scheduledAt}`);
  return `t=${firedAt},v1=${v1}`;
}
```

- [ ] **Step 2.4: 跑測試確認通過**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -5`
Expected: PASS（3 tests）

- [ ] **Step 2.5: Commit**

```bash
git add src/services/scheduler.ts tests/schedules.test.ts
git commit -m "feat(scheduler): HMAC signature pure functions" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `runDueSchedules` 引擎（TDD）

**Files:**
- Modify: `src/services/scheduler.ts`（附加）
- Modify: `tests/schedules.test.ts`（附加）

- [ ] **Step 3.1: 寫失敗測試** — `tests/schedules.test.ts` 附加（import 區補 `runDueSchedules`）：

```ts
import { hmacSha256Hex, runDueSchedules, signScheduleHeader } from '../src/services/scheduler';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Direct engine invocation (service-level; wiring covered in Task 6). */
async function runEngine(): Promise<void> {
  await runDueSchedules(DB, nowSec(), Date.now());
}

describe('runDueSchedules', () => {
  let hits: Array<{ url: string; body: string; sig: string }>;

  beforeEach(() => {
    hits = [];
    network.use(
      http.post('https://cb.test.local/*', async ({ request }) => {
        hits.push({
          url: new URL(request.url).pathname,
          body: await request.text(),
          sig: request.headers.get('X-Schedule-Signature') ?? '',
        });
        return HttpResponse.json({ ok: true });
      })
    );
  });

  it('fires a due schedule with signed POST and advances next_run_at (AC2/AC3)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    const s = await seedSchedule('svc');
    const before = nowSec();

    await runEngine();

    expect(hits).toHaveLength(1);
    expect(hits[0].sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const payload = JSON.parse(hits[0].body);
    expect(payload.schedule_id).toBe(s.id);
    expect(payload.scheduled_at).toBeGreaterThan(0);
    expect(payload.fired_at).toBeGreaterThanOrEqual(payload.scheduled_at);

    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('ok');
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.next_run_at).toBeGreaterThanOrEqual(before + 60 * 60);
    expect(row?.next_run_at).toBeLessThanOrEqual(nowSec() + 60 * 60);
  });

  it('skips not-due and paused schedules (AC2/AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    await seedSchedule('svc', { id: 1, name: 'future', next_run_at: nowSec() + 3600 });
    await seedSchedule('svc', { id: 2, name: 'paused', paused: 1 });

    await runEngine();

    expect(hits).toHaveLength(0);
  });

  it('records failure, does NOT re-hammer on the next tick (AC3)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 }))
    );
    const s = await seedSchedule('svc');

    await runEngine();
    await runEngine(); // next minute — must not fire again

    expect(hits).toHaveLength(0); // 500 handler replaced the recorder above
    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('fail');
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.next_run_at).toBeGreaterThan(nowSec());
  });

  it('retries once in-tick when retry_count=1 (AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let calls = 0;
    network.use(
      http.post('https://cb.test.local/*', () => {
        calls++;
        return calls === 1 ? new HttpResponse('boom', { status: 500 }) : HttpResponse.json({ ok: true });
      })
    );
    const s = await seedSchedule('svc', { retry_count: 1 });

    await runEngine();

    expect(calls).toBe(2);
    const row = await getSchedule(s.id);
    expect(row?.last_status).toBe('ok');
    expect(row?.consecutive_failures).toBe(0);
  });

  it('alerts on crossing alert_after_failures, resets on success (AC4)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    const slackBodies: string[] = [];
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 })),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        slackBodies.push(await request.text());
        return HttpResponse.json({ ok: true });
      })
    );
    const s = await seedSchedule('svc', {
      alert_after_failures: 2,
      consecutive_failures: 1, // this failure crosses 2
    });

    await runEngine();

    expect(slackBodies).toHaveLength(1);
    expect(slackBodies[0]).toContain('C_WARNING');
    expect(slackBodies[0]).toContain('tick');
  });

  it('never alerts when alert_after_failures=0 (AC4 default)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    let slackHits = 0;
    network.use(
      http.post('https://cb.test.local/*', () => new HttpResponse('boom', { status: 500 })),
      http.post('https://slack.com/api/chat.postMessage', () => {
        slackHits++;
        return HttpResponse.json({ ok: true });
      })
    );
    await seedSchedule('svc', { consecutive_failures: 5 });

    await runEngine();

    expect(slackHits).toBe(0);
  });

  it('caps fires at 20 per tick, most-overdue first (AC6)', async () => {
    await seedProject({ id: 'svc', token: 'tok-1234567890' });
    for (let i = 1; i <= 25; i++) {
      await seedSchedule('svc', {
        id: i,
        name: `job-${String(i).padStart(2, '0')}`,
        callback_url: `https://cb.test.local/job-${i}`,
        next_run_at: i, // ascending: job-1 most overdue
      });
    }

    await runEngine();

    expect(hits).toHaveLength(20);
    expect(hits.map((h) => h.url)).toContain('/job-1');
    expect(hits.map((h) => h.url)).not.toContain('/job-25');
    // leftovers stay due for the next tick
    expect((await getSchedule(25))?.next_run_at).toBe(25);
  });
});
```

- [ ] **Step 3.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -8`
Expected: FAIL — `runDueSchedules` 未 export（type error / undefined）

- [ ] **Step 3.3: 實作引擎** — `scheduler.ts` 附加（`signScheduleHeader` 之後）：

```ts
/** One callback delivery. Returns true on 2xx ack. */
async function fireSchedule(s: Schedule, scheduledAt: number): Promise<boolean> {
  const firedAt = Math.floor(Date.now() / 1000);
  const signature = await signScheduleHeader(s.secret, s.id, scheduledAt, firedAt);
  const body = JSON.stringify({ schedule_id: s.id, scheduled_at: scheduledAt, fired_at: firedAt });

  const attempt = (): Promise<Response> =>
    fetch(s.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Schedule-Signature': signature },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  let ok = false;
  try {
    const res = await attempt();
    void res.body?.cancel();
    ok = res.ok;
  } catch {
    ok = false;
  }
  // Optional single retry — registration choice, never hub policy.
  if (!ok && s.retry_count === 1) {
    try {
      const res = await attempt();
      void res.body?.cancel();
      ok = res.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * Fire every due schedule (paused = 0 AND next_run_at <= now), at most
 * FIRE_BATCH_LIMIT per tick; leftovers fire on the next tick (late but
 * not lost — ORDER BY next_run_at serves the most overdue first).
 *
 * Never throws (Promise.allSettled + per-alert error logging): a scheduler
 * bug must not compromise the fail-dead path — cron.ts additionally wraps
 * the call in its own try/catch (invariant ①, belt and suspenders).
 */
export async function runDueSchedules(
  db: D1Database,
  now: number,
  scheduledTimeMs: number
): Promise<void> {
  const scheduledAt = Math.floor(scheduledTimeMs / 1000);
  const due = await db
    .prepare('SELECT * FROM schedules WHERE paused = 0 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?')
    .bind(now, FIRE_BATCH_LIMIT)
    .all<Schedule>();
  if (due.results.length === 0) return;

  const alertTargets: Schedule[] = [];
  await Promise.allSettled(
    due.results.map(async (s) => {
      // Advance BEFORE firing: at-most-once per period. If the isolate dies
      // mid-fire the job waits a full period instead of being retried
      // every minute.
      await db
        .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
        .bind(now + s.interval_minutes * 60, s.id)
        .run();

      const ok = await fireSchedule(s, scheduledAt);
      const failures = ok ? 0 : s.consecutive_failures + 1;
      await db
        .prepare('UPDATE schedules SET last_run_at = ?, last_status = ?, consecutive_failures = ? WHERE id = ?')
        .bind(now, ok ? 'ok' : 'fail', failures, s.id)
        .run();

      // Crossing alert (alert_after_failures = 0 = off). Exact-equality
      // fires once per crossing; flapping re-crossings re-alert by design
      // (visible, never silent).
      if (!ok && s.alert_after_failures > 0 && failures === s.alert_after_failures) {
        alertTargets.push({ ...s, consecutive_failures: failures });
      }
    })
  );

  if (alertTargets.length === 0) return;
  // Resolve project display names for the alert text (small table, one read).
  const projects = await db.prepare('SELECT id, display_name FROM projects').all<{
    id: string;
    display_name: string;
  }>();
  const nameById = new Map(projects.results.map((p) => [p.id, p.display_name]));
  for (const s of alertTargets.slice(0, ALERT_BATCH_LIMIT)) {
    const result = await sendSlackAlert(db, {
      checkId: `schedule:${s.id}`,
      projectName: nameById.get(s.project_id) ?? s.project_id,
      checkName: s.name,
      level: 'warning',
      title: '排程回呼連續失敗',
      message: `${s.name} 已連續失敗 ${s.consecutive_failures} 次（門檻 ${s.alert_after_failures}），目標未回 2xx。`,
      metadata: {
        schedule_id: s.id,
        interval_minutes: s.interval_minutes,
        consecutive_failures: s.consecutive_failures,
      },
    });
    if (!result.ok) {
      console.error(`[scheduler] alert send failed for schedule ${s.id}: ${result.error}`);
    }
  }
}
```

- [ ] **Step 3.4: 跑測試確認通過**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -5`
Expected: PASS（sign 3 + engine 7 = 10 tests）

- [ ] **Step 3.5: Commit**

```bash
git add src/services/scheduler.ts tests/schedules.test.ts
git commit -m "feat(scheduler): due-fire engine (advance-first, optional retry, crossing alerts)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 註冊 API（TDD）

**Files:**
- Create: `src/routes/schedules.ts`
- Modify: `src/index.ts`（mount）
- Modify: `tests/schedules.test.ts`（附加）

- [ ] **Step 4.1: 寫失敗測試** — `tests/schedules.test.ts` 附加（檔頭 import 補 `SELF` from 'cloudflare:test'）：

```ts
import { SELF } from 'cloudflare:test';

const TOKEN = 'tok-1234567890';
const auth = { Authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { 'Content-Type': 'application/json' };

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'POST',
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });
const get = (url: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, { headers });
const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, {
    method: 'PUT',
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });
const del = (url: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${url}`, { method: 'DELETE', headers });

describe('POST /api/schedules (AC1)', () => {
  it('rejects missing token (401), bad token (403), unknown project (404)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const body = { project_id: 'svc', name: 'tick', callback_url: 'https://cb.test.local/x' };
    expect((await post('/api/schedules', body)).status).toBe(401);
    expect((await post('/api/schedules', body, { Authorization: 'Bearer wrong' })).status).toBe(403);
    expect(
      (await post('/api/schedules', { ...body, project_id: 'nope' }, auth)).status
    ).toBe(404);
  });

  it('validates name, url, interval (400)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const base = { project_id: 'svc', callback_url: 'https://cb.test.local/x' };
    expect((await post('/api/schedules', { ...base, name: '' }, auth)).status).toBe(400);
    expect((await post('/api/schedules', { ...base, name: 'ok', callback_url: 'http://insecure' }, auth)).status).toBe(400);
    expect((await post('/api/schedules', { ...base, name: 'ok', interval_minutes: 'abc' }, auth)).status).toBe(400);
  });

  it('creates a schedule, returns the secret exactly once, first fire one interval out (AC2)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const before = nowSec();

    const res = await post(
      '/api/schedules',
      { project_id: 'svc', name: 'hourly', callback_url: 'https://cb.test.local/x', interval_minutes: 60 },
      auth
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ schedule: { id: number; secret: string; next_run_at: number } }>();
    expect(data.schedule.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(data.schedule.next_run_at).toBeGreaterThanOrEqual(before + 3600);

    const row = await getSchedule(data.schedule.id);
    expect(row?.name).toBe('hourly');
    // list view NEVER carries the secret
    const listRes = await get('/api/schedules?project_id=svc', auth);
    const list = await listRes.json<{ schedules: Array<{ secret?: string }> }>();
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0].secret).toBeUndefined();
  });

  it('rejects duplicate name within a project (409)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { name: 'hourly' });
    const res = await post(
      '/api/schedules',
      { project_id: 'svc', name: 'hourly', callback_url: 'https://cb.test.local/x' },
      auth
    );
    expect(res.status).toBe(409);
  });
});

describe('ownership (AC1: no cross-project oracle)', () => {
  it('hides another project schedule behind 404 and lists only own rows', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedProject({ id: 'other', token: 'other-token-1234567890' });
    const s = await seedSchedule('other');

    expect((await get(`/api/schedules/${s.id}?project_id=svc`, auth)).status).toBe(404);
    expect((await put(`/api/schedules/${s.id}?project_id=svc`, { interval_minutes: 5 }, auth)).status).toBe(404);
    expect((await del(`/api/schedules/${s.id}?project_id=svc`, auth)).status).toBe(404);

    const list = await (await get('/api/schedules?project_id=svc', auth)).json<{ schedules: unknown[] }>();
    expect(list.schedules).toHaveLength(0);
  });
});

describe('PUT /api/schedules/:id (AC1/AC4)', () => {
  it('updates fields; interval change does NOT recompute next_run_at', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { next_run_at: 12345 });

    const res = await put('/api/schedules/101?project_id=svc', { interval_minutes: 5, paused: 1 }, auth);
    expect(res.status).toBe(200);
    const row = await getSchedule(101);
    expect(row?.interval_minutes).toBe(5);
    expect(row?.paused).toBe(1);
    expect(row?.next_run_at).toBe(12345); // untouched by design
  });

  it('rejects invalid name (400) and rename collisions (409)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { id: 101, name: 'a' });
    await seedSchedule('svc', { id: 102, name: 'b' });

    expect((await put('/api/schedules/101?project_id=svc', { name: 'bad name!' }, auth)).status).toBe(400);
    expect((await put('/api/schedules/101?project_id=svc', { name: 'b' }, auth)).status).toBe(409);
  });
});

describe('DELETE /api/schedules/:id (AC1)', () => {
  it('removes the schedule', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc');
    expect((await del('/api/schedules/101?project_id=svc', auth)).status).toBe(200);
    expect(await getSchedule(101)).toBeNull();
  });
});
```

- [ ] **Step 4.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -8`
Expected: FAIL — POST `/api/schedules` 回 404（route 未掛）

- [ ] **Step 4.3: 實作 route** — 建 `src/routes/schedules.ts`：

```ts
// src/routes/schedules.ts
// Scheduler-hub registration API: projects manage their own callback
// schedules with their existing project token (Bearer). Admin observes
// read-only via GET /admin/schedules — there is deliberately NO admin
// write path (operator decision 2026-10-19).
//
// Design: docs/plans/2026-10-19-scheduler-hub-design.md (dumb ticker).

import { Hono, type Context } from 'hono';
import type { AppBindings, Schedule, ScheduleCreatePayload, ScheduleUpdatePayload } from '../types';
import { authenticateProject } from '../lib/auth';
import { clampInt, isValidCheckName } from '../lib/validate';
import { toHex } from '../services/scheduler';

const schedules = new Hono<{ Bindings: AppBindings }>();

/** Everything except the secret — the response shape for all reads. */
function publicSchedule(s: Schedule): Omit<Schedule, 'secret'> {
  const { secret: _secret, ...rest } = s;
  return rest;
}

/** 32 random bytes as hex — same entropy class as the project tokens. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** https-only, bounded length — the hub POSTs this URL on every fire. */
function isValidCallbackUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://') && url.length <= 500;
}

/**
 * Load the :id schedule and verify the caller owns it: authenticate the
 * project named by ?project_id=, then require schedule.project_id match.
 * Mismatch → 404 (no existence oracle across projects).
 */
async function loadOwnedSchedule(
  c: Context<{ Bindings: AppBindings }>
): Promise<{ schedule: Schedule } | Response> {
  const projectId = c.req.query('project_id');
  if (!projectId) {
    return c.json({ error: 'Missing required query: project_id' }, 400);
  }
  const auth = await authenticateProject(c, projectId);
  if (auth instanceof Response) return auth;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid schedule id' }, 400);
  }
  const schedule = await c.env.DB
    .prepare('SELECT * FROM schedules WHERE id = ?')
    .bind(id)
    .first<Schedule>();
  if (!schedule || schedule.project_id !== projectId) {
    return c.json({ error: 'Schedule not found' }, 404);
  }
  return { schedule };
}

/**
 * POST /api/schedules — register a callback schedule.
 * The per-schedule secret is returned EXACTLY ONCE, here.
 */
schedules.post('/api/schedules', async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  let body: ScheduleCreatePayload;
  try {
    body = await c.req.json<ScheduleCreatePayload>();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { project_id, name, callback_url } = body;
  if (!project_id || !name || !callback_url) {
    return c.json({ error: 'Missing required fields: project_id, name, callback_url' }, 400);
  }
  const auth = await authenticateProject(c, project_id);
  if (auth instanceof Response) return auth;

  if (!isValidCheckName(name)) {
    return c.json(
      { error: 'Invalid name: use 1-64 chars of letters, digits, _ or - (alphanumeric first)' },
      400
    );
  }
  if (!isValidCallbackUrl(callback_url)) {
    return c.json({ error: 'Invalid callback_url: must be an https:// URL of at most 500 chars' }, 400);
  }
  // Non-numeric interval would clamp to the fallback and silently register
  // a wrong cadence — reject instead of guessing (fail loud).
  if (body.interval_minutes !== undefined && !Number.isFinite(Number(body.interval_minutes))) {
    return c.json({ error: 'interval_minutes must be a number' }, 400);
  }

  const clash = await db
    .prepare('SELECT id FROM schedules WHERE project_id = ? AND name = ?')
    .bind(project_id, name)
    .first();
  if (clash) {
    return c.json({ error: 'Schedule name already exists for this project' }, 409);
  }

  const interval = clampInt(body.interval_minutes ?? 60, 1, 10080);
  const retry = clampInt(body.retry_count ?? 0, 0, 1);
  const alertAfter = clampInt(body.alert_after_failures ?? 0, 0, 100);
  const secret = generateSecret();

  const result = await db
    .prepare(
      `INSERT INTO schedules (
        project_id, name, callback_url, interval_minutes, secret,
        retry_count, alert_after_failures, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(project_id, name, callback_url, interval, secret, retry, alertAfter, now + interval * 60)
    .run();
  const id = result.meta.last_row_id;

  const row = await db.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first<Schedule>();
  return c.json({ success: true, schedule: row ? { ...publicSchedule(row), secret } : null });
});

/** GET /api/schedules?project_id=... — list the caller's own schedules. */
schedules.get('/api/schedules', async (c) => {
  const projectId = c.req.query('project_id');
  if (!projectId) {
    return c.json({ error: 'Missing required query: project_id' }, 400);
  }
  const auth = await authenticateProject(c, projectId);
  if (auth instanceof Response) return auth;

  const rows = await c.env.DB
    .prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY name')
    .bind(projectId)
    .all<Schedule>();
  return c.json({ schedules: rows.results.map(publicSchedule) });
});

/** GET /api/schedules/:id?project_id=... */
schedules.get('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  return c.json({ schedule: publicSchedule(owned.schedule) });
});

/**
 * PUT /api/schedules/:id?project_id=... — update own schedule.
 * Changing interval does NOT recompute next_run_at: the new cadence applies
 * from the next advance (documented in docs/api.md).
 */
schedules.put('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  const { schedule } = owned;
  const db = c.env.DB;

  let body: ScheduleUpdatePayload;
  try {
    body = await c.req.json<ScheduleUpdatePayload>();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const name = body.name === undefined ? null : isValidCheckName(body.name) ? body.name : null;
  if (body.name !== undefined && name === null) {
    return c.json({ error: 'Invalid name' }, 400);
  }
  const url =
    body.callback_url === undefined ? null : isValidCallbackUrl(body.callback_url) ? body.callback_url : null;
  if (body.callback_url !== undefined && url === null) {
    return c.json({ error: 'Invalid callback_url' }, 400);
  }
  if (name !== null && name !== schedule.name) {
    const clash = await db
      .prepare('SELECT id FROM schedules WHERE project_id = ? AND name = ?')
      .bind(schedule.project_id, name)
      .first();
    if (clash) {
      return c.json({ error: 'Schedule name already exists for this project' }, 409);
    }
  }

  const interval =
    body.interval_minutes === undefined ? null : clampInt(body.interval_minutes, 1, 10080);
  const retry = body.retry_count === undefined ? null : clampInt(body.retry_count, 0, 1);
  const alertAfter =
    body.alert_after_failures === undefined ? null : clampInt(body.alert_after_failures, 0, 100);
  const paused = body.paused === 0 || body.paused === 1 ? body.paused : null;

  await db
    .prepare(
      `UPDATE schedules SET
        name = COALESCE(?, name),
        callback_url = COALESCE(?, callback_url),
        interval_minutes = COALESCE(?, interval_minutes),
        retry_count = COALESCE(?, retry_count),
        alert_after_failures = COALESCE(?, alert_after_failures),
        paused = COALESCE(?, paused)
      WHERE id = ?`
    )
    .bind(name, url, interval, retry, alertAfter, paused, schedule.id)
    .run();

  const row = await db.prepare('SELECT * FROM schedules WHERE id = ?').bind(schedule.id).first<Schedule>();
  return c.json({ success: true, schedule: row ? publicSchedule(row) : null });
});

/** DELETE /api/schedules/:id?project_id=... */
schedules.delete('/api/schedules/:id', async (c) => {
  const owned = await loadOwnedSchedule(c);
  if (owned instanceof Response) return owned;
  await c.env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(owned.schedule.id).run();
  return c.json({ success: true, deleted: owned.schedule.id });
});

export default schedules;
```

- [ ] **Step 4.4: index.ts mount** — import 區加 `import schedulesRoutes from './routes/schedules';`，`app.route('/', adminRoutes);` 之後加 `app.route('/', schedulesRoutes);`

- [ ] **Step 4.5: 跑測試確認通過**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -5`
Expected: PASS（10 + 10 = 20 tests）

- [ ] **Step 4.6: Commit**

```bash
git add src/routes/schedules.ts src/index.ts tests/schedules.test.ts
git commit -m "feat(scheduler): self-service registration API (project-token scoped)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Admin 唯讀總覽（TDD）

**Files:**
- Modify: `src/routes/admin.ts`（+1 handler）
- Modify: `tests/schedules.test.ts`（附加）

- [ ] **Step 5.1: 寫失敗測試** — 附加：

```ts
describe('GET /admin/schedules (AC5: read-only, secret never leaves)', () => {
  it('requires Basic Auth and returns every schedule WITHOUT the secret', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedSchedule('svc', { secret: 'top-secret-value-never-echo' });

    expect((await get('/admin/schedules')).status).toBe(401);

    const basic = 'Basic ' + btoa('test-admin:test-admin-token');
    const res = await get('/admin/schedules', { Authorization: basic });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('top-secret-value-never-echo');
    const data = JSON.parse(text) as { schedules: Array<{ id: number; project_id: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.schedules[0].project_id).toBe('svc');
  });
});
```

（`test-admin`/`test-admin-token` = `vitest.config.ts` miniflare bindings 的 ADMIN_ 測試對——既有字面同步模式。）

- [ ] **Step 5.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -8`
Expected: FAIL — 404（route 不存在）

- [ ] **Step 5.3: 實作** — `admin.ts`：type import 行補 `Schedule`，檔尾 `export default admin;` 前加：

```ts
/**
 * GET /admin/schedules — scheduler-hub overview. READ-ONLY by design
 * (operator decision 2026-10-19): there is intentionally no admin write
 * path for schedules. The secret column is never selected.
 */
admin.get('/admin/schedules', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT id, project_id, name, callback_url, interval_minutes, retry_count,
              alert_after_failures, next_run_at, last_run_at, last_status,
              consecutive_failures, paused, created_at
       FROM schedules ORDER BY project_id, name`
    )
    .all<Omit<Schedule, 'secret'>>();
  return c.json({ schedules: rows.results, count: rows.results.length });
});
```

- [ ] **Step 5.4: 跑測試確認通過**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -5`
Expected: PASS（21 tests）

- [ ] **Step 5.5: Commit**

```bash
git add src/routes/admin.ts tests/schedules.test.ts
git commit -m "feat(scheduler): admin read-only overview endpoint" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Cron 接線 + tick 放回每分鐘（TDD）

**Files:**
- Modify: `src/cron.ts`
- Modify: `wrangler.jsonc`
- Modify: `tests/schedules.test.ts`（附加 wiring 測試）

- [ ] **Step 6.1: 寫失敗測試** — 附加（import 補 `worker` from '../src/index'、`seedCheck`、`useRestNameDefaults`）：

```ts
import worker from '../src/index';
import { seedCheck, useRestNameDefaults } from './utils';

/** Dispatch the worker's scheduled handler the way the cron trigger would. */
async function runScheduledTick(): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve();
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => undefined } as never,
    { DB } as never,
    {
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
      passThroughOnException: () => undefined,
      props: {},
    } as never
  );
  await pending;
}

describe('cron wiring (invariant ①: fail-dead unaffected)', () => {
  let hits: number;

  beforeEach(() => {
    hits = 0;
    useRestNameDefaults(); // keep any incidental REST fetch off the real network
    network.use(
      http.post('https://cb.test.local/*', () => {
        hits++;
        return HttpResponse.json({ ok: true });
      })
    );
  });

  it('scheduled handler fires due schedules end-to-end', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    const s = await seedSchedule('svc');

    await runScheduledTick();

    expect(hits).toBe(1);
    expect((await getSchedule(s.id))?.last_status).toBe('ok');
  });

  it('scheduler failure does not break dead-check detection (AC: invariant ①)', async () => {
    await seedProject({ id: 'svc', token: TOKEN });
    await seedCheck('svc', { id: 'svc:stale', name: 'stale', last_seen: nowSec() - 3600 });
    // Dead callback URL: fetch fails (DNS), engine records fail, must not throw.
    await seedSchedule('svc', { callback_url: 'https://no-such-host.invalid/x' });

    await runScheduledTick();

    const stale = await DB.prepare("SELECT status FROM checks WHERE id = 'svc:stale'").first<{ status: string }>();
    expect(stale?.status).toBe('dead');
    expect((await getSchedule(101))?.last_status).toBe('fail');
  });
});
```

- [ ] **Step 6.2: 跑測試確認失敗**

Run: `npm run test:app -- tests/schedules.test.ts 2>&1 | tail -8`
Expected: 第一個 wiring test FAIL — `hits` 為 0（cron 未接線）

- [ ] **Step 6.3: cron.ts 接線** — import 區加 `import { runDueSchedules } from './services/scheduler';`；`if (usagePollDue) {...}` 區塊**之後**（同一個 waitUntil IIFE 內、IIFE 結尾前）加：

```ts
      // ===== Scheduler hub: fire due schedule callbacks =====
      // Same isolation class as the usage poll above — its own try/catch,
      // deliberately AFTER the fail-dead path (invariant ①: a scheduler
      // bug must never compromise dead-service detection). runDueSchedules
      // itself never throws; this is belt and suspenders.
      try {
        await runDueSchedules(env.DB, now, event.scheduledTime);
      } catch (e) {
        console.error('Scheduler hub error:', e);
      }
```

- [ ] **Step 6.4: wrangler.jsonc tick 放回每分鐘** — crons 改 `["*/1 * * * *"]`，註解整段換成：

```jsonc
	// Cron trigger: dead-service scan + scheduler hub, every minute.
	// 2026-10-19 從 */5 放回 */1：scheduler hub（dumb ticker）需要 1 分鐘粒度，
	// 且頻率不影響 slot 佔用——Free 5-cron 上限計的是「條數」不是頻率
	// （getkm ef457dc42d3a 實證；2026-09-23 的「放寬讓 slot」是誤判）。
	// cleanup/usagePoll 取模錨點不受影響；偵測延遲順便縮回 1 分鐘。
	"triggers": {
		"crons": ["*/1 * * * *"]
	},
```

（同時把 `src/cron.ts` 檔頭註解 `runs every minute` 保留原樣即可——本來就寫 every minute。）

- [ ] **Step 6.5: 跑全部測試確認通過（含既有 cron.test.ts 無回歸）**

Run: `npm run test:app 2>&1 | tail -5`
Expected: PASS（既有全部 + 新 23 tests）

- [ ] **Step 6.6: Commit**

```bash
git add src/cron.ts wrangler.jsonc tests/schedules.test.ts
git commit -m "feat(scheduler): wire into scheduled handler; tick back to every minute" -m "Cron trigger count is per-account schedules, not frequency (getkm ef457dc42d3a) — */1 costs no extra slot. Scheduler runs in its own try/catch after the fail-dead path (invariant ①)." -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 文件同步（D16 / D35 / D36 / D19）

**Files:**
- Modify: `README.md`、`docs/api.md`、`docs/client-guide.md`、`docs/testing.md`、`FIX-LOG.md`、`CLAUDE.md`、`AGENTS.md`

- [ ] **Step 7.1: README.md** — 「客戶端接入」清單加第 5 項（在第 4 項 Email 段之後）：

```markdown
### 5. （可選）註冊排程觸發——讓 watch-dog 定時叫醒你的服務

不需要自己的 Cloudflare cron slot：註冊一個固定間隔的 HTTPS 回呼，watch-dog 每分鐘
tick 到期就 POST 叫醒你（帶 HMAC 簽名，防偽造/重放）。hub 是 dumb ticker——精度控制、
debounce、冪等都在你端：要高精度就註冊 `interval_minutes: 1` 自己節流。

```bash
# 註冊（secret 只回傳這一次，請立即保存）
curl -X POST https://watch-dog.<your-domain>/api/schedules \
  -H "Authorization: Bearer <PROJECT_TOKEN>" -H "Content-Type: application/json" \
  -d '{"project_id":"my-service","name":"hourly-job","callback_url":"https://my-service.example.com/hooks/tick","interval_minutes":60,"retry_count":1,"alert_after_failures":3}'
# 列出 / 修改 / 刪除（?project_id= 一律必帶）
curl -H "Authorization: Bearer <PROJECT_TOKEN>" "https://watch-dog.<your-domain>/api/schedules?project_id=my-service"
```

完整契約（驗簽範例、失敗語義、高精度 pattern）見 `docs/client-guide.md`。
```

README「API Endpoints」表加五行：`POST/GET /api/schedules`、`GET/PUT/DELETE /api/schedules/:id?project_id=`、`GET /admin/schedules`（admin 唯讀）。

- [ ] **Step 7.2: docs/api.md** — 檔尾加「## Scheduler Hub API」章節：逐端點參數/回應/錯誤碼（401/403/404/409/400）、欄位表（`interval_minutes` 1–10080 預設 60、`retry_count` 0|1、`alert_after_failures` 預設 0=off、`paused` 0|1）、語義註記三條：(1) secret 建立時回傳一次；(2) PUT 改 interval 不重算 `next_run_at`（下次推進才生效）；(3) fire 前推進——at-most-once per period、無自動暫停。

- [ ] **Step 7.3: docs/client-guide.md** — 檔尾加「## 接收排程觸發（scheduler hub）」：

```markdown
## 接收排程觸發（scheduler hub）

watch-dog 到期會對你的 callback_url 發：

- Method: `POST`，`Content-Type: application/json`
- Header: `X-Schedule-Signature: t=<fired_at>,v1=<hex>`，其中
  `v1 = HMAC-SHA256(secret, "<fired_at>.<schedule_id>.<scheduled_at>")`
- Body: `{"schedule_id": 7, "scheduled_at": 1760000000, "fired_at": 1760000001}`

回 `2xx` 即 ack；其他（或 10s timeout）記一次失敗。**fire 前已推進下週期**——失敗等
滿一個 interval 才會再試，你不會被重錘；註冊時 `retry_count: 1` 可加一次當場重試。

### 驗簽（防偽造/重放，務必做）

```js
export async function verifySchedule(request, secret) {
  const m = (request.headers.get('X-Schedule-Signature') ?? '').match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const [, t, v1] = m;
  const body = await request.json(); // { schedule_id, scheduled_at, fired_at }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body.schedule_id}.${body.scheduled_at}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300; // 5 分鐘新鮮度
  return fresh && hex === v1;
}
```

### 高精度 pattern（dumb ticker 的正確用法）

CF cron tick 本身有延遲。需要「每 10 分鐘跑一次、誤差別太大」時：註冊
`interval_minutes: 1`，你的 handler 自己持久化 last-run 時間、`now - last >= 600` 才
執行事件——漏 tick 下次喚醒自動補，drift 不累積（用 body 的 `fired_at` 算 elapsed）。

### 失敗語義（註冊時自選，hub 永不替你決定）

- `retry_count`：0（預設）或 1（失敗當場補一次）。
- `alert_after_failures`：0（預設 off）或 N——連敗**跨越** N 時 watch-dog 發 Slack
  warning 給操作者；成功歸零。**沒有自動暫停**——你的排程永遠不會被 hub 靜默停掉。
- `paused`：你自己設的維護窗（PUT `{"paused":1}`），回復同樣自助。
```

- [ ] **Step 7.4: docs/testing.md** — 加「### Scheduler Hub（2026-10-19，D28 Proposed → 實作後改 Verified）」段：列 `tests/schedules.test.ts` 覆蓋面（簽名純函數、due 引擎 7 案例、API CRUD + ownership、admin 唯讀、cron wiring + 不變式①隔離）。

- [ ] **Step 7.5: FIX-LOG.md**（D19）— 檔尾加條目：

```markdown
## 2026-10-19 — Scheduler Hub（排程觸發樞紐）
- 變更：新增 dumb-ticker 排程樞紐（docs/plans/2026-10-19-scheduler-hub-design.md）。cron */5→*/1（slot 計條數非頻率——2026-09-23 註解的「放寬讓 slot」其實是誤判，getkm ef457dc42d3a）。
- 不變式①防護：scheduler 在 scheduled handler 獨立 try/catch、位於 fail-dead 之後；測試雙釘（正常 fire + DNS 失敗不破壞偵測）。
- tier: major；BUILD-PLAN：docs/plans/2026-10-19-scheduler-hub-plan.md。
```

- [ ] **Step 7.6: CLAUDE.md + AGENTS.md**（[MUST] 兩檔同步）— 第一段「被動式 dead-service 監控哨兵…」之後加一句：

```markdown
2026-10-19 起另兼任**排程觸發樞紐（scheduler hub）**：註冊制 dumb ticker（`src/services/scheduler.ts`），獨立 try/catch 隔離於 fail-dead 路徑——不變式①語義不變。
```

- [ ] **Step 7.7: Commit**

```bash
git add README.md docs/api.md docs/client-guide.md docs/testing.md FIX-LOG.md CLAUDE.md AGENTS.md
git commit -m "docs(scheduler): client contract, verify recipe, README/API/testing sync" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 全量驗證（02-BUILD-SPEC §4 + §5）

- [ ] **Step 8.1: 依序跑四項**（[NEVER] pipe 進 tail/head；寫檔捕捉 exit code）：

```bash
cd /home/peter/Code/watch-dog
./node_modules/.bin/tsc --noEmit > /tmp/wd-tsc.log 2>&1; echo "TSC_EXIT=$?"; tail -3 /tmp/wd-tsc.log
npm run lint > /tmp/wd-lint.log 2>&1; echo "LINT_EXIT=$?"; tail -3 /tmp/wd-lint.log
npm test > /tmp/wd-test.log 2>&1; echo "TEST_EXIT=$?"; tail -5 /tmp/wd-test.log
npm run build > /tmp/wd-build.log 2>&1; echo "BUILD_EXIT=$?"; tail -3 /tmp/wd-build.log
```

Expected: 四個 EXIT 全為 0；test 通過數 ≥ 修改前基線 + 23。

- [ ] **Step 8.2: §5 自審七項** — 逐項確認（build/tests/lint/無 TODO/無計畫外檔案/達成目的/無安全退化——SSRF 面：callback 僅限 https、註冊閉合於 operator 建 project）。
- [ ] **Step 8.3: 部署前 schema 套用 + 部署**（操作者確認後）：

```bash
# D1 schema 冪等套用（remote）
npx wrangler d1 execute watch-dog-db --file src/db.sql --remote
npx wrangler deploy
# 部署後驗證 tick：SELECT next_run_at 前後對照（getkm 95b8fbd3a89f——wrangler tail 看不到 scheduled 事件，D1 副作用才是 ground truth）
npx wrangler d1 execute watch-dog-db --remote --command "SELECT id, next_run_at, last_status FROM schedules"
```

- [ ] **Step 8.4: putkm 記錄**（§5 經驗記錄，[ALWAYS]）：problem = cron slot 撞牆的集中式解法與 dumb-ticker 取捨；solution = advance-first + 註冊方自選 retry/alert + 目標端自節流；tags = `["cloudflare", "workers", "cron", "scheduler", "d1"]`。
- [ ] **Step 8.5: evo log-attempt**：`evo log-attempt --project watch-dog --task scheduler-hub --kind code --goal "1 cron slot 服務全部專案的排程樞紐" --outcome <實際結果>`

---

### Task 9: Ship-check（§5.5）+ 收工

- [ ] **Step 9.1: ship-check 六項** — operating-context current（CLAUDE.md/AGENTS.md 已同步 ✓ Task 7.6）、無 CRITICAL-unverified rule、docs set 就位、guard currency（部署模式未變）、gate read-only（未動 pre-push）、project-status emit（下步）。
- [ ] **Step 9.2: project-status emit**（非 trivial，[MUST]）— peter-brain `ingest_doc`（`source_type="project-status"`）：watch-dog 新增 scheduler hub 能力、health、blockers=無、next=觀察 D1 額度與失敗警報。
- [ ] **Step 9.3: 看板收工** — 卡改 `stage: verify`，【現況】補完成摘要 + 證據（測試 log 絕對路徑），驗收標「手冊影響：有」（client-guide 有 delta，回填 docs-hub 由操作者驗收時進行）。
- [ ] **Step 9.4: merge**（操作者確認後）— PR → main；[NEVER] `--no-verify`。

---

## Self-Review 記錄（plan 作者已跑）

- **Spec coverage**：設計文件 §2 七項決策 → Task 1-7 全覆蓋；AC1→Task 4、AC2/AC3→Task 3、AC4→Task 3、AC5→Task 5、AC6→Task 3（limit test）、AC7→Task 7。✓
- **Placeholder scan**：無 TBD/TODO；文件任務（7.2/7.4）為「附加章節 + 內容要點」型——append 型文件步驟給了完整內容規格，非空洞指示。✓
- **Type consistency**：`Schedule` 欄位 ↔ db.sql 欄位 ↔ seedSchedule ↔ SQL INSERT/UPDATE 欄位序已逐欄位核對；`signScheduleHeader(secret, scheduleId, scheduledAt, firedAt)` 簽名在 Task 2/3 與 client 驗證範例三處同一 recipe（`${firedAt}.${scheduleId}.${scheduledAt}`）。✓
- **§3.1 hand-trace**：所有斷言已對照實作追蹤——advance 計算（`now + interval*60` 與 tolerance 斷言）、retry 計數（`calls === 1` 回 500 → 第二次 200 → ok）、連敗跨越（seed 1 + fail 1 = 2 === threshold）、LIMIT 20 取最逾期 20 筆（next_run_at 1..25 升冪）、no-hammer（fail 後 next_run_at = now+3600 > 下一 tick now）。✓
