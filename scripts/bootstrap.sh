#!/usr/bin/env bash
set -euo pipefail
# bootstrap for watch-dog — fresh-clone 重建入口（.portability.toml [bootstrap].script，09 §1.1）
# SSoT 分工：本腳本是可執行真源；manifest 只聲明入口 + requires。
cd "$(dirname "$0")/.."

echo "== [0/5] 依賴檢查（.portability.toml [bootstrap].requires）=="
# 2026-09-04 fresh-clone 實測：wrangler 4.129 的 types/d1/dev 都硬擋 node<22；
# workerd（d1 --local / dev / app pool）另需 host glibc ≥ 2.32（Ubuntu ≥ 20.10）——
# glibc 不足時 [2/5] types 仍可生成、[4/5] d1 --local 會失敗（見 SECRETS.md 環境矩陣）。
node_ver_ok() { node -e "process.exit(require('semver').satisfies(process.version, '>=22') ? 0 : 1)" 2>/dev/null \
  || node -p "Number(process.versions.node.split('.')[0]) >= 22" 2>/dev/null | grep -q true; }
if command -v node >/dev/null 2>&1 && node_ver_ok; then
  :
else
  echo "  WARN: node ≥ 22 未達（當前 $(node -v 2>/dev/null || echo 未安裝)）——wrangler 4.129 會擋 [2/5] cf-typegen 起的所有步驟"
  echo "        免 sudo 解法：user-space tarball（recipe 見 secrets-archive/SECRETS.md 首次部署段）"
fi
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
