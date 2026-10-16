# CBD pre-mortem — measurement results

**Question:** is `unknownPolicy: 'all'` + the `alwaysAll` defaults (CBD.md §8.3, §9.3)
compatible with the tool actually returning a *subset* on a real working branch?

**Answer: at the doc's defaults and at *whole-repo* scope, no.** At a 10-commit window
the median repo returns a subset answer **2.4%** of the time. **However — read §7
first.** The target use case (unit tests only, package-scoped) shrinks the blast
radius enough that a high `mode: all` rate is survivable, and the metric that matters
is expected wall-clock, not subset rate. §1–2 measure the *worst* case and should be
read as an upper bound on the all-rate for a tightly scoped unit-test config.

**Method:** read-only static classification of recent `git log --name-status` history
in 12 real OSS TypeScript repos (the `enterprise-apps/` collection). No builds, no
installs, no writes to those repos. Scripts: `unknown_rate.py`, `alwaysall_kind.py`.

---

## 1. Per-commit `mode: all` rate (400 non-merge commits per repo)

A commit forces `mode: all` if any changed file matching `include` is one CBD cannot
answer for: a type-only `.ts`, an asset (`.css .svg .md .png`), a data file
(`.json .sql .yaml .snap .vue` …), or an `alwaysAll` match.

| repo | `include` used | per-commit all | excl. assets | dominant triggers |
|---|---|---|---|---|
| n8n | `packages/` | 49.0% | 41.0% | `.vue` 198, `.json` 114 |
| langchainjs | `libs/` | 43.8% | 41.7% | `package.json` 633 |
| strapi | `packages/` | 38.8% | 38.3% | `package.json` 645 |
| vscode | `src/` | 36.2% | **1.5%** | `.css` 101, `.md` 82, `.png` 44 |
| nx | `packages/` | 32.5% | 31.2% | `.rs` 237, `.snap` 125, `package.json` 137 |
| directus | `api/,packages/` | 18.8% | 17.7% | `.vue` 230, `.yaml` 128, `package.json` 212 |
| backstage | `packages/` | 17.5% | 10.5% | `package.json` 97, `.hbs` 27 |
| opentelemetry-js | `packages/` | 11.0% | 10.0% | `package.json` 204 |
| nest | `packages/` | 7.2% | 6.4% | `package.json` 47 |

Median ~19%, range 7–49%. VS Code is a **recent-window outlier**: the same analysis at
`HEAD~5000` gives 18.8% and at `HEAD~40000` gives 14.4% — its asset-dominance is an
artefact of a burst of AI-feature work (`.md` roadmaps, `.png` assets under `src/`).

## 2. The measurement that actually matters: windowed subset rate

`cbd select` diffs from **the map's commit** (§8.2), not from the branch base. So the
unit of analysis is not one commit but the whole `map.commit..worktree` window, which
grows as a developer works. One unknown file anywhere in the window forces `mode: all`.

**P(window yields a subset), by window length in commits:**

| repo | W=1 | W=5 | W=10 | W=25 | W=50 | default config only |
|---|---|---|---|---|---|---|
| vscode | 63.7% | 12.6% | **1.8%** | 0.0% | 0.0% | |
| nx | 67.5% | 17.2% | **2.0%** | 0.0% | 0.0% | |
| strapi | 61.3% | 12.6% | **0.8%** | 0.0% | 0.0% | |
| langchainjs | 56.2% | 12.4% | **2.8%** | 0.0% | 0.0% | |
| directus | 81.2% | 36.1% | **10.5%** | 0.0% | 0.0% | |
| n8n | 51.0% | 4.3% | **0.0%** | 0.0% | 0.0% | |
| opentelemetry-js | 89.0% | 56.6% | **30.9%** | 2.1% | 0.0% | |
| backstage | 82.5% | 44.4% | **23.0%** | 2.4% | 0.0% | |
| **median** | **65.6%** | ~15% | **2.4%** | 0.0% | 0.0% | |

Same table with an **asset policy** (assets never force `all`) and with **assets +
`alwaysAll`** both neutralised, to show each lever's size:

| repo | lever | W=1 | W=5 | W=10 | W=25 | W=50 |
|---|---|---|---|---|---|---|
| vscode | assets off | 98.5% | 92.7% | **87.0%** | 70.5% | 44.7% |
| langchainjs | assets + alwaysAll off | 96.0% | 86.9% | **77.0%** | 49.5% | 22.8% |
| opentelemetry-js | assets + alwaysAll off | 97.8% | 90.7% | **82.9%** | 65.2% | 45.3% |
| backstage | assets + alwaysAll off | 96.5% | 86.4% | **76.2%** | 51.6% | 31.6% |
| directus | assets + alwaysAll off | 89.8% | 59.3% | **37.1%** | 12.8% | 0.3% |
| strapi | assets + alwaysAll off | 83.5% | 44.2% | **17.4%** | 0.0% | 0.0% |
| nx | assets + alwaysAll off | 72.5% | 26.3% | **7.2%** | 0.0% | 0.0% |
| n8n | assets + alwaysAll off | 65.5% | 13.9% | **0.5%** | 0.0% | 0.0% |

