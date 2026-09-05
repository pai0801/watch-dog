#!/usr/bin/env bash
# enroll.sh — 一行接入新服務（操作者專用的「簡單控管」）。
# 做：openssl 生 token → admin API 建 project（含預設 self check）→ 印出 client 要貼的 env
#     → 記到 docs/tokens.local.md（gitignored，本地 token 清單——值 [NEVER] 進 committed 檔，
#     見 2026-02-02 docs/plans 洩漏事件與 pre-commit §1b 值級掃描）。
# 用法：scripts/enroll.sh <project-id> [display-name]
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 1 ] || { echo "用法: scripts/enroll.sh <project-id> [display-name]" >&2; exit 2; }
PROJECT_ID="$1"
DISPLAY_NAME="${2:-$PROJECT_ID}"
BASE_URL="${WATCHDOG_URL:-https://watch-dog.helperp.workers.dev}"

# 與 API 同款 charset（提前失敗，免得打了一次雲端才 400）
[[ "$PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || {
  echo "✗ project_id 格式：1-63 字小寫英數＋連字符，開頭須英數" >&2; exit 2;
}

# admin 帳密本地來源（與 seal/deploy 同一模型：值不出現在指令列參數、不進 git）
[ -f .env ] || { echo "✗ 找不到 .env（ADMIN_ACCOUNT/ADMIN_PASSWORD）——先用 secrets-archive/restore.sh 還原" >&2; exit 1; }
ADMIN_ACCOUNT="$(grep '^ADMIN_ACCOUNT=' .env | cut -d= -f2-)"
ADMIN_PW="$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"
[ -n "$ADMIN_ACCOUNT" ] && [ -n "$ADMIN_PW" ] || { echo "✗ .env 缺 ADMIN_ACCOUNT/ADMIN_PASSWORD" >&2; exit 1; }

TOKEN="$(openssl rand -hex 24)"

# 建立（302 = 成功 redirect 回 /admin；401 = 帳密不對）
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/admin/projects/new" \
  -u "$ADMIN_ACCOUNT:$ADMIN_PW" -H 'X-Requested-With: XMLHttpRequest' \
  --data-urlencode "project_id=$PROJECT_ID" \
  --data-urlencode "display_name=$DISPLAY_NAME" \
  --data-urlencode "token=$TOKEN")" || HTTP_CODE="000"
case "$HTTP_CODE" in
  200|302) ;;
  *) echo "✗ 建立失敗（HTTP $HTTP_CODE）——已存在？admin 帳密對嗎？（管理頁：$BASE_URL/admin）" >&2; exit 1;;
esac

# 本地 token 清單（gitignored；patterns 見 .gitignore）
REGISTRY="docs/tokens.local.md"
mkdir -p docs
[ -f "$REGISTRY" ] || echo "# 本地 token 清單（gitignored——值 [NEVER] 進 committed 檔）" > "$REGISTRY"
echo "| $PROJECT_ID | $DISPLAY_NAME | $TOKEN | $(date +%F) |" >> "$REGISTRY"

echo "✓ project 已建立：$PROJECT_ID（$BASE_URL/admin）"
echo ""
echo "── 貼進 client 專案的 .env / secrets：─────────────────"
echo "WATCHDOG_URL=$BASE_URL"
echo "WATCHDOG_PROJECT=$PROJECT_ID"
echo "WATCHDOG_TOKEN=$TOKEN"
echo "───────────────────────────────────────────────────────"
echo "token 已記錄：$REGISTRY（本地明文＋加密進 env.7z——同 .env 模型）"
# 清單有變動 → 自動 re-seal（無密碼來源時提示手動；pre-commit --check 會擋未 seal 的漂移）
if bash secrets-archive/seal.sh >/dev/null 2>&1; then
  echo "✓ env.7z 已 re-seal（記得 git add secrets-archive/env.7z）"
else
  echo "⚠ 無法自動 seal（無密碼來源）——commit 前手動跑 bash secrets-archive/seal.sh"
fi
unset ADMIN_PW TOKEN
