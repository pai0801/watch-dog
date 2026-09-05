# Watch-Dog 客戶端接入指南（Client Guide）

> **這份文件是「要被 watch-dog 監控的專案」的單一入口**——給維護者與 AI agent 讀。
> 操作者（管理 watch-dog 本身）請讀 [usage.md](usage.md)；完整 API 規格見 [api.md](api.md)。

## 服務地址

- **Watch-Dog URL**: `https://watch-dog.helperp.workers.dev`
- 公開狀態頁（免認證）: `https://watch-dog.helperp.workers.dev/api/status`

## 一句話理解

Watch-Dog 是 **dead-man's switch**：你的服務固定發 pulse（心跳），**pulse 停了 = 服務死了 → Slack 警報**。它不主動探活你的服務——「沒收到訊號」本身就是警報。

## 30 秒接入（最小閉環）

> **前提**：操作者已在 `/admin` 建立 project 並把 token 交給你（註冊不開放自助——見下方 Token 說明）。

```bash
# 1) 定義你的 checks（project 已由操作者建立；token 是你的專案身分）
curl -X PUT "https://watch-dog.helperp.workers.dev/api/config" \
  -H "Authorization: Bearer YOUR_PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"my-service","display_name":"我的服務","checks":[{"name":"heartbeat","type":"heartbeat","interval":300,"grace":60}]}'

# 2) 每輪工作完成時發 pulse（一行就夠）
curl -X POST "https://watch-dog.helperp.workers.dev/api/pulse" \
  -H "Authorization: Bearer YOUR_PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"check_name":"heartbeat","status":"ok"}' --max-time 5
```

**heartbeat check 的判死規則**：`(last_seen + interval + grace) < now` 由每分鐘 cron 掃描——超過 `interval + grace` 秒沒收到 pulse 就標 DEAD 並發 critical 警報。之後恢复發 pulse 會觸發 recovery 通知。

## Token 與認證

| 事項 | 說明 |
|---|---|
| 認證方式 | `Authorization: Bearer {project_token}`（**僅此一途**，舊 `X-Project-Token` header 已移除） |
| Token 取得 | 向操作者索取（操作者在 `/admin` 建立 project 時設定 token，至少 16 字元）。**註冊不開放自助**——`PUT /api/config` 對未知 project 回 404，防止陌生人建立 check 打警報進 Slack |
| Token 保管 | 至少 16 字元隨機值；放環境變數 / 該專案的 secrets 管理，[NEVER] commit 進 repo |
| 401 vs 403 | 401 = 沒帶 token；403 = token 不對（或與 project 不符） |

## Check 參數（誠實版——含實際 clamp）

| 參數 | 說明 | 預設 | **實際接受範圍** |
|---|---|---|---|
| `type` | `heartbeat`（定期心跳，會判死）或 `event`（只在回報 error 時警報，不判死） | — | 二選一，其他值靜默跳過 |
| `interval` | 心跳間隔（秒） | 300 | **clamp 10–300**（超出會被拉進範圍） |
| `grace` | 寬限期（秒） | 60 | **clamp 0–60** |
| `threshold` | 連續失敗幾次才警報 | 1 | **固定 1**（clamp 1–1——目前任何值都等效 1） |
| `cooldown` | 同一 check 兩次警報的最小間隔（秒）；`>0` 時覆蓋全局靜默期 | 900 | **clamp 0–900**（0 = 用全局靜默期） |
| `monitor` | admin UI 可勾選暫停某個 check 的監控（不勾 = 不警報但照收 pulse） | 1 | — |

> ⚠️ 兩個容易踩的行為：(1) config 裡**無效的 check 條目會被靜默跳過**——以回應的 `checks_registered` 數為準；(2) pulse 一個**未註冊**的 `check_name` 會得到 404——先 config 再 pulse。

## 警報層級 → Slack 頻道路由

| 層級 | 觸發 | 頻道 |
|---|---|---|
| **critical** | heartbeat 判死（pulse 停了） | critical channel |
| **warning** | pulse 回報 `status: "error"`（且過靜默期） | warning channel |
| **recovery**（success） | 從 DEAD/ERROR 恢復 | success channel |

維護模式（maintenance）期間該 project 所有警報靜音。

## 範例

### Shell（cron / batch 腳本——艦隊最常用）

```bash
#!/bin/bash
WD_URL="https://watch-dog.helperp.workers.dev"
WD_TOKEN="${WATCHDOG_TOKEN:?set WATCHDOG_TOKEN in env}"

START=$(date +%s)
your_backup_command_here; EXIT_CODE=$?
LATENCY=$(( $(date +%s) - START ))

STATUS=$([ $EXIT_CODE -eq 0 ] && echo ok || echo error)
curl -X POST "$WD_URL/api/pulse" \
  -H "Authorization: Bearer $WD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"check_name\":\"backup\",\"status\":\"$STATUS\",\"latency\":$LATENCY}" \
  --max-time 5 >/dev/null 2>&1 || true
```

