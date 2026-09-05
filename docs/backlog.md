# Backlog — watch-dog 改進項

> 操作與維護的滾動待辦。實案驅動：每項附日期與證據，修畢劃記。

## 2026-09-05 接入 email-king 實測暴露（ek-dev / ek-gateway 兩 project）

### WD-01 [P1] enroll.sh 不應為每個 client project 建立 `self` check

- **實案**：接入 ek-dev／ek-gateway 時，`enroll.sh`（經 `/admin/projects/new`）為每個新
  project 自動附加 `self`（Self Health）check——但 client 只會脈搏自己的 checks
  （如 `jobs`），`self` 永遠無脈搏 → 6 分鐘後判 DEAD → **每接入一個服務就預約一條
  Slack critical 誤報迴圈**（實測兩 project 各一條；操作者最終以
  `wrangler d1 execute watch-dog-db --remote "DELETE FROM checks WHERE id IN ('ek-dev:self','ek-gateway:self')"`
  收尾，2026-09-05）。
- **修法建議**：`enroll.sh`／`/admin/projects/new` 不再附 self 模板——自我監控掛在
  watch-dog 自己的 project 上即可（README 的 Self-Monitoring 語意），client project
  的 checks 完全由 client 的 `PUT /api/config` 宣告。
- **清理**：既有 project 的殘留 `self` check 需一次性清理（手動 D1 或小腳本）。
- **驗收**：新接入一個 project（enroll → config PUT → pulse）全流程零 DEAD 誤報。

### WD-02 [P2] 客戶端 API 缺 check 管理面（config 無刪除語意、monitor 不在 API 上）

- **實案**：同日，WD-01 的 `self` check 無法經 API 移除——`PUT /api/config` 只 upsert
  （payload 未列出的 check 原樣保留），`monitor`（暫停監控、照收 pulse）僅 admin UI
  可勾、不在 API 文件面，最終只能 D1 直攻。
- **修法建議**（擇一或並行）：
  - config PUT 支援整組取代語意（如 `checks_replace: true`，宣告式——與
    client-guide「先 config 再 pulse」的心智模型一致，client 的 checks 清單即真相）；或
  - check 條目開放 `monitor` 欄位（0 = 收 pulse 不警報）入 API 面。
- **安全考量**：刪除／停用僅影響自身 project（project token 已限定），無跨 project 面；
  整組取代語意需在文件強調「漏列即刪」的危險邊。
- **驗收**：client 能以 API 完整表達「這個 project 有哪些 checks、各自是否監控」，
  不再需要 D1 直攻或 admin UI。
