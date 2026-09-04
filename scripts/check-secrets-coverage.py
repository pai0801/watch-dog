#!/usr/bin/env python3
"""check-secrets-coverage.py — §M: code「讀」的 SECRETISH ↔ env 檔變數 雙向 parity。

真源: references/PORTABILITY-GUARDS.md §M(拷貝進本 repo,vendored)。

精準版:只匹配「secret 讀取模式」(env.X / process.env.X / os.getenv(X) / os.environ[X]),
不匹配註解/型別/字串裡的裸名稱(避 FP)。runtime 範圍(src/workers/functions/lib/api),
排除 scripts/(setup/seed/demo/bootstrap,非 request-path)+ tests/build/deps。

正向 FAIL: runtime code「讀」的 SECRETISH 名必須在 .env/.dev.vars/wrangler.* 或 allowlist。
反向 WARN: env 檔的 SECRETISH var 應被 code 讀(或在 allowlist),否則陳年漂。

用法: check-secrets-coverage.py [<repo-dir>] | --selftest
exit: 0 一致 / 1 正向違規(缺 secret) / 2 設定錯誤
"""
from __future__ import annotations
import glob, os, re, sys, tempfile

# secret「讀取」模式:process.env.X / env.X(CF c.env.X 含 .env.X)/ os.environ['X'] / os.getenv('X')
READ_PATTERN = re.compile(
    r"(?:process\.env|os\.environ|os\.getenv|os\.Getenv|getenv|\.env|env)"
    r"\s*(?:\.\s*|\[\s*['\"]?|\(\s*['\"]?)"
    r"([A-Z][A-Z0-9_]{2,})"
)
# 何謂 secret-ish 名(同 §H/§J):過濾 READ_PATTERN 抓到的名,只留真的像 secret 的。
SECRETISH_SUFFIX = re.compile(
    r"_(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|M2M_ID|M2M_SECRET|APP_ID|APP_SECRET|ORG_ID)$"
)
ENV_FILES = (".env", ".dev.vars", ".env.local", ".env.*", "wrangler*.toml", "wrangler*.jsonc")
EXCLUDE_DIRS = ("node_modules", ".venv", ".git", "dist", "build", ".wrangler", ".cloudflare",
                "tests", "test", "__tests__", "scripts")  # scripts=setup/seed/demo/bootstrap(非 runtime)
