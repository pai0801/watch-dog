#!/usr/bin/env bash
set -euo pipefail
# bootstrap for watch-dog — fresh-clone rebuild entry (09 §1.1)
cd "$(dirname "$0")/.."

npm install
npm run cf-typegen
