# Watch-Dog Sentinel 使用指南

## 服務地址

**Watch-Dog Sentinel URL:** `https://watch-dog.paipeter-gui.workers.dev/`
**Admin 管理頁面:** `https://watch-dog.paipeter-gui.workers.dev/admin`（需 Admin 密碼,見下方）

---

## 概述

Watch-Dog Sentinel 是一個**被動監控系統**（Dead Man's Switch）。服務主動向 Watch-Dog 報告心跳，如果停止報告，系統會發送警報到 Slack。

### 核心概念

| 概念 | 說明 |
|------|------|
| **Project Token** | 每個項目獨立的 Token，用於客戶端 API 認證 |
| **Slack API Token** | 全局設置，用於向 Slack 發送通知 |
| **Admin 密碼 (ADMIN_TOKEN)** | `/admin` 頁面的 HTTP Basic Auth 密碼（Worker secret,用戶名任意） |
| **Monitor 開關** | 勾選=監控該檢查，不勾選=跳過（不會觸發警報） |

> **安全提示**：`/api/maintenance/:projectId` 也需要 Project Token；
> Slack API Token 只顯示遮罩（`••••••••1234`），表單留空 = 保留現有值。

---

## 快速開始（3步驟）

### 第一步：創建項目

1. 訪問 `https://watch-dog.paipeter-gui.workers.dev/admin`
2. 切換到 **Projects** 標籤
3. 點擊 **New Project**，填寫：
   - **Project ID**: `my-service`（小寫英文、數字、連字符）
   - **Display Name**: `我的服務`
   - **Token**: 輸入或生成一個安全 Token（至少 16 字元）
4. 點擊 **Create**

### 第二步：配置 Slack 通知

