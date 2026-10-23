#!/usr/bin/env bash
# watchdog-trigger.sh — rn1g 每分鐘 cron(第二觸發源 + 跨平台互監,2026-10-24)
#
# 職責:
#   1. POST watch-dog /api/engine/trigger(Bearer TRIGGER_TOKEN)——CF cron dispatch
#      是 best-effort(區域事故丟拍至 12 分鐘實測),這條讓偵測引擎在 CF 排程
#      中斷期間照跑。端點內建 30s recency guard,CF cron 健康時自動 dedup。
#   2. 向 ops-control 回報 probe 狀態(host=rn1g-probe,sentinelOk=連續失敗數==0):
#      watch-dog 真死 → 這裡 sentinelOk=false → ops-control 既有「哨兵失敗」告警
#      (Slack+email-king 雙通道)接管——告警基礎設施集中在 ops-control,本腳本零告警邏輯。
#      rn1g 自己死 → heartbeat 停 → ops-control「離線」告警。雙向互監。
#
# 環境檔 ~/.watchdog-trigger.env(600):WATCHDOG_TRIGGER_URL / WATCHDOG_TRIGGER_TOKEN /
# OPS_URL / OPS_HOST_TOKEN。secret 值域 B,輪替兩處同步(wrangler secret put + env 檔)。
set -u
ENV_FILE="$HOME/.watchdog-trigger.env"
LOG="$HOME/logs/watchdog-trigger.log"
STATE="$HOME/sysWork/.wd-probe-state"
mkdir -p "$HOME/logs" "$(dirname "$STATE")"

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date -Is) env file missing: $ENV_FILE" >> "$LOG"
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

code=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -m 10 -X POST \
  -H "Authorization: Bearer $WATCHDOG_TRIGGER_TOKEN" \
  "$WATCHDOG_TRIGGER_URL" 2>/dev/null) || code=000

fails=0
[ -s "$STATE" ] && fails=$(cat "$STATE" 2>/dev/null) || true
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac

if [ "$code" = "200" ]; then
  fails=0
else
  fails=$((fails + 1))
  echo "$(date -Is) trigger http=$code body=$(head -c 120 "$BODY_FILE" 2>/dev/null)" >> "$LOG"
fi
echo "$fails" > "$STATE"

probe_ok=true
[ "$fails" -eq 0 ] || probe_ok=false

# best-effort 回報:ops-control 不可達不影響 trigger 職責(下分鐘再報)
curl -s -o /dev/null -m 8 -X POST "$OPS_URL/api/heartbeat" \
  -H "Authorization: Bearer $OPS_HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"rn1g-probe\",\"sentinelOk\":$probe_ok,\"internetOk\":true,\"powerFails\":$fails,\"sentinelIp\":\"watch-dog.worker\",\"iface\":\"cron\"}"

# log 防膨脹(>100KB 截到尾 50KB)
if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 100000 ]; then
  tail -c 50000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