**Reading it:** map freshness dominates every policy lever. W=1 → 65.6% subset;
W=10 → 2.4%. A ~30× swing from one operational decision. The doc's cost model
("collect is slow, occasional") is inverted for this use case: **collection frequency
× collection cost is the real budget, and freshness is the product.**

## 3. Is `alwaysAll: ["**/package.json"]` honest?

Classified by the *content* of the `package.json` diff (version-only vs dependency
field vs other), last 250 commits per repo:

| repo | dep-change | version-only | other/empty | verdict |
|---|---|---|---|---|
| strapi | 80.8% | **0.0%** | 19.2% | honest — real dep bumps |
| nx | 37.6% | **0.0%** | 62.4% | honest |
| opentelemetry-js | 24.8% | **0.0%** | 75.2% | honest |
| langchainjs | 62.0% | **20.0%** | 18.0% | over-fires on changesets releases |
| directus | 26.0% | **16.8%** | 57.2% | over-fires on changesets releases |

So `alwaysAll` is *mostly* the correct safety net (a dependency bump changes
`node_modules`, which the map excludes — it genuinely cannot answer). A **hunk-aware
`alwaysAll`** (only `dependencies`/`devDependencies`/`engines`/`scripts` hunks trigger,
not `"version"`) recovers ~17–20% of package.json commits in changesets repos. That
explains why the "assets + alwaysAll off" column is *not* the recommendation: most of
that lever is honest and must stay.

## 4. Methodology caveats (read before quoting these numbers)

1. **`include` prefixes are my guesses.** They materially change the result. nx's
   Rust/Kotlin (`.rs` 237, `.cs` 25) is `mode: all` only because I set `include:
   packages/`; a config scoped to the JS packages would *ignore* those files, not treat
   them as unknown. Several numbers here are therefore pessimistic for a well-tuned config.
2. **A `.vue`/`.css`/`.svelte` change may be V8-visible after all.** If it compiles to a
   JS module that a test imports, V8 sees the generated script and the source map points
   back to the original. My classifier cannot tell which non-code files are compiled into
   loaded modules — so n8n (`.vue` 198) and directus (`.vue` 230) may be **false positives**
   here. Only a real collection run settles this. This is the largest single uncertainty.
3. **Window independence.** The windowed rate assumes consecutive main-branch commits are
   what a feature branch diffs. A developer's own commits are less likely to be dependency
   bumps, so W=10 is likely pessimistic — but any *one* `.json`/`.vue`/`package.json` in
   those 10 commits still forces `all`, so the shape of the curve holds.
4. **`typesonly` reads the current worktree, not the historical blob** — fine here because
   its incidence is tiny (1–25 files per repo, ≤2% of triggers).
5. **Per-commit all-rate is not the product metric.** §2 is; §1 is only the input.

## 5. Spike S1 / S4: the runtime assumptions (Node v24.18.0)

`spike/measure.mjs` — generates a synthetic corpus of N modules x M functions,
drives `node:inspector` directly, and measures. Regenerates its corpus on each run.

### S1a — does `takePreciseCoverage` reset with `callCount: true`? **CONFIRMED**

Call one function, take -> count `3`. Take again with no calls -> script `absent`
from the payload entirely (V8 omits zero-count scripts). So each take is a genuine
per-window delta. **The entire per-test-delta design rests on this and it holds.**

Normalizer consequence: "script absent from payload" must mean zero, not an error.

### S1b — is the in-process `post` synchronous? **CONFIRMED**

