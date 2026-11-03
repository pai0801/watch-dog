# BUILD-PLAN — ok-pulse log 小時採樣（D1 寫入額度結構性瘦身）

> tier: **major**（6 檔；監控核心行為變更）——02-BUILD-SPEC §1.5 全套 gate。
> 看板：WATCHDOG-020。日期：2026-11-03。

## THINK Block（D21）

```
1. ROOT CAUSE:     helperp 帳號 D1 寫入天天 60-100%（11-02 實際 101,356/100k 爆表）。
                   watch-dog 自身簿記 baseline ~73k/day，logs ok-pulse 無條件寫入
                   ~32k/day 佔大宗。追問二層：為何每 pulse 都寫 log？→ 歷史預設；
                   偵測只靠 checks.last_seen（不變式①），ok log 僅供 admin 檢視器
                   ——「無條件每分鐘 put」同款死法（額度紀律 §3），從未被審計。
2. CORRECT LAYER:  R2 Logic（processCheckResult 寫入決策）+ cron.ts 自我脈搏同款；
                   [NEVER] 動 checks 表更新（fail-dead 偵測本體）。
3. AFFECTED FILES: src/services/logic.ts、src/cron.ts、tests/logic.test.ts、
                   tests/cron.test.ts、FIX-LOG.md、docs/testing.md（本檔=7）。
                   爆破半徑小：logs 消費者僅 countRecentErrors（只讀 error rows，
                   不受影響）與 admin 檢視器（ok 列變稀疏，可接受、已記錄）。
4. ASSUMPTIONS:    ①ok log 無偵測功能（已驗證：findDeadChecks 只讀 checks 表、
                   escalation 只數 error rows、恢復判定用 checks.status）；
                   ②每 check 每小時 1 筆 ok log 的 admin 可見性足夠。②較可能錯——
                   若未來需要密集 latency 史，另建專用取樣而非回復無條件寫。
5. SIMPLER PATH:   小時跨越判斷（snapshot last_seen vs now 的 floor(now/3600)）：
                   零 schema 變更、零額外讀取、確定性、無新狀態。不做計數欄位/新表。
6. RISK:           最壞=採樣 bug 使 ok log 全消失 → admin 檢視器失 ok 史（偵測
                   不受影響）。Rollback：單一 helper + 兩個呼叫點，revert 一個 commit。
7. VERDICT:        PROCEED——不變式①零接觸（寫的是輔助 log，非偵測路徑）。
```

## User Story（D33）

**As a** watch-dog 操作者（單操作者系統），
**I want** ok-pulse 的 log 寫入按小時採樣（error/dead/恢復不受採樣），
**so that** 共享 CF 帳號的 D1 寫入額度（100k/day，帳號級、後爆型）不再被哨兵自身的簿記吃掉 30%，姊妹專案的批次寫入不再把帳號推爆（11-02 alliance-member 33.8k seed 突發 + baseline 70% = 實際爆表）。

**Acceptance criteria（testable）：**
1. 穩態 ok check（前一 pulse 同一小時）的 ok pulse：`checks.last_seen` 前進、`logs` 表**零新列**。
2. 前一 pulse 在不同小時的 ok pulse：寫入 exactly 1 列 ok log。
3. 任何非 ok→ok 的 pulse（恢復，含 CAS-lost 競態路徑）：必寫 log 列。
4. error/dead pulse 的 log 寫入與 `countRecentErrors` 行為完全不變（escalation 窗口計數不受採樣影響）。
5. cron 自我脈搏 log：同小時的每分鐘 tick 不寫 log、跨小時首個 tick 寫 1 列；`checks` 的 self-health 更新每 tick 照舊。
6. 部署後 24h：helperp 帳號 `d1_rows_written` < 50k（cf_usage_state 實測）。

### Test scenarios（AC 衍生）
- **T1（AC1）**：seed check（status=ok, last_seen=now）→ processCheckResult ok → countLogs=0、getCheck.last_seen 前進。
- **T2（AC2）**：seed check（status=ok, last_seen=now-3600）→ ok pulse → countLogs=1。
- **T3（AC3）**：seed check（status=error, failure_count≥threshold）→ ok pulse → countLogs=1 + recovery alert。
- **T4（AC4）**：既有 escalation 測試全數不變（不改）+ error pulse log 計數測試照舊通過。
- **T5（AC5）**：cron tick 同小時二次 → self log 計數不變；跨小時 → +1。
- Edge：last_seen=0（新註冊 check 首 pulse）→ floor(0/3600)=0 ≠ now bucket → 寫 1 列（首 pulse 留痕）。

## 設計（14-DESIGN-PRINCIPLES §2.3）

- **§0 兩問**：`shouldWriteOkLog(prev, now)` 純函數（快照狀態+時間→bool）——接口測試無需 DB；擁有權在 logic.ts（ok 寫入決策的唯一實作點），cron.ts 消費同一函數（rule 1：唯一實作，[NEVER] 第二份複本）。
- **介面收縮**：無新參數、無 schema 變更；`processCheckResult` 簽名不變。
- **分層**：採樣決策在 service 層，route/cron 不重複判斷。

## 變更檔案與順序

1. `src/services/logic.ts` — 新增 exported `shouldWriteOkLog`；ok 路徑（含 CAS-lost heartbeat 路徑）的 `writeLog()` 改 gate。
2. `src/cron.ts` — 自我脈搏 INSERT 用同 helper gate。
3. `tests/logic.test.ts` — T1/T2/T3 + 修改既有「healthy check writes a log row」語意。
4. `tests/cron.test.ts` — T5。
5. `FIX-LOG.md` + `docs/testing.md`（D28 Proposed 段）。
   - 收斂註記（2026-11-03 收尾）：本 repo 無 D28 guard（guards 僅 §A–§M + D18–D21），自動化測試文件依 repo 慣例記於 FIX-LOG 驗證欄；testing.md 落地為 Log Viewer 段的採樣預期行為清單（reviewer MEDIUM #1 收斂）。

## 不做（scope 外，另卡處理）

- schedules 雙寫（10k/day）：at-most-once 語意契約（2026-10-19 設計文件）必要成本，不動。
- checks 表每 pulse 更新：即偵測本體，不動。
- cf_usage_state 5.8k/day：額度監控本身的資料，30min 週期是警報時延與寫入的既有平衡，不動。
- alliance-member seed 隔離、mbti.with.m 備份增量 dump：跨 repo，另開看板卡。
