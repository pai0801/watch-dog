#!/usr/bin/env python3
"""check-manifest-gitignore.py — §L: [machine_local].files ↔ .gitignore coherence。

正向 FAIL: [machine_local].files 每個 pattern 必須 gitignored(列了 tracked 檔 = 備份冗餘/secret 洩)。
反向 FAIL: disk 上 gitignored 的 secret-ish 檔必須被某 manifest pattern 涵蓋(漏 = 換機遺失)。

真源: references/PORTABILITY-GUARDS.md §L(拷貝進本 repo,vendored)。
用法: check-manifest-gitignore.py [<repo-dir>]      # 預設 cwd,檢查該 repo
      check-manifest-gitignore.py --selftest         # 內建 fixture 自測(跨棧 portable)
exit: 0 一致 / 1 違規(印明細) / 2 設定錯誤(無 .portability.toml 等)。
"""
from __future__ import annotations
import fnmatch, glob, os, subprocess, sys, tempfile, tomllib

SECRETISH_GLOBS = (".env", ".env.*", ".dev.vars", "wrangler*.toml", "wrangler*.jsonc")


def _is_transient(rel: str) -> bool:
    """暫存/衍生檔,非 source-of-truth → 不該進備份清單,反向檢查略過。

    - *.example:committed placeholder(無值範本)。
    - *.bak.* / *.bak[-_...]:seal 還原(restore.sh)前自動產生的暫存備份
      (<name>.bak.<ts>),以及 *.bak-pre-* / *.bak_* 等歷史命名變體;
      source(.env 本身)已在 manifest,.bak 是冗餘衍生品,遺失無害 → 備份它反而是冗餘。
    """
    lower = rel.lower()
    return (lower.endswith(".example")
            or ".bak." in lower or ".bak-" in lower or ".bak_" in lower
            or lower.endswith(".bak"))


def _patterns_from_manifest(repo: str) -> list[str]:
    pf = os.path.join(repo, ".portability.toml")
    if not os.path.isfile(pf):
        return []  # 無 manifest → caller 決定(檢查模式 exit 2;selftest fixture 控制)
    with open(pf, "rb") as f:
        data = tomllib.load(f)
    pats = (data.get("machine_local") or {}).get("files") or []
    return [p for p in pats if isinstance(p, str) and p]


def _ignored(repo: str, path: str) -> bool:
    """git check-ignore path(在 repo 內);exit 0 = ignored。"""
    r = subprocess.run(["git", "-C", repo, "check-ignore", "--quiet", path],
                       capture_output=True)
    return r.returncode == 0


def _concrete(pattern: str) -> str:
    """glob pattern → 一個符合它的具體路徑,供 git check-ignore 測試。"""
    return pattern.replace("*", "MATCH").replace("?", "X") or pattern


def check(repo: str) -> list[str]:
    """回傳違規明細(空 = 一致)。"""
    patterns = _patterns_from_manifest(repo)
    if not patterns:
        return ["[§L] 無 .portability.toml 或 [machine_local].files 為空(§C 應先擋存在性)"]
    violations: list[str] = []

    # 正向:每個 manifest pattern 必須 gitignored
    for p in patterns:
        if not _ignored(repo, _concrete(p)):
            violations.append(
                f"[§L 正向] manifest 列 '{p}' 但未被 .gitignore 涵蓋"
                f"(= tracked 檔 → 備份冗餘,或 secret 已洩進 git)。修:.gitignore 加 {p},或從 [machine_local].files 移除。")

    # 反向:disk 上 gitignored secret-ish 檔必須被某 manifest pattern 涵蓋
    candidates = set()
    for g in SECRETISH_GLOBS:
        for hit in glob.glob(os.path.join(repo, g)):
            rel = os.path.relpath(hit, repo)
            if not _is_transient(rel):
                candidates.add(rel)
    for c in sorted(candidates):
        if _ignored(repo, c) and not any(fnmatch.fnmatch(c, p) for p in patterns):
            violations.append(
                f"[§L 反向] '{c}' 被 .gitignore 但不在 [machine_local].files"
                f"(= 漏備份 → 換機遺失)。修:[machine_local].files 加 {c}。")

    return violations


def selftest() -> int:
    cases = [
        # (name, gitignore_lines, manifest_files, disk_files, expect_exit)
        ("reverse-fail", ["wrangler.toml"], [".env"], [".env", "wrangler.toml"], 1),
        ("forward-fail", [], ["config.json"], ["config.json"], 1),
        ("clean-pass", [".env", ".dev.vars", "wrangler.toml"],
         [".env", ".dev.vars", "wrangler.toml"], [".env", ".dev.vars", "wrangler.toml"], 0),
        ("example-no-falsepositive", [".env", ".env.*", "!.env.example"],
         [".env", ".env.*"], [".env", ".env.example"], 0),
        ("bak-no-falsepositive", [".env", ".env.bak.*"],
         [".env"], [".env", ".env.bak.20260731125816"], 0),
        ("bak-dash-no-falsepositive", [".env", ".env.bak*"],
         [".env"], [".env", ".env.bak-pre-onnx"], 0),
    ]
    fails = 0
    for name, gi, mf, disk, expect in cases:
        d = tempfile.mkdtemp(prefix=f"§L-{name}-")
        subprocess.run(["git", "-C", d, "init", "--quiet"], check=True)
        with open(os.path.join(d, ".gitignore"), "w") as f:
            f.write("\n".join(gi) + "\n")
        with open(os.path.join(d, ".portability.toml"), "w") as f:
            f.write("[machine_local]\nfiles = [" + ", ".join(f'"{x}"' for x in mf) + "]\n")
        for df in disk:
            open(os.path.join(d, df), "w").close()
        v = check(d)
        got = 1 if v else 0
        # forward-fail/clean-pass 的 disk 檔需 tracked 才能 git check-ignore 判定非 ignored;
        # git init 後未 commit → check-ignore 仍依 .gitignore 判定,OK。
        status = "✓" if got == expect else "✗"
        if got != expect:
            fails += 1
            print(f"{status} {name}: expect exit {expect}, got {got}; violations={v}")
        else:
            print(f"{status} {name}: exit {got}")
    print(f"selftest: {len(cases) - fails}/{len(cases)} passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    repo = os.path.abspath(argv[1]) if len(argv) == 2 else os.getcwd()
    if not os.path.isfile(os.path.join(repo, ".portability.toml")):
        print(f"[§L] {repo} 無 .portability.toml(§C 應先擋)", file=sys.stderr)
        return 2
    v = check(repo)
    if v:
        print("\n".join(v), file=sys.stderr)
        return 1
    print(f"[§L] {os.path.basename(repo)} manifest↔gitignore 一致 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
