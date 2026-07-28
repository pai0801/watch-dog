#!/usr/bin/env bash
set -euo pipefail
# portability smoke for watch-dog (09 §1.1 verify)
cd "$(dirname "$0")/.."

npm run dev → curl /health