EXCLUDE_SUFFIX = (".example", ".bak", ".test", ".fixture", ".sample", ".md", ".d.ts")
CODE_GLOBS = ("src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "workers/**/*.ts", "**/*.py",
              "functions/**/*.ts", "lib/**/*.ts", "lib/**/*.py", "api/**/*.ts")


def _is_excluded(path: str) -> bool:
    lower = "/" + path.lower() + "/"
    if any(f"/{seg}/" in lower for seg in EXCLUDE_DIRS):
        return True
    return lower.endswith(EXCLUDE_SUFFIX)


def _code_secret_reads(repo: str) -> set[str]:
    """runtime code 實際「讀」的 SECRETISH 名(只匹配讀取模式,不匹配註解/字串裸名)。"""
    names: set[str] = set()
    for g in CODE_GLOBS:
        for hit in glob.glob(os.path.join(repo, g), recursive=True):
            if not os.path.isfile(hit) or _is_excluded(hit):
                continue
            try:
                content = open(hit, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for m in READ_PATTERN.findall(content):
                if SECRETISH_SUFFIX.search(m):
                    names.add(m)
    return names


def _env_var_names(repo: str) -> set[str]:
    vars_: set[str] = set()
    for pat in ENV_FILES:
        for hit in glob.glob(os.path.join(repo, pat)):
            if not os.path.isfile(hit) or _is_excluded(os.path.basename(hit)):
                continue
            try:
                for line in open(hit, encoding="utf-8"):
                    s = line.strip()
                    if not s or s.startswith("#") or "=" not in s:
                        continue
                    raw = s.split("=", 1)[0].strip()
                    key = raw.replace("export ", "").split()[0] if raw else ""
                    if key and key.replace("_", "").isupper():
                        vars_.add(key)
            except (OSError, UnicodeDecodeError):
                continue
    return vars_


def _optional(repo: str) -> set[str]:
    names: set[str] = set()
    opt = os.path.join(repo, ".secrets-optional")
    if os.path.isfile(opt):
        for line in open(opt, encoding="utf-8"):
            s = line.strip()
            if s and not s.startswith("#"):
                names.add(s)
    for g in CODE_GLOBS:
        for hit in glob.glob(os.path.join(repo, g), recursive=True):
            if not os.path.isfile(hit) or _is_excluded(hit):
                continue
            try:
                names.update(re.findall(r"§M-optional:\s*([A-Z][A-Z0-9_]{2,})", open(hit, encoding="utf-8").read()))
            except (OSError, UnicodeDecodeError):
                continue
    return names


def check(repo: str) -> tuple[list[str], list[str]]:
    code_reads = _code_secret_reads(repo)
    env_vars = {v for v in _env_var_names(repo) if SECRETISH_SUFFIX.search(v)}
    opt = _optional(repo)
    forward = sorted(n for n in code_reads if n not in env_vars and n not in opt)
    reverse = sorted(v for v in env_vars if v not in code_reads and v not in opt)
    return forward, reverse


def selftest() -> int:
    cases = [
        ("clean", {"src/a.ts": "const k = env.FOO_API_KEY;"}, {".env": "FOO_API_KEY=xxx"}, [], []),
        ("forward-fail", {"src/a.ts": "process.env.BAR_TOKEN"}, {".env": "OTHER=1"}, [], ["BAR_TOKEN"]),
        ("optional-ok", {"src/a.ts": "process.env.OPT_SECRET"}, {".env": ""}, ["OPT_SECRET"], []),
        ("comment-not-flagged", {"src/a.ts": "// uses PROVISION_TOKEN here\nno read"}, {".env": ""}, [], []),
        ("max-tokens-not-secretish", {"src/a.ts": "env.MAX_TOKENS"}, {".env": ""}, [], []),
        ("python-getenv", {"app/x.py": "v = os.getenv('DB_PASSWORD')"}, {".env": "DB_PASSWORD=p"}, [], []),
        ("scripts-excluded", {"scripts/seed.ts": "env.SEED_API_KEY"}, {".env": ""}, [], []),
    ]
    fails = 0
    for name, code, env, opt, exp_fwd in cases:
        d = tempfile.mkdtemp(prefix=f"§M-{name}-")
        for p, c in code.items():
            os.makedirs(os.path.join(d, os.path.dirname(p)) or d, exist_ok=True)
            open(os.path.join(d, p), "w").write(c)
        for p, c in env.items():
            open(os.path.join(d, p), "w").write(c)
        if opt:
            open(os.path.join(d, ".secrets-optional"), "w").write("\n".join(opt) + "\n")
        fwd, rev = check(d)
        ok_ = fwd == exp_fwd
        print(f"{'✓' if ok_ else '✗'} {name}: forward={fwd} reverse={rev}")
        if not ok_:
            fails += 1
    print(f"selftest: {len(cases) - fails}/{len(cases)} passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    repo = os.path.abspath(argv[1]) if len(argv) == 2 else os.getcwd()
    fwd, rev = check(repo)
    if fwd:
        print("[§M 正向] runtime code 讀但 env 檔/allowlist 缺的 SECRETISH:\n  " + "\n  ".join(fwd), file=sys.stderr)
        return 1
    if rev:
        print(f"[§M 反向 warn] env 檔有但 code 不讀(陳年 secret?輪替候選):\n  " + "\n  ".join(rev))
    else:
        print(f"[§M] {os.path.basename(repo)} code↔env SECRETISH parity 一致 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