放在 cron job / CI step 的**最後**——pulse = 「這輪工作完成了」。腳本靜默死亡（crontab 壞、機器重啟沒回、卡死）＝ pulse 停 ＝ 警報。這正是 heartbeat 比「檢查 process 活著」更準的地方。

### Node.js / TypeScript（Worker / 常駐服務）

```typescript
// utils/watchdog.ts
const BASE_URL = 'https://watch-dog.helperp.workers.dev';

export class WatchDog {
  constructor(
    private token: string,
    private projectId: string,
    private displayName: string,
  ) {}

  /** 服務啟動時註冊（project_id / display_name 是 API 必填欄位） */
  register(checks: Array<Record<string, unknown>>) {
    return fetch(`${BASE_URL}/api/config`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: this.projectId, display_name: this.displayName, checks }),
    }).catch(() => {}); // 監控不得拖垮主流程
  }

  pulse(checkName: string, status: 'ok' | 'error' = 'ok', message = 'OK', latency = 0) {
    return fetch(`${BASE_URL}/api/pulse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ check_name: checkName, status, message, latency }),
    }).catch(() => {});
  }
}
```

### Python（bot / 排程）

```python
# utils/watchdog.py
import requests, threading

class WatchDogClient:
    BASE_URL = "https://watch-dog.helperp.workers.dev"

    def __init__(self, token: str, project_id: str, display_name: str):
        self.headers = {"Authorization": f"Bearer {token}"}
        self.project_id = project_id
        self.display_name = display_name

    def register_checks(self, checks: list):
        payload = {"project_id": self.project_id, "display_name": self.display_name, "checks": checks}
        threading.Thread(target=self._put, args=("/api/config", payload), daemon=True).start()

    def pulse(self, check_name: str, status="ok", message="OK", latency=0):
        payload = {"check_name": check_name, "status": status, "message": str(message), "latency": latency}
        threading.Thread(target=self._post, args=("/api/pulse", payload), daemon=True).start()

    def _put(self, path, payload):
        try: requests.put(self.BASE_URL + path, json=payload, headers=self.headers, timeout=10)
        except Exception: pass  # 監控不得拖垮主流程

    def _post(self, path, payload):
        try: requests.post(self.BASE_URL + path, json=payload, headers=self.headers, timeout=5)
        except Exception: pass
```

## 給 client repo 的 AI agent：貼進你的 CLAUDE.md

```markdown
## Watch-Dog 心跳接入（已完成/待接入）
- 服務: https://watch-dog.helperp.workers.dev
- Token: 環境變數 WATCHDOG_TOKEN（向操作者索取；secrets 管理勿 commit）
- 註冊: project 由操作者於 /admin 建立（closed registration）；啟動時 PUT /api/config 定義 checks（Bearer；body 含 project_id/display_name/checks；未知 project 回 404）
- 心跳: 每輪工作完成後 POST /api/pulse {"check_name":"...","status":"ok"}
- 判死: interval+grace 秒內無 pulse → Slack critical；恢復 → success 通知
- 監控故障 [MUST NOT] 影響主流程：pulse 失敗靜默（timeout 5s、catch-all）
```

## 維護模式（排程維護時靜音）

```bash
curl -X POST "https://watch-dog.helperp.workers.dev/api/maintenance/my-service" \
  -H "Authorization: Bearer YOUR_PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"duration":3600}'
```

## 驗證你的接入

```bash
# 公開、免認證——pulse 之後 last_seen 應更新、is_stale 應為 false
curl -s https://watch-dog.helperp.workers.dev/api/status/my-service | jq
```

## 故障排查

| 症狀 | 檢查 |
|---|---|
| pulse 回 401 | 沒帶 `Authorization: Bearer` header |
| pulse 回 403 | token 錯 / 與 project 不符（`project_id` 有指定時兩者必須一致） |
| pulse/config 回 404 | project 或 check 不存在——project 要操作者在 `/admin` 建立；check 先 `PUT /api/config`（看 `checks_registered` 是否如預期） |
| config 回 200 但 check 沒出現 | 該條目無效被靜默跳過（type 不合法 / name 空值）——比對 `checks_registered` |
| 沒收到 Slack 警報 | check 是否被 admin 暫停（monitor=0）？project 是否在維護模式？是否仍在 cooldown/靜默期？ |
| 一直誤報 DEAD | `interval` 設得比實際發 pulse 週期短——interval 要 ≈ 你的發送週期、grace 吸收抖動 |
