#!/usr/bin/env bash
set -euo pipefail
# portability-smoke.sh — fresh-clone 可重建 smoke（.portability.toml [verify].script 真源，09 §1.3）
# deterministic：typecheck + lint + test（雙 pool）+ build dry-run + §L/§M python guard。
# wrangler dev 為 foreground server，不在本腳本（手動另行）。
cd "$(dirname "$0")/.."

npm run typecheck
npm run lint
npm test
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir dist/smoke
python3 scripts/check-manifest-gitignore.py
python3 scripts/check-secrets-coverage.py

echo "== portability smoke 全綠：fresh-clone 可重建 =="
