# Windmill 處置契約（WINDMILL-CONTRACT）

> WATCHDOG-015 · 2026-10-31 · 這是 **rn4g-1 上 Windmill 必須遵守的規則**。
> watch-dog 端實作：`src/services/issues.ts` + `src/routes/issues.ts`。
> 各受監專案的接入方式見 [README.md §Issues 收集器](../README.md)（SSoT）。

## 架構位置（為什麼有這份契約）

```
CF Workers Issues ──webhook──▶ watch-dog（收集/分診，CF 上）──poll/claim/write-back──▶ Windmill（rn4g-1，處置）
      ▲                              ▲                                                            │
      │                              └────────── heartbeat（每輪 poll）──────────────────────────┘
      └──────────── 修復 → 信號收斂（resolved 事件自動回流，信號源即驗證器）────────────────────┘
```

四迴路閉環：**信號**（triggered/resolved 都要收）→ **任務**（claim 寫回）→
**成效**（等信號收斂，不信自己的修復宣告）→ **監控者**（Windmill 停止 poll → fail-dead 警報）。

## 端點契約

Base URL：`https://watch-dog.helperp.workers.dev` · Auth：`Authorization: Bearer {WINDMILL_TOKEN}`（missing/wrong → 503/401 fail-closed）

### 1. `GET /api/windmill/issues` — 拉可認領清單

回傳 `state=open`，加上 claimed 超過 30 分鐘未 write-back 的洩漏認領（crash 恢復）。
每輪 poll **必須**伴隨一次 `POST /api/windmill/heartbeat`（見規則 W5）。

```json
{ "ok": true, "count": 1, "issues": [ {
  "id": 3, "fingerprint": "…", "script_name": "topreview-hotel",
  "project_id": "topreview-hotel", "title": "TypeError: …",
  "alert_type": "workers_observability_alert", "state": "open",
  "attempt_count": 0, "max_auto_attempts": 2,
  "first_seen": 1761…, "last_seen": 1761…, "claimed_at": null,
  "payload": "{…原始 CF payload（截 8KB）…}"
} ] }
```

### 2. `POST /api/windmill/issues/:id/claim` — 認領

- 成功 200：`state → claimed`、`attempt_count +1`、**映射專案自動進 maintenance 45 分鐘**（watch-dog 側保證，你不用做）。
- 409 `already claimed (live lease)`：別的 poller 正在處理——**不要動這個 issue**。
- 409 `max auto attempts reached`：保險絲燒斷，已 escalate 人工——**永遠不要再 claim 同一 fingerprint 的 escalated issue**。
- 409 `not claimable from state …`（escalated/resolved/done）——同上，跳過。

### 3. `POST /api/windmill/issues/:id/feedback` — 回寫（處置結束必寫）

Body：`{ "status": "done" | "failed" | "skipped", "message": "…" }`（message 選填，會進審計軌跡）

| status | 語義 | watch-dog 動作 |
|---|---|---|
| `done` | 修復已部署，等待 CF resolved 事件收斂 | `state → done`（等 CF 回報 resolved 才終局） |
| `failed` | 這輪修不好 | attempts 還沒用完 → 回 `open`（下輪可再 claim）；用完 → escalate 人工 |
| `skipped` | 自動化不接這類 | `state → escalated` + 通知操作者 |

**只能對 `claimed` 狀態回寫**（409 otherwise）。claim 了就必須回寫——不回寫 30 分鐘後會被視為洩漏認領重新開放，且 attempt 已計入保險絲。

### 4. `POST /api/windmill/heartbeat` — 心跳

每輪 poll 呼叫一次。watch-dog 側自動建立 `automation:windmill-pulse` heartbeat check
（interval 180s / grace 120s）：**Windmill 停止 poll 約 5 分鐘 → 既有 fail-dead 機制對你發 DEAD 警報**。這是閉環的第四迴路——沒有人是未被監控的。

## Windmill 必須遵守的規則

- **W1（處置三級）**：
  - **Level 1 唯讀診斷**（查 log、查 CF dashboard、讀 repo）→ 全自動。
  - **Level 2 安全動作**（重啟 cron、清 cache、重跑失敗任務）→ 全自動。
  - **Level 3 prod 部署與資料變更** → **只能開 PR + 開看板卡（approvalRequired），永不自行 merge / deploy / 寫資料**。與 fleet 部署政策一致（直接部署 prod 雖然合法，但那是人類的決定權）。
- **W2（保險絲服從）**：同一 episode 最多自動處理 `max_auto_attempts = 2` 次。收到 409 就停手；`escalated` 狀態是人工的，永不重試。
- **W3（成效驗證）**：`done` 前必須有實際修復動作；宣稱 done ≠ 修好——真正的驗證是 CF 的 resolved 事件回流（信號源即驗證器）。若 done 後 CF 未收斂而 issue 復發，watch-dog 會開新 episode 重進佇列，attempt 歸零重計——這是設計行為。
- **W4（payload 紀律）**：`payload` 欄位是原始 CF 診斷上下文（可能含 stack trace）。只用於診斷；不得轉發到第三方、不得貼進公開頻道。
- **W5（心跳義務）**：每輪 poll = 一次 heartbeat。Windmill 自身的 scheduler 掛了要靠這個被發現——你停跳，5 分鐘後人類會收到你的 DEAD 警報。
- **W6（poll 節奏）**：建議 ≥ 60 秒一輪。清單為空也照常 poll + heartbeat。
- **W7（憑證）**：`WINDMILL_TOKEN` 存 rn4g-1 的 Windmill variable store（file-sourced）；輪替流程見 `secrets-archive/SECRETS.md`。

## 建議的 Windmill flow 形狀

```
schedule (every 1m)
  ├─ POST /api/windmill/heartbeat
  ├─ GET  /api/windmill/issues
  └─ for each issue:
       ├─ POST …/claim          → 409 = skip；200 = 處理權到手
       ├─ 判斷處置等級（W1）
       │    L1/L2 → 執行 → feedback done|failed
       │    L3    → 開 PR + 開卡（approvalRequired）→ feedback done（附 PR 連結）
       │    不確定 → feedback skipped
       └─ 任何 exception → feedback failed（message = 錯誤摘要）
```

## 狀態機（watch-dog 側真源）

```
                ┌──────────── cf regressed（新 episode，attempt 歸零）────────────┐
                ▼                                                                │
 open ──claim──▶ claimed ──done──▶ done ──cf resolved──▶ resolved ──cf triggered──┘
  ▲                 │ │
  │    failed(attempt<2)  │ └─skipped──────▶ escalated ──cf resolved──▶ resolved
  └──────────────────┘    └─failed(attempt=2)─▶ escalated
任何狀態 ──cf resolved──▶ resolved
```

> **2026-10-31 補註（WATCHDOG-016）**：佇列裡現在有兩種來源——`cf-issues`（CF Issues
> webhook）與 `report`（服務自評掛號 `POST /api/issues/report`）。對 Windmill 完全同構：
> 同一個狀態機、同樣 claim/feedback。report 源 issue 的 `project_id` 必有值（token 反查），
> 不會出現 unmapped；`payload` 是 `{source:'report', severity, title, message, check_name}`。
> severity=critical 的 report 已走過 critical+email 通知，Windmill 處置時優先看它。
