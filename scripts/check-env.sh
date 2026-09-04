#!/usr/bin/env bash
set -euo pipefail
# check-env.sh — CI/部署環境前置檢查（hard-fail，無降級）。
# 用途：GitHub Actions self-hosted runner「跑起來才發現環境不對」的失敗
# 提前到第一步、給可行動訊息。與 pre-push/smoke 的「降級模式」互補：
#   - 開發機（glibc 2.31）→ 降級模式（hook/smoke 各自探測，見各腳本註解）
#   - CI runner / 部署環境 → 本腳本 hard-fail（這裡 [MUST] 是全量環境）
# node ≥ 22：wrangler 4.129 硬擋 <22（engines + 實測，2026-09-04）。
# glibc ≥ 2.32：workerd（app pool / wrangler dev / d1 --local）需要，
#   Ubuntu ≥ 20.10；本開發機 2.31 即因此無法本機跑 app pool。
# ldd 可用性：minimal 容器（distroless）可能缺 ldd——若缺則明講需手動確認。
cd "$(dirname "$0")/.."

fail=0

# 非數字輸出（異常 node）fail-closed 當 0 處理，不放行（實測 mock 揭露的 fail-open 邊角）。
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null | grep -oE '^[0-9]+$' || true)"
NODE_MAJOR="${NODE_MAJOR:-0}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ node $(node -v 2>/dev/null || echo '（未安裝）') < 22：wrangler 4.129 硬擋（engines 宣告 + 2026-09-04 實測）" >&2
  fail=1
fi

if command -v ldd >/dev/null 2>&1; then
  # pipefail 下 `ldd | head` 曾因 ldd 收 SIGPIPE 回 141 提前炸掉本腳本（實測）—— || true 隔離。
  LDD_LINE="$(ldd --version 2>/dev/null | head -1 || true)"
  GLIBC_MAJOR="$(echo "$LDD_LINE" | grep -oE '[0-9]+\.[0-9]+$' | cut -d. -f1)" || true
  GLIBC_MINOR="$(echo "$LDD_LINE" | grep -oE '[0-9]+\.[0-9]+$' | cut -d. -f2)" || true
  if [ "${GLIBC_MAJOR:-0}" -lt 2 ] || { [ "${GLIBC_MAJOR:-0}" -eq 2 ] && [ "${GLIBC_MINOR:-0}" -lt 32 ]; }; then
    echo "✗ glibc ${GLIBC_MAJOR}.${GLIBC_MINOR} < 2.32：workerd（app pool / dev / d1 --local）無法執行；Ubuntu ≥ 20.10 / 容器 glibc ≥ 2.32" >&2
    fail=1
  fi
else
  echo "⚠ 無 ldd：無法自動驗 glibc 版本（minimal 容器？）——請手動確認 ≥ 2.32（workerd 前置）" >&2
fi

if [ "$fail" -eq 1 ]; then
  echo "✗ 環境前置不符——修好再跑（詳情：SECRETS.md 環境限制表 / AGENTS.md）" >&2
  exit 1
fi
echo "✓ 環境前置 OK：node $(node -v) / glibc $(echo "$LDD_LINE" | grep -oE '[0-9]+\.[0-9]+$')"
