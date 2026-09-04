#!/usr/bin/env bash
# pre-commit:擋 secret 洩漏 + 擋「改 .env 沒 seal」。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0

# 1) gitignore 衛生:secret「值」檔不可被 staged;env.7z 必須可追蹤。
#    wrangler.toml/jsonc 本體是 tracked 公開配置(secret 只放「名稱」、值一律 wrangler secret put),
#    不做檔名級禁令(否則永遠無法 commit),改由 1b) 值級掃描把關。
for f in $(git diff --cached --name-only --diff-filter=ACMR); do
  case "$f" in
    .env|.env.*|.dev.vars|wrangler.*.toml|wrangler.*.jsonc)
      if [[ ! "$f" =~ (\.example|\.bak|\.test)(\..*)?$ ]]; then
        echo "FAIL: plaintext secret file staged: $f"; status=1
      fi
      ;;
  esac
done
if git check-ignore secrets-archive/env.7z >/dev/null 2>&1; then
  echo "FAIL: secrets-archive/env.7z is gitignored (must be committable)"; status=1
fi

# 1b) tracked wrangler 配置值級掃描:SECRETISH 形態的鍵不可攜帶非空值(名稱清單合法)。
#     只掃存在的檔——grep 對「部分檔不存在但其他檔有匹配」回 exit 2,if 會走假分支。
cfg_files=""
for f in wrangler.toml wrangler.jsonc; do [ -f "$f" ] && cfg_files="$cfg_files $f"; done
if [ -n "$cfg_files" ] && grep -nE '(^|["'"'"'])[A-Z][A-Z0-9_]{2,}(["'"'"'][[:space:]]*:[[:space:]]*["'"'"']|[[:space:]]*=[[:space:]]*["'"'"'])[^"'"'"']+' $cfg_files; then
  echo "FAIL: wrangler config carries a secret VALUE (names only; values via wrangler secret put — 10-SECRETS-CONTRACT)"; status=1
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
seal_out="$(mktemp)"
if ! bash secrets-archive/seal.sh --check >"$seal_out" 2>&1; then
  cat "$seal_out"
  status=1
fi
rm -f "$seal_out"

exit $status
