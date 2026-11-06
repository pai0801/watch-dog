#!/usr/bin/env bash
# scripts/ship-check.sh — D29 ship-check gate（07 §5.4 / 02 §5.5）
# 進 main 前的三項檢查；任一失敗 exit 1（[NEVER] push 到 main）。
#   1. operating-context current：README「Last verified:」日期距今 ≤ 30 天
#   2. 無 CRITICAL-unverified rule：TODO-REVIEW 無「Critical」且未標已解決的行
#   3. documentation set present：documentation/ 核心 5 檔＋deployment.md 就位
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1. operating-context current（README Last verified 新鮮度）
last_verified=$(grep -oE 'Last verified: [0-9]{4}-[0-9]{2}-[0-9]{2}' README.md | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)
if [ -z "$last_verified" ]; then
  echo "✗ ship-check 1: README.md 無 'Last verified:' 標記（D36 #6）"; fail=1
else
  lv_s=$(date -d "$last_verified" +%s)
  now_s=$(date +%s)
  age_days=$(( (now_s - lv_s) / 86400 ))
  if [ "$age_days" -gt 30 ]; then
    echo "✗ ship-check 1: README Last verified（$last_verified）已 ${age_days} 天——operating context 過期"; fail=1
  else
    echo "✓ ship-check 1: README Last verified $last_verified（${age_days}d）"
  fi
fi

# 2. 無未解決 Critical（TODO-REVIEW 含 Critical 分類且未標已清償的行）
critical_open=$(grep -nE '\| *Critical *\||\bCritical\b' TODO-REVIEW.md | grep -vE '已清償|Critical 0' || true)
if [ -n "$critical_open" ]; then
  echo "✗ ship-check 2: TODO-REVIEW 有未解決 Critical:"; echo "$critical_open"; fail=1
else
  echo "✓ ship-check 2: 無未解決 Critical"
fi

# 3. documentation set present（D26 核心 5＋D35）
for f in architecture flows permissions variables tests; do
  if [ ! -f "documentation/$f.md" ]; then
    echo "✗ ship-check 3: documentation/$f.md 缺（D26 核心集）"; fail=1
  fi
done
if [ ! -f documentation/deployment.md ] && [ ! -f docs/DEPLOYMENT.md ]; then
  echo "✗ ship-check 3: deployment.md 缺（D35）"; fail=1
fi
[ "$fail" -eq 0 ] && echo "✓ ship-check 3: documentation 核心 5＋deployment 就位"

if [ "$fail" -ne 0 ]; then
  echo "SHIP-CHECK FAILED — [NEVER] push 到 main（07 §5.4）"
  exit 1
fi
echo "ship-check PASSED ✅"