The `session.post` callback fired before `post()` returned. So `takeSync()` from a
hook the framework does **not** await is viable (CBD.md §4.2's speculation). This
materially de-risks every adapter: japa's non-awaited `test:end` stops being a
blocker, and the "find an awaited hook" problem is much smaller than §7 assumes.

### `Debugger.scriptParsed` carries `sourceMapURL`? **CONFIRMED**

An inline `data:application/json;base64,…` map on a loaded module was reported on
the `scriptParsed` event. The Normalizer's single code path (in-process and remote)
works.

### S4 — the take cost curve

3 repeats x 150 takes, mean ms per take:

| scripts | functions | take ms | µs/function |
|---|---|---|---|
| 332 | 2,000 | ~0.40 | 0.200 |
| 332 | 20,000 | ~2.08 | 0.104 |
| 2,132 | 20,000 | ~2.10 | 0.105 |
| 5,132 | 50,000 | ~4.50 | 0.090 |
| 332 | 100,000 | ~6.22 | 0.062 |

**Cost is driven by the number of loaded FUNCTIONS, not scripts.** Identical
function counts at 332 vs 2,132 scripts cost the same (2.08 vs 2.10 ms). Cost is
mildly sublinear in function count: roughly **2 ms per take at 20k loaded functions,
4.5 ms at 50k, 6 ms at 100k**.

Two consequences that contradict the design doc:

1. **"filter early by URL" (§11) cannot reduce take cost.** It is a *normalization*
   lever. V8 pays to walk and serialise functions long before the Normalizer sees
   them — the measurement shows 13 scripts with counts still costing 4.5 ms at 5,132
   loaded scripts. The only real lever on take cost is **fewer takes**
   (`granularity: 'group'`).
2. **`node_modules` is filtered at normalization time, not at take time.** A process
   that loads a large dependency tree pays for its functions on every take even
   though CBD discards them. This is the unbounded term and the synthetic corpus
   could not measure it (see caveats).

### Verdict on overhead: **the failure narrative is refuted**

900 tests x 2 takes (`takeAtStart: true`) = 1,800 takes:
- mid-size backend (~10k loaded functions): ~1.3 s added to a 150 s suite = **0.9%**
- VS Code scale (~60k loaded functions): ~9 s, i.e. ~10-25% of that suite

**Collection is affordable to run frequently** — which is exactly what §2 requires.
The two findings combine favourably: the freshness requirement is affordable.
The doc's framing of collection as "slow, occasional" is not forced by the physics,
only by the policy.

### Spike caveats

- The corpus is synthetic: no async, no closures, no deopt, no GC pressure from real
  data. Expect real numbers 1-3x worse.
- The large-dependency-tree case (the term that could actually hurt) is **not**
  measured here and needs a real process.
- Mean-of-150 with 3 repeats; run-to-run spread on the 20k-function configs was
  ~20% (1.75-2.58 ms). Treat these as order-of-magnitude, within 2x.

## 7. Reframing for the actual target: unit tests only

Goal: a ~20 min unit suite that only needs ~2 min on a small change. **This changes the
conclusion from §1-2 substantially**, in two ways.

### 7a. `mode: all` is the status quo, not a catastrophe

Falling back to "run everything" costs 20 min — which is what the developer already
pays today. Selection is a pure improvement on the runs where it fires. So the metric
is **expected wall-clock**, not subset rate:

`E[time] = P(all)·20 + (1 − P(all))·2` minutes

| P(all) | E[time] | saved | median run |
|---|---|---|---|
| 5% | 2.9 min | 85% | 2 min |
| 10% | 3.8 min | 81% | 2 min |
| 20% | 5.6 min | 72% | 2 min |
| 33% | 7.9 min | 60% | 2 min |
| 50% | 11.0 min | 45% | 2 min |
| 75% | 15.5 min | 22% | 20 min |

At a 50% all-rate the tool still halves the mean and moves the *median* run from 20
min to 2 min. My §1-2 framing ("the tool becomes noise and gets removed") assumed an
all-rate near 1 and treated any `all` as failure. **That was overstated** — it is only
true when the window compounds (§2) or the scope is the whole monorepo.

### 7b. Unit-test scope shrinks the trigger population a lot

§1's numbers were measured with whole-repo `include` prefixes (`packages/`, `src/`) on
500k-commit monorepos. A unit-test config scoped to one package's `src/**` deletes most
of those triggers outright:

| trigger class in §1 | under unit-test scope |
|---|---|
| assets (.css/.png/.md), other-language source (.rs/.kt/.cs) | **disappears** — outside the package's `include`, so *ignored*, not unknown |
| unrelated packages' `package.json` | disappears (different package) |
| `.snap` snapshots | remains — but has an exact **path-convention owner** (`__snapshots__/foo.test.ts.snap` → run `foo.test.ts`) |
| JSON fixtures read with `fs` | remains — path convention + importers |
| type-only `.ts` | remains, genuinely unknown; usually cheap at package scope |
| the package's own `package.json` / `tsconfig` | remains, honestly `all` |

So my measured 98% figure is an **upper bound** for this use case, not a prediction.
The residual, after a tight `include` + snapshot/fixture path conventions, is dominated
by the package's own dependency and config changes — which are honest and infrequent.

### 7c. Levers on P(all), in order of measured impact

1. **Map freshness.** W=1 → 65.6% subset vs W=10 → 2.4% (§2). Build the map per commit;
   §5 shows collection is affordable (~2 ms/take at 20k loaded functions, ~1-2% of the
   suite). This is the single dominant lever and it is an operational decision.
2. **Tight `include`** (unit tests in one package) — removes most of §1's triggers.
3. **Path-convention owners** for `.snap` / fixtures — removes the largest genuinely
   unit-test-relevant unknown class.
4. **Hunk-aware `alwaysAll`** (only dependency-field hunks, not `"version"`) — worth
   17-20% of package.json commits in changesets repos (§3).

### 7d. What unit-tests-only removes from the design

If the target is unit tests and not integration tests, the following exist purely for
out-of-process/black-box suites and **are not needed for v1**:

- `inspectorSource({url})` — the entire CDP-over-WebSocket path (§4.3): `/json/list`
  discovery, the collector lock file, `allowRemote`, multi-process server target lists
- the `--target` / `--listen` CLI flags and the HTTP control server (§7.6)
- `browserSource` (already deferred, §4.4)
- the `@between` cross-process machinery — unit tests in one process attribute exactly

The risk rows it deletes: `--inspect` exposure, multi-process servers, two runners on
one server, dependency and network latency in take(). Unit tests also run in a single
process under japa (§7.1), so `inProcessSource` alone suffices and attribution is exact.

## 8. Reproduction

```sh
cd .explore
E=/Users/spikedpunchvictim/temp/enterprise-apps
python3 -I unknown_rate.py  --commits 400 --json windows.json \
  "$E/nx:packages/" "$E/strapi:packages/" "$E/vscode:src/" # ...
python3 -I alwaysall_kind.py --commits 250 \
  "$E/strapi:packages/" "$E/langchainjs:libs/"
```

All read-only. Artifacts: `vscode.json`, `multi.json`, `windows.json`.

## 9. Gate A — the startup floor, measured (2026-10-15)

The metric is `S = (1−P)(1−φ)(1−r)` (ADR-0004). `φ` is the part of a run you pay no matter how
little you select. CBD chooses *which* tests run; it cannot make them load faster, so a large `φ`
caps `S` at any selection quality.

**Method.** `.explore/spike/gate-a.mjs` times runs at several selection sizes and reports the
floor. Files are sampled evenly across the tree, not taken as a prefix — a prefix of a sorted
list is one subtree, and cost per test is not uniform across a tree.

```
node .explore/spike/gate-a.mjs --cwd ~/temp/cbd-b0/vscode \
  --list-cmd "find out/vs/platform -name '*.test.js' | grep -E '/test/(common|node)/'" \
  --run-cmd "node test/unit/node/index.js" --run-flag "--run" --ks 1,10,100,all --runs 3
```

629 test files, `--run` with evenly spaced selections (note: `--run` resolves against the *repo
root*, so paths need the `out/` prefix; `src/…` also works and is rewritten).

| k (test files) | median wall | per file | samples |
|---|---|---|---|
| 1 | **0.142 s** | 142 ms | 0.14, 0.14, 0.17 |
| 10 | 0.622 s | 62 ms | 0.60, 0.62, 0.77 |
| 100 | 15.106 s | 151 ms | 9.35, 15.11, 20.27 |
| 629 | **86.406 s** | 137 ms | 86.41 |

**φ ≤ 0.16%** — `T(1)/T(full) = 0.142/86.4`. A one-file run is the practical floor and still pays
for that one file, so the true floor is below this, somewhere between 0.01% and 0.16%. **Gate A
passes decisively for VS Code.** At φ = 0.16%, `S_max = (1−P)(1−φ)` is 81% at a 19% all-rate,
against a 60% target.

Two things make the floor irrelevant rather than merely small, and both are worth keeping:

- **The cost is loading, not running.** 33 tests execute in 10 ms, but one test file costs 142 ms
  wall. Almost all of it is importing the transpiled module graph. Node caches modules within a
  process, so the cost tracks the *union* of the selected files' imports, not the number of tests
  — which is why `r`'s effect on time is not worse than its effect on test count, the assumption
  the whole payoff estimate rests on.
- **The curve is superlinear, not linear.** Per-file cost rises from ~62 ms at k=10 to ~137–151 ms
  at k≥100. If that holds, a subset saves *more* time than its test-count share, which makes the
  payoff model conservative rather than optimistic.

**Caveats, and they are real.** The full run measured 86.4 s here against 104 s in B0 — a 17%
spread in the baseline itself, so the baseline needs repeating before being quoted. The k=100
point has a 2× spread (9.35–20.27 s), which means the *shape* of the curve is not yet
established; only the floor is, and it is small enough that the shape does not change the verdict.
The line fit reports a 0.000 s intercept, which is an artefact of fitting a straight line to
superlinear data and should not be quoted — `T(1)` is the honest estimate.

**What this does not settle.** Gate A must be measured on the *target* suite, which is still
unnamed. VS Code's node runner is hand-rolled and loads only the selected files; japa and vitest
are not, and vitest in particular pays Vite's transform pipeline on every start. The harness takes
any repo and any runner via `--list-cmd` / `--run-cmd` / `--run-flag`, so the remaining work is
supplying a command, not writing code.

