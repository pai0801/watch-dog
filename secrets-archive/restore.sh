#!/usr/bin/env bash
# 從 secrets-archive/env.7z 解出「當前 checkout」slice,還原 secret 檔到 repo 根。
# 用法:restore.sh [--env <checkout-name>]
# 既有同名檔先備份成 <file>.bak.<ts>。
# 密碼同 seal.sh:ENV_SECRET_PASS / ~/.config/env-tools.env / 互動提示。
set -euo pipefail

REPO_ROOT="$(pwd)"
ARCHIVE="$REPO_ROOT/secrets-archive/env.7z"
CHECKOUT="$(basename "$REPO_ROOT")"

# --env 覆寫
while [ $# -gt 0 ]; do
  case "$1" in
    --env) CHECKOUT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

get_pass() {
  if [ -n "${ENV_SECRET_PASS:-}" ]; then echo "$ENV_SECRET_PASS"; return; fi
  if [ -f "$HOME/.config/env-tools.env" ]; then
    local pw
    pw="$( set -a; . "$HOME/.config/env-tools.env" 2>/dev/null; echo "${ENV_SECRET_PASS:-}" )"
    if [ -n "$pw" ]; then echo "$pw"; return; fi
  fi
  printf 'password: ' >&2; read -rs pw; echo >&2
  [ -n "$pw" ] || { echo "no password" >&2; return 1; }
  echo "$pw"
}

[ -f "$ARCHIVE" ] || { echo "no archive: $ARCHIVE" >&2; exit 1; }
PASS="$(get_pass)"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if ! 7z x "-p$PASS" -mhe=on -o"$tmp" "$ARCHIVE" >/dev/null 2>&1; then
  echo "cannot decrypt $ARCHIVE (wrong password?)" >&2; exit 1
fi

slice="$tmp/$CHECKOUT"
[ -d "$slice" ] || { echo "no slice '$CHECKOUT' in archive. available:" >&2
  ls "$tmp" >&2; echo "hint: restore.sh --env <name>" >&2; exit 1; }

ts="$(date +%s)"
restored=0
while IFS= read -r f; do
  rel="${f#"$slice/"}"
  [ "$rel" = ".manifest" ] && continue
  if [ -e "$REPO_ROOT/$rel" ]; then cp "$REPO_ROOT/$rel" "$REPO_ROOT/$rel.bak.$ts"; fi
  mkdir -p "$REPO_ROOT/$(dirname "$rel")"
  cp "$f" "$REPO_ROOT/$rel"
  restored=$((restored+1))
done < <(find "$slice" -type f)

[ "$restored" -gt 0 ] || { echo "slice '$CHECKOUT' empty" >&2; exit 1; }
echo "restored $restored file(s) for '$CHECKOUT'"
