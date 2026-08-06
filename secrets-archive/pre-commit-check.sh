#!/usr/bin/env bash
# pre-commit:擋 secret 洩漏 + 擋「改 .env 沒 seal」。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0

# 1) gitignore 衛生:secret 檔不可被 staged;env.7z 必須可追蹤
for f in .env .dev.vars wrangler.toml wrangler.jsonc; do
  if git diff --cached --name-only -- "$f" | grep -q .; then
    echo "FAIL: plaintext secret file staged: $f"; status=1
  fi
done
if git check-ignore secrets-archive/env.7z >/dev/null 2>&1; then
  echo "FAIL: secrets-archive/env.7z is gitignored (must be committable)"; status=1
fi

# 2) 明文掃描:staged 檔內不可含 master 密碼(密碼來源同 seal.sh:get_pass)
if [ -z "${ENV_SECRET_PASS:-}" ] && [ -f "$HOME/.config/env-tools.env" ]; then
  ENV_SECRET_PASS="$( set -a; . "$HOME/.config/env-tools.env" 2>/dev/null; echo "${ENV_SECRET_PASS:-}" )"
fi
if [ -n "${ENV_SECRET_PASS:-}" ]; then
  while IFS= read -r staged; do
    if grep -qF "$ENV_SECRET_PASS" "$staged" 2>/dev/null; then
      echo "FAIL: master password found in staged file: $staged"; status=1
    fi
  done < <(git diff --cached --name-only --diff-filter=AM)
fi

# 3) seal-sync:改了 secret 沒 seal → 擋(密碼不可得時降級 warn,不擋)
if ! bash secrets-archive/seal.sh --check >/tmp/seal-check.$$ 2>&1; then
  cat /tmp/seal-check.$$
  status=1
fi
rm -f /tmp/seal-check.$$

exit $status
