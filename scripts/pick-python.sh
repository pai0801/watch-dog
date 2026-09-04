#!/usr/bin/env bash
set -euo pipefail
# pick-python.sh — 挑 tomllib-capable python（§L/§M guard 需 py≥3.11）。
# Makefile / portability-smoke.sh / install-git-hooks.sh 共用的單一真相源
# （原三處各自 inline，曾各自漂移：盲目 fallback vs 探測後 fallback）。
# python3 有 tomllib → python3；否則 python3.12（在 PATH 且有 tomllib）→ 用它；
# 都沒有 → 輸出 python3，讓呼叫點以明確錯誤失敗（fail-loud，不靜默挑壞直譯器）。
if python3 -c "import tomllib" >/dev/null 2>&1; then
  echo python3
elif command -v python3.12 >/dev/null 2>&1 && python3.12 -c "import tomllib" >/dev/null 2>&1; then
  echo python3.12
else
  echo python3
fi
