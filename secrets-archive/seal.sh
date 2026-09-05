#!/usr/bin/env bash
# 把「當前 checkout」的 secret 檔封進 secrets-archive/env.7z(保留其他 checkout slice)。
# 用法:seal.sh            # 打包
#       seal.sh --check   # seal-sync 檢核(給 pre-commit 用):pass=0, fail=非0
# 密碼:ENV_SECRET_PASS(環境變數 / ~/.config/env-tools.env / 互動提示)。不 hardcode。
# 風險註解:密碼經 -p 傳給 7z,單機 dev 環境 process-list 暴露面可接受(與 env-tools 同模型)。
set -euo pipefail

REPO_ROOT="$(pwd)"
ARCHIVE="$REPO_ROOT/secrets-archive/env.7z"
CHECKOUT="$(basename "$REPO_ROOT")"

# wrangler.toml/jsonc 本體是 tracked 公開配置(值走 wrangler secret put),不入 seal;
# 只封「機器本地值檔」:.env*/.dev.vars 與 wrangler env 變體(.example/.bak/.test 除外),
# 加 docs/tokens.local.md(scripts/enroll.sh 的本地 token 清單——同 .env 模型:本地明文+加密進 git)。
SECRET_PATTERNS=(".env*" ".dev.vars" "wrangler.*.toml" "wrangler.*.jsonc" "docs/tokens.local.md")
EXCLUDE_RE='(\.example|\.bak|\.test)(\..*)?$'

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

collect_files() {
  local f pat
  shopt -s nullglob dotglob
  for pat in "${SECRET_PATTERNS[@]}"; do
    for f in $pat; do
      [ -f "$f" ] || continue
      [[ "$f" =~ $EXCLUDE_RE ]] && continue
      case "$f" in secrets-archive/*) continue;; esac
      printf '%s\n' "$f"
    done
  done
  shopt -u nullglob dotglob
}

# ---------- --check (seal-sync) ----------
if [ "${1:-}" = "--check" ]; then
  PASS="$(get_pass </dev/null 2>/dev/null)" || { echo "WARN: seal-sync skipped (no password)"; exit 0; }
  [ -f "$ARCHIVE" ] || { echo "FAIL: $ARCHIVE missing (run seal.sh first)"; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  if ! 7z x "-p$PASS" -mhe=on -o"$tmp" "$ARCHIVE" >/dev/null 2>&1; then
    echo "FAIL: cannot decrypt $ARCHIVE (wrong password?)"; exit 1
  fi
  manifest="$tmp/$CHECKOUT/.manifest"
  [ -f "$manifest" ] || { echo "FAIL: no .manifest for '$CHECKOUT' (run seal.sh first)"; exit 1; }

  # 1) manifest 內每檔 hash 必須 = 當前 hash
  while read -r h f; do
    [ -n "$f" ] || continue
    if [ ! -f "$REPO_ROOT/$f" ]; then echo "FAIL: $f vanished since last seal — run seal.sh"; exit 1; fi
    cur="$(sha256sum "$REPO_ROOT/$f" | cut -d' ' -f1)"
    [ "$cur" = "$h" ] || { echo "FAIL: $f changed since last seal — run secrets-archive/seal.sh"; exit 1; }
  done < "$manifest"

  # 2) reverse:當前檔集合必須 = manifest 檔集合(抓新增/移除)
  cur_files="$(collect_files | sort)"
  man_files="$(awk '{print $2}' "$manifest" | sort)"
  if ! diff <(printf '%s\n' "$cur_files") <(printf '%s\n' "$man_files") >/dev/null; then
    echo "FAIL: secret file set changed since last seal — run secrets-archive/seal.sh"; exit 1
  fi

  echo "OK: seal-sync ($CHECKOUT)"; exit 0
fi

# ---------- pack ----------
PASS="$(get_pass)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
content="$tmp/content"; mkdir -p "$content"

if [ -f "$ARCHIVE" ]; then
  if ! 7z x "-p$PASS" -mhe=on -o"$content" "$ARCHIVE" >/dev/null 2>&1; then
    echo "cannot decrypt existing $ARCHIVE (wrong password?)" >&2; exit 1
  fi
fi

slice="$content/$CHECKOUT"; mkdir -p "$slice"
rm -rf "$slice"/* "$slice"/.[!.]* 2>/dev/null || true   # 重建此 slice

files="$(collect_files)"
if [ -z "$files" ]; then echo "no secret files found to seal"; exit 1; fi

while IFS= read -r f; do
  mkdir -p "$slice/$(dirname "$f")"
  cp "$REPO_ROOT/$f" "$slice/$f"
done <<< "$files"

# .manifest:每行  <sha256>  <relpath>
: > "$slice/.manifest"
while IFS= read -r f; do
  printf '%s  %s\n' "$(sha256sum "$REPO_ROOT/$f" | cut -d' ' -f1)" "$f" >> "$slice/.manifest"
done <<< "$files"

rm -f "$ARCHIVE"
# 注意:rm + 7z a 非原子;同一 checkout 請勿並發跑 seal.sh(可能產生損壞 archive)。
( cd "$content" && 7z a "-p$PASS" -mhe=on "$ARCHIVE" . ) >/dev/null
echo "sealed '$CHECKOUT' → secrets-archive/env.7z"
echo "next: git add secrets-archive/env.7z && git commit"
