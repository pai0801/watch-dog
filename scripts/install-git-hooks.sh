#!/usr/bin/env bash
# 安裝 raw git hooks（pre-commit framework 不可用時的替代；bootstrap.sh 備援路徑）。
# pre-commit = §L/§M + secrets-archive（<5s）；pre-push = npm test 全量 gatekeeper。
set -euo pipefail
cd "$(dirname "$0")/.."

cat > .git/hooks/pre-commit <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
echo "[pre-commit] §L/§M + secrets-archive 檢查"
python3 scripts/check-manifest-gitignore.py
python3 scripts/check-secrets-coverage.py
bash secrets-archive/pre-commit-check.sh
echo "[pre-commit] ✓"
EOF

cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
# pre-push gatekeeper：全量測試（app 60 + guards §A–§K/D18–D21）。
# 緊急繞過唯有 --no-verify（[NEVER]，01-CLAUDE §0 CRITICAL）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
echo "[pre-push] npm test（app+guards 雙 pool）"
npm test
echo "[pre-push] ✓"
EOF

chmod +x .git/hooks/pre-commit .git/hooks/pre-push
echo "raw hooks installed: pre-commit, pre-push"
