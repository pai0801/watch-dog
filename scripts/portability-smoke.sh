#!/usr/bin/env bash
set -euo pipefail
# portability-smoke.sh — fresh-clone 可重建 smoke（.portability.toml [verify].script 真源，09 §1.3）
# deterministic 子集：typecheck + test + build dry-run（lint 與 §L/§M python guard 由 guard/CI stories 加入）。
# wrangler dev 為 foreground server，不在本腳本（手動另行）。
cd "$(dirname "$0")/.."

npm run typecheck
npm run lint
npm test
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir dist/smoke
python3 scripts/check-manifest-gitignore.py
python3 scripts/check-secrets-coverage.py

echo "== portability smoke 全綠：fresh-clone 可重建 =="
