#!/usr/bin/env bash
set -euo pipefail
# portability-smoke.sh — fresh-clone 可重建 smoke（.portability.toml [verify].script 真源，09 §1.3）
# deterministic：typecheck + lint + test（雙 pool）+ build dry-run + §L/§M python guard。
# wrangler dev 為 foreground server，不在本腳本（手動另行）。
cd "$(dirname "$0")/.."

# §L/§M 需 tomllib（py≥3.11）——挑可用 python（scripts/pick-python.sh 單一真相源）。
PY="$(bash scripts/pick-python.sh)"

npm run typecheck
npm run lint

# 環境探測（與 pre-push hook 同模式）：app pool 跑在 workerd（glibc ≥ 2.32）。
# 不可執行時降級為 guards-only，大聲標示——app pool [MUST] 在 glibc ≥ 2.32 環境
# （CI runner / 容器）補全量，且本腳本的全綠輸出在降級模式下不代表全量已驗。
if [ -x node_modules/.bin/workerd ] && node_modules/.bin/workerd --version >/dev/null 2>&1; then
  npm test
else
  echo "[smoke] ⚠  降級模式：workerd 不可執行（host glibc < 2.32 或未 install）——app pool 無法本機執行，僅跑 guards"
  npm run test:guards
  echo "[smoke] ⚠  app pool [MUST] 由 glibc ≥ 2.32 環境補全量（CI/容器）；本輪全綠 ≠ 全量已驗"
fi

# deploy dry-run 需 node ≥ 22（wrangler 4.129 硬擋 <22）——檢查後跑或明確跳過。
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -ge 22 ]; then
  WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir dist/smoke
else
  echo "[smoke] ⚠  跳過 deploy dry-run：node $(node -v) < 22（wrangler 4.129 硬擋；部署環境前置見 SECRETS.md）"
fi

$PY scripts/check-manifest-gitignore.py
$PY scripts/check-secrets-coverage.py

echo "== portability smoke 完成（降級狀態見上方 ⚠ 標示）=="
