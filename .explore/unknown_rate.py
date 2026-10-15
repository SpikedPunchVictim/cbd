#!/usr/bin/env python3
"""CBD pre-mortem #2: estimate the commit-level `mode: all` rate under
`unknownPolicy: 'all'` (CBD.md section 8.3, row 7).

READ-ONLY. Shells out to `git log --name-status` in each target repo and
classifies each changed file into one of:

  ignored    outside the include prefixes, or excluded (e.g. *.d.ts)
  test       test file -> rule 3 selects the file's tests, never mode:all
  code       runtime JS/TS that V8 can see -> rules 4-6 apply
  typesonly  .ts with no runtime statements (heuristic) -> V8-invisible
  asset      non-executable asset still under include (.css .svg .html .md)
  data       data file V8 cannot see (.json .sql .yaml .snap .txt ...)
  alwaysall  package.json / lockfile / tsconfig -> rule 1, policy not blindness

A commit is counted as `mode: all` if any changed file matching `include`
lands in {typesonly, asset, data, alwaysall} -- i.e. CBD cannot answer for it.
We report that rate, then again with `asset` removed, to isolate how much of
it is pure noise (a .css change cannot affect a Node test).

Usage: python3 -I unknown_rate.py [--commits N] [--json OUT] <repo:include> ...
"""

import argparse
import json
import re
import subprocess
import sys
from collections import Counter

# ---- classification ------------------------------------------------------

