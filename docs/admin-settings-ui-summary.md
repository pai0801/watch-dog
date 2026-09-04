# Admin Settings UI 實現總結

## 概述

成功為 Watch-Dog Sentinel 實現了完整的 Web 管理介面，允許通過瀏覽器配置所有設置，無需修改代碼或重新部署。

## 實現時間

2026-02-02

## 功能特性

### 1. 設置表 (D1 數據庫)

創建了 `settings` 表，用於存儲所有配置：

| 字段 | 類型 | 說明 |
|------|------|------|
| key | TEXT (PRIMARY KEY) | 設置鍵名 |
| value | TEXT | 設置值 |
| description | TEXT | 設置描述 |
| updated_at | INTEGER | 更新時間 (Unix timestamp) |

**默認設置：**
- `slack_api_token` - Slack Bot Token
- `slack_channel_critical` - 嚴重警報頻道
- `slack_channel_success` - 成功/恢復頻道
- `slack_channel_warning` - 警告頻道
- `slack_channel_info` - 信息日誌頻道
- `silence_period_seconds` - 警報冷卻時間（默認 3600 秒）

### 2. 設置服務模組 (`src/services/settings.ts`)

提供了一組完整的 CRUD 操作：

```typescript
// 獲取所有設置（帶默認值）
getAllSettings(db: D1Database): Promise<AllSettings>

// 更新單個設置
updateSetting(db: D1Database, key: string, value: string): Promise<boolean>

// 批量更新 Slack 設置
updateSlackSettings(db: D1Database, settings: SlackSettings): Promise<boolean>

// 獲取設置（D1 settings 表為單一真相源；env fallback 已於 2026-09-04 首次部署前移除）
getAllSettings(db: D1Database): Promise<AllSettings>
```

### 3. 告警服務更新

更新了 `src/services/alert.ts` 和 `src/services/logic.ts`：

- `sendSlackAlert()` 現在從數據庫讀取配置
- `getSilencePeriod()` 使用數據庫設置
- 支持環境變量回退（平滑遷移）

### 4. Admin 管理介面 (`/admin`)

訪問地址：`https://watch-dog.helperp.workers.dev/admin`

#### 設置標籤頁

配置 Slack 集成：
- API Token（密碼字段）
- 4 個頻道 ID（嚴重、成功、警告、信息）
- 靜默期（秒）

#### 項目標籤頁

管理監控項目：
- 查看所有項目及其 Token
- 查看每個項目的檢查數量
- 創建新項目
- 刪除項目（級聯刪除所有檢查）

#### 檢查標籤頁

管理監控檢查：
- 查看所有檢查
- 編輯檢查配置（名稱、類型、間隔、寬限期、閾值、冷卻）
- 刪除檢查

### 5. 實現的 API 路由

| 方法 | 路由 | 功能 |
|------|------|------|
| GET | /admin | 管理介面主頁 |
| POST | /admin/settings/slack | 保存 Slack 設置 |
| DELETE | /admin/projects/:id | 刪除項目 |
| DELETE | /admin/checks/:id | 刪除檢查 |
| GET | /admin/checks/:id/edit | 編輯檢查表單 |
| POST | /admin/checks/:id | 更新檢查 |
| POST | /admin/projects/new-dialog | 新建項目對話框 |
| POST | /admin/projects/new | 創建新項目 |

## 技術決策

### 1. 數據庫優先配置

- ✅ 配置更改無需重新部署
- ✅ 支持多環境
- ✅ 配置即代碼（可版本控制）

### 2. 環境變量回退

- ✅ 向後兼容現有部署
- ✅ 平滑遷移路徑
- ✅ 數據庫設置優先於環境變量

### 3. HTMX + Alpine.js

- ✅ 無需構建步驟
- ✅ 簡單的服務端渲染
- ✅ 流暢的用戶體驗

### 4. 安全性

- ✅ 準備好使用 Cloudflare Access進行 Zero Trust 保護
- ✅ SQL 注入防護（預處理語句）
- ✅ 密碼字段隱藏 Token

## 部署

生產環境已部署：
```
https://watch-dog.helperp.workers.dev/admin
```

### 首次設置

如果生產數據庫還沒有 settings 表，運行：

```bash
npx wrangler d1 execute watch-dog-db --file=src/db.sql
```

### 從環境變量遷移

如果現有部署使用環境變量，系統會自動回退到環境變量值。要遷移到數據庫：

1. 訪問 `/admin`
2. 在設置表單中填入現有值
3. 保存

## 提交記錄

| 提交 | 描述 |
|------|------|
| 7dcedca | feat: add settings table for admin configuration |
| e4f39a9 | feat: add settings service module |
| aec88c9 | fix: correct settings service key mapping and types |
| c634e97 | feat: use database settings instead of env vars for Slack config |
| 285e23c | refactor: remove unused getAllSettings import |
| b635a11 | feat: add admin UI routes for settings and management |
| 1c7c825 | fix: admin routes - improve delete handling, validation, error handling |
| b561c46 | feat: add admin styling |
| 58c2519 | test: verified admin interface functionality |

## 待辦事項（可選增強）

- [ ] 添加用戶認證（建議使用 Cloudflare Access）
- [ ] 添加設置更改日誌
- [ ] 批量操作（多選刪除）
- [ ] 導出/導入配置
- [ ] 設置驗證（例如測試 Slack 連接）