1. 切換到 **Settings** 標籤
2. 填寫 Slack 配置：
   - **API Token**: `xoxb-...`（從 [Slack Apps](https://api.slack.com/apps) 獲取）
   - **Critical Channel**: 嚴重警報頻道 ID
   - **Success Channel**: 恢復通知頻道 ID
   - **Warning Channel**: 警告頻道 ID
   - **Info Channel**: 信息日誌頻道 ID
   - **Silence Period**: 重複警報間隔（秒，建議 3600）
3. 點擊 **Save Settings**

### 第三步：客戶端集成

將你的服務連接到 Watch-Dog，參考下方範例。

---

## Python 客戶端範例

```python
# utils/watchdog.py
import requests
import threading

class WatchDogClient:
    def __init__(self, token: str, project_id: str, display_name: str):
        self.base_url = "https://watch-dog.paipeter-gui.workers.dev"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.project_id = project_id
        self.display_name = display_name

    def register_checks(self, checks: list):
        """註冊檢查規則（project_id / display_name 為 API 必填欄位）"""
        payload = {"project_id": self.project_id, "display_name": self.display_name, "checks": checks}
        threading.Thread(target=self._do_register, args=(payload,)).start()

    def _do_register(self, payload):
        try:
            requests.put(f"{self.base_url}/api/config", json=payload, headers=self.headers, timeout=10)
        except Exception:
            pass

    def pulse(self, check_name: str, status="ok", message="OK", latency=0):
        """發送心跳"""
        payload = {
            "check_name": check_name,
            "status": status,
            "message": str(message),
            "latency": latency
        }
        threading.Thread(target=self._send, args=(payload,)).start()

    def _send(self, payload):
        try:
            requests.post(f"{self.base_url}/api/pulse", json=payload, headers=self.headers, timeout=5)
        except Exception:
            pass

# 使用範例
wd = WatchDogClient(token="your-project-token-here", project_id="my-service", display_name="我的服務")

# 啟動時註冊
wd.register_checks([{
    "name": "db_health",
    "display_name": "資料庫健康檢查",
    "type": "heartbeat",
    "interval": 60,
    "grace": 10,
    "threshold": 3,
    "cooldown": 300
}])

# 定期發送心跳
def health_check():
    try:
        # 執行健康檢查
        latency = db.check_latency()
        wd.pulse("db_health", status="ok", latency=latency)
    except Exception as e:
        wd.pulse("db_health", status="error", message=str(e))

# 每60秒執行
# sched.add_job(health_check, 'interval', seconds=60)
```

---

## Node.js / TypeScript 範例

```typescript
// utils/watchdog.ts
type CheckConfig = {
  name: string;
  display_name: string;
  type: 'heartbeat' | 'event';
  interval?: number;
  grace?: number;
  threshold?: number;
  cooldown?: number;
};

export class WatchDog {
  private baseUrl = "https://watch-dog.paipeter-gui.workers.dev";

  constructor(
    private token: string,
    private projectId: string,
    private displayName: string
  ) {}

  async register(checks: CheckConfig[]) {
    await fetch(`${this.baseUrl}/api/config`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      // project_id / display_name are required by the API
      body: JSON.stringify({ project_id: this.projectId, display_name: this.displayName, checks })
    }).catch(() => {});
  }

  pulse(checkName: string, status: 'ok' | 'error', message = 'OK', latency = 0) {
    fetch(`${this.baseUrl}/api/pulse`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        check_name: checkName,
        status,
        message,
        latency
      })
    }).catch(() => {});
  }
}

// 使用
const wd = new WatchDog('your-project-token-here', 'my-service', 'My Service');

await wd.register([{
  name: 'api_server',
  display_name: 'API Server',
  type: 'heartbeat',
  interval: 30,
  grace: 5
}]);

setInterval(() => {
  wd.pulse('api_server', 'ok', 'Server running');
}, 30000);
```

---

## Shell Script 範例

```bash
#!/bin/bash

WD_URL="https://watch-dog.paipeter-gui.workers.dev"
TOKEN="your-project-token-here"

# 執行任務
START=$(date +%s%3N)
# your_command_here
EXIT_CODE=$?
END=$(date +%s%3N)
LATENCY=$((END-START))

# 回報結果
if [ $EXIT_CODE -eq 0 ]; then
  curl -X POST "$WD_URL/api/pulse" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"check_name":"backup","status":"ok","latency":'$LATENCY'}' \
    --max-time 5 > /dev/null 2>&1 &
else
  curl -X POST "$WD_URL/api/pulse" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"check_name":"backup","status":"error","message":"Failed"}' \
    --max-time 5 > /dev/null 2>&1 &
fi
```

---

## API 端點

### 發送心跳

```bash
POST /api/pulse
Authorization: Bearer {project_token}
Content-Type: application/json

{
  "check_name": "my_check",
  "status": "ok",           # ok 或 error
  "message": "一切正常",
  "latency": 50             # 毫秒（可選）
}
```

### 註冊檢查規則

```bash
PUT /api/config
Authorization: Bearer {project_token}
Content-Type: application/json

{
  "project_id": "my-service",
  "display_name": "我的服務",
  "checks": [
    {
      "name": "my_check",
      "display_name": "我的檢查",
      "type": "heartbeat",
      "interval": 60,
      "grace": 10,
      "threshold": 3,
      "cooldown": 300
    }
  ]
}
```

---

## Admin 管理頁面

訪問 `https://watch-dog.paipeter-gui.workers.dev/admin`
瀏覽器會要求 Basic Auth：用戶名任意，密碼 = `ADMIN_TOKEN` Worker secret。

### Settings 標籤
- 配置 Slack API Token 和頻道 ID（Token 欄位顯示遮罩,留空送出 = 保留現有 Token）
- 設定警報冷卻時間

### Projects 標籤
- 查看所有項目
- 創建新項目
- 刪除項目

### Checks 標籤
- 查看所有檢查狀態
- **Monitor checkbox** - 勾選=監控，不勾選=暫停
- 刪除檢查

---

## 檢查參數說明

| 參數 | 說明 |
|------|------|
| **Type** | `heartbeat` = 定期心跳, `event` = 事件觸發 |
| **Interval** | 心跳間隔（秒） |
| **Grace** | 寬限期（秒），超過 interval+grace 才算逾期 |
| **Threshold** | 連續失敗幾次才觸發警報 |
| **Cooldown** | 警報冷卻時間（秒），避免重複通知 |
| **Monitor** | 勾選=監控，不勾選=暫停監控 |

---

## 故障排查

### 沒有收到 Slack 通知？
1. 檢查 Settings 中的 Slack API Token 是否正確
2. 檢查頻道 ID 是否正確
3. 檢查該 Check 的 Monitor 是否勾選
4. 查看 Dashboard 確認 Check 狀態

### Check 一直顯示 DEAD？
1. 確認客戶端正在發送 pulse
2. 檢查 Token 是否正確
3. 查看 Interval 和 Grace 設定是否合理

---

## 安全建議

1. **Token 保密** - 不要提交到公開代碼庫，使用環境變量
2. **使用 HTTPS** - 所有通訊都經過 HTTPS 加密
3. **Token 強度** - 至少 16 字元，隨機生成
