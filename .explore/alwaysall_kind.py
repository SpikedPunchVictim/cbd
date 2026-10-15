#!/usr/bin/env python3
"""Is `alwaysAll: ["**/package.json"]` honest, or does it over-fire?

CBD.md 9.3 lists package.json in `alwaysAll`, so any commit touching one goes
`mode: all`. That is only justified when a *dependency* changed -- code in
node_modules is excluded from the map, so the map genuinely cannot answer.

A mechanical release bump (`"version": "1.2.3"` -> `"1.2.4"`) changes no
behaviour and should NOT force mode:all. This measures which it is.

READ-ONLY. Usage: python3 -I alwaysall_kind.py [--commits N] <repo:prefix> ...
"""

import argparse
import collections
import re
import subprocess

DEP_RE = re.compile(
    r'^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies'
    r'|resolutions|overrides|engines|packageManager|scripts|exports|types'
    r'|main|module|workspaces)"\s*:'
)
VERSION_RE = re.compile(r'^\s*"version"\s*:')
DEP_ENTRY_RE = re.compile(r'^\s*"[^"]+"\s*:\s*"[~^>=<*\d]')  # a version constraint


def commits_touching_pkg(repo, prefix, limit):
    out = subprocess.run(
        ["git", "-C", repo, "log", f"-{limit}", "--no-merges", "-p",
         "--format=%x00%h|%s", "--", "*package.json"],
        capture_output=True, text=True, check=True,
    ).stdout
    sha = subj = None
    cur_path = None
    kinds = {}
    lines = collections.defaultdict(set)
    for ln in out.splitlines():
        if ln.startswith("\x00"):
            if sha:
                kinds[sha] = classify(lines, subj)
            sha, _, subj = ln[1:].partition("|")
            lines = collections.defaultdict(set)
            cur_path = None
        elif ln.startswith("+++ ") or ln.startswith("--- "):
            p = ln[4:]
            if p != "/dev/null":
                cur_path = p[2:] if p.startswith(("a/", "b/")) else p
        elif (ln.startswith("+") or ln.startswith("-")) and not ln.startswith(("+++", "---")):
            if cur_path and cur_path.startswith(prefix):
                lines[cur_path].add(ln[1:])
    if sha:
        kinds[sha] = classify(lines, subj)
    return kinds


def classify(lines, subj):
    toks = set()
    for path, body in lines.items():
        for ln in body:
            if VERSION_RE.match(ln):
                toks.add("version")
            elif DEP_RE.match(ln):
                toks.add("depfield")
            elif DEP_ENTRY_RE.match(ln) and ":" in ln:
                toks.add("depentry")
            elif ln.strip():
                toks.add("other")
    if not toks:
        return "empty"
    if toks <= {"version"}:
        return "version-only"
    if toks & {"depfield", "depentry"}:
        return "dep-change"
    return "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commits", type=int, default=250)
    ap.add_argument("targets", nargs="+")
    a = ap.parse_args()
    for t in a.targets:
        repo, _, prefix = t.partition(":")
        kinds = commits_touching_pkg(repo, prefix, a.commits)
        name = repo.rstrip("/").rsplit("/", 1)[-1]
        c = collections.Counter(kinds.values())
        tot = sum(c.values()) or 1
        print(f"\n=== {name} ({tot} commits touching package.json in last {a.commits}) ===")
        for k, v in c.most_common():
            print(f"  {v:>4}  {v/tot:>6.1%}  {k}")
        vo = [s for s, k in kinds.items() if k == "version-only"]
        print(f"  -> {len(vo)} commits forced mode:all by a pure version bump "
              f"({len(vo)/tot:.1%})")


if __name__ == "__main__":
    main()
