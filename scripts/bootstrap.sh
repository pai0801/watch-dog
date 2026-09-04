#!/usr/bin/env bash
set -euo pipefail
# bootstrap for watch-dog — fresh-clone 重建入口（.portability.toml [bootstrap].script，09 §1.1）
# SSoT 分工：本腳本是可執行真源；manifest 只聲明入口 + requires。
cd "$(dirname "$0")/.."

echo "== [0/5] 依賴檢查（.portability.toml [bootstrap].requires）=="
command -v node >/dev/null 2>&1 || { echo "FAIL: node 未安裝（requires node>=20）"; exit 1; }
command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 \
  || echo "  WARN: 7z 未安裝——secrets-archive restore/seal 需要（restore.sh 會硬失敗）"
python3 -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null \
  || echo "  WARN: python>=3.11 未達——§L/§M guard（portability-smoke）會硬失敗"

echo "== [1/5] npm install =="
npm install

echo "== [2/5] cf-typegen =="
npm run cf-typegen

echo "== [3/5] 本機 secret 還原（自包含模型，secrets-archive/）=="
if [ ! -f .dev.vars ]; then
  if [ -f secrets-archive/env.7z ]; then
    bash secrets-archive/restore.sh
  else
    cp .dev.vars.example .dev.vars
    echo "  無 env.7z（尚未首次 seal）→ 以 .dev.vars.example 假值建立 .dev.vars（local dev 前填入真 ADMIN_TOKEN）"
  fi
fi

echo "== [4/5] D1 local schema（src/db.sql，CREATE TABLE IF NOT EXISTS 冪等）=="
WRANGLER_SEND_METRICS=false npx wrangler d1 execute DB --local --file src/db.sql

echo "== [5/5] git hooks =="
if [ -f scripts/install-git-hooks.sh ]; then
  bash scripts/install-git-hooks.sh
else
  echo "  scripts/install-git-hooks.sh 尚未建立（CI/CD story）——跳過"
fi

echo "== bootstrap 完成；驗收入口：bash scripts/portability-smoke.sh =="
