# CF Issues → Automations 手動設置清單（操作者專用）

> WATCHDOG-015 residual——Automations 是 **dashboard-only**（2026-10-31 查證 CF docs：無公開 API；
> generic webhook 走 Notifications destination 形態，但建立 automation 只有 dashboard 路徑）。
> agent 側已驗證：`POST /api/ingest/issues` 端點 e2e 全通（WATCHDOG-015），只差 CF 側開關。

## 每帳號操作（11 帳號全艦隊）

帳號：paipeter / photo / s58 / gui / markpai0801 / murmurnoteapp / mbti.with.m / helperp / webv01-prod / bothub-prod / pai-alpha111

對帳號內**每個 production Worker**：

1. **啟用 Issues**（前提——沒啟用就沒有 issue 可自動化）：
   dashboard → Workers & Pages → 該 Worker → **Issues** 頁籤 → **Enable issues**。
   （repo 路線：wrangler config 加 `observability.issues.enabled = true` 後 redeploy——需 wrangler ≥4.134；本機目前 4.129）
2. **加 Automation**：
   同頁 → **Automations** → **Add automation** → trigger 選 occurrence threshold（建議 ≥5，降噪）→ destination 選 **Generic Webhook** → 建立目的地：
   - **URL**: `https://watch-dog.helperp.workers.dev/api/ingest/issues`
   - **Secret**: `~/.config/watch-dog/issues-ingest-token` 檔案內容（即 `ISSUES_INGEST_TOKEN` 值）
   - 名稱建議：`watch-dog-ingest`
3. 開 **Enabled** → **Create**。

## 驗證

- 設定完成後，watch-dog 觀察頁（dashboard 首頁「待處理 log 觀察」）應在該 Worker 出現真實 issue 時收到 `cf` 源條目；resolved 事件會自動關閉。
- 快速煙霧：在任一已啟用 Worker 上製造一次 `console.error`（或等自然錯誤），觀察頁 1-2 分鐘內應出現。

## 注意

- secret 用上述檔案值——與 watch-dog Worker secret `ISSUES_INGEST_TOKEN` 同源；輪替時兩處同步（SECRETS.md 該列）。
- Free plan webhook destination 已全 plan 開放（2026-10-02 changelog），帳號無 zone 也可設（上限 100 destinations）。
- 已知 fleet 觀察：photo 帳號 topreview-edge 尚未啟用 Issues（2026-10-31 檢查 wrangler config 無 `issues.enabled`）。