RUNTIME_RE = re.compile(
    r"^\s*(?:export\s+)?(?:declare\s+|abstract\s+|public\s+|private\s+)*"
    r"(?:async\s+)?(?:function|class|const|let|var|enum)\b"
    r"|^\s*(?:export\s+)?(?:default\s+)?(?:class|function)\b"
    r"|^\s*(?:export\s+)?(?:\*|type\s*\{|\{|\w+\s*(?:,|\}|from))"   # value (re-)export
    r"|=>|^\s*(?:if|for|while|switch|try|return|throw)\b"
)
TYPE_ONLY_RE = re.compile(
    r"^\s*(?:export\s+)?(?:declare\s+)?"
    r"(?:interface|type|namespace)\b"
    r"|^\s*import\s+type\b"
    r"|^\s*(?:export\s+)?(?:const|declare\s+const)\s+enum\b"
)
TEST_RE = re.compile(
    r"(?:^|/)(?:test|tests|__tests__|testing|e2e|spec)(?:/|$)"
    r"|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$"
)
ALWAYSALL_RE = re.compile(
    r"(?:^|/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|package\.json"
    r"|tsconfig[^/]*\.json|Cargo\.lock|go\.sum)$"
    r"|(?:^|/)migrations?/"
)
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
ASSET_EXT = {".css", ".scss", ".less", ".svg", ".html", ".htm", ".md", ".mdx",
             ".png", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ttf", ".ico"}
DATA_EXT = {".json", ".jsonc", ".json5", ".sql", ".yaml", ".yml", ".snap",
            ".txt", ".csv", ".xml", ".toml", ".env", ".sqlite", ".wasm",
            ".graphql", ".gql", ".proto", ".sh", ".ps1", ".bat"}


def ext_of(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    return ("." + base.rsplit(".", 1)[-1].lower()) if "." in base else ""


def is_type_only(abs_path: str) -> bool:
    """Heuristic: a .ts file whose content has no runtime statement.

    Strips comments and blank lines, then asks whether any remaining line
    starts a runtime construct. Type-only modules are never loaded by the
    emitted JS (TS elides the import), so V8 never sees them.
    """
    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
    except OSError:
        return False
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    lines = [ln for ln in src.splitlines()
             if ln.strip() and not ln.strip().startswith("//")]
    if not lines:
        return True
    saw_type = False
    for ln in lines:
        if RUNTIME_RE.search(ln):
            return False
        if TYPE_ONLY_RE.search(ln):
            saw_type = True
    return saw_type


def classify(repo: str, path: str, status: str, includes) -> str:
    if not any(path.startswith(p) for p in includes):
        return "ignored"
    # `exclude` defaults from CBD.md 9.3
    if path.endswith(".d.ts") or "/generated/" in path:
        return "ignored"
    if ALWAYSALL_RE.search(path):
        return "alwaysall"
    if TEST_RE.search(path):
        return "test"
    e = ext_of(path)
    if e in CODE_EXT:
        if e in (".ts", ".tsx", ".mts", ".cts") and status != "D":
            return "typesonly" if is_type_only(f"{repo}/{path}") else "code"
        return "code"
    if e in ASSET_EXT:
        return "asset"
    if e in DATA_EXT:
        return "data"
    return "data"          # unknown extension under include: still unseen by V8


# ---- git ----------------------------------------------------------------

def sample_commits(repo: str, n: int, ref: str = "HEAD"):
    """Yield (sha, [(status, path), ...]) for the last n non-merge commits at ref."""
    out = subprocess.run(
        ["git", "-C", repo, "log", ref, f"-{n}", "--no-merges",
         "--name-status", "--format=%x00%H"],
        capture_output=True, text=True, check=True,
    ).stdout
    cur, files = None, []
    for line in out.splitlines():
        if line.startswith("\x00"):
            if cur is not None:
                yield cur, files
            cur, files = line[1:], []
        elif line.strip() and cur is not None:
            parts = line.split("\t")
            if len(parts) >= 2:
                files.append((parts[0][0], parts[-1]))   # R100 old new -> new
    if cur is not None:
        yield cur, files


def analyse(repo: str, includes, limit: int, ref: str = "HEAD"):
    per_class = Counter()
    reasons = Counter()
    total = commits = all_mode = all_mode_no_asset = 0
    examples = {}
    flags = []
    for sha, files in sample_commits(repo, limit, ref):
        commits += 1
        seen = set()
        kinds = set()
        for status, path in files:
            if path in seen:
                continue
            seen.add(path)
            c = classify(repo, path, status, includes)
            kinds.add(c)
            per_class[c] += 1
            total += 1
            if c in ("typesonly", "asset", "data", "alwaysall"):
                reasons[(c, ext_of(path) or "<none>")] += 1
                examples.setdefault((c, ext_of(path) or "<none>"), (sha[:8], path))
        if kinds & {"typesonly", "asset", "data", "alwaysall"}:
            all_mode += 1
        if kinds & {"typesonly", "data", "alwaysall"}:
            all_mode_no_asset += 1
        flags.append((bool(kinds & {"typesonly", "asset", "data", "alwaysall"}),
                      bool(kinds & {"typesonly", "data", "alwaysall"}),
                      bool(kinds & {"typesonly", "data"})))
    return {
        "repo": repo, "ref": ref, "commits": commits, "files": total,
        "per_class": dict(per_class),
        "all_mode": all_mode,
        "all_mode_no_asset": all_mode_no_asset,
        "all_mode_rate": round(all_mode / commits, 3) if commits else None,
        "all_mode_rate_no_asset": round(all_mode_no_asset / commits, 3) if commits else None,
        "reasons": {f"{c}:{e}": n for (c, e), n in reasons.most_common(18)},
        "examples": {f"{c}:{e}": f"{s} {p}" for (c, e), (s, p) in examples.items()},
        "flags": flags,
    }


def window_rates(flags, windows=(1, 5, 10, 25, 50)):
    """For a window of W consecutive commits (what `cbd select` actually sees,
    since it diffs from the map's commit), what share of windows are clean?"""
    out = {}
    for w in windows:
        if w > len(flags):
            continue
        n = len(flags) - w + 1
        out[w] = tuple(
            sum(1 for i in range(n) if not any(flags[i + j][k] for j in range(w))) / n
            for k in range(3)
        )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commits", type=int, default=400)
    ap.add_argument("--json")
    ap.add_argument("targets", nargs="+", help="repo:prefix[,prefix...]")
    a = ap.parse_args()

    results = []
    for t in a.targets:
        spec, _, ref = t.partition("@")
        repo, _, prefixes = spec.partition(":")
        includes = tuple(p for p in prefixes.split(",") if p)
        results.append(analyse(repo, includes, a.commits, ref or "HEAD"))

    for r in results:
        name = r["repo"].rstrip("/").rsplit("/", 1)[-1]
        print(f"\n=== {name} @ {r['ref']}  ({r['commits']} commits, {r['files']} changed files) ===")
        print(f"  mode:all rate .......... {r['all_mode_rate']:>6.1%}  ({r['all_mode']}/{r['commits']})")
        print(f"  ...excluding assets .... {r['all_mode_rate_no_asset']:>6.1%}  ({r['all_mode_no_asset']}/{r['commits']})")
        print(f"  classes: {r['per_class']}")
        print("  top triggers:")
        for k, v in list(r["reasons"].items())[:10]:
            print(f"    {v:>5}  {k:<24} e.g. {r['examples'][k]}")
        wr = window_rates(r["flags"])
        print("  P(window gets a SUBSET answer) by window length:")
        print("      W:      " + "".join(f"{w:>8}" for w in wr))
        for k, label in enumerate(("default cfg   ", "-assets       ",
                                   "-assets -always")):
            print(f"    {label}" + "".join(f"{wr[w][k]:>7.1%} " for w in wr))

    if a.json:
        with open(a.json, "w") as fh:
            json.dump(results, fh, indent=2)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()
