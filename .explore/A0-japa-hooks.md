# Stage A0 — japa hook facts, verified against the installed version

**Why this exists:** CBD.md §13 recorded its hook facts against `@japa/runner` **5.0.0**.
The registry now serves **5.4.0** (`@japa/core` 10.4.0), so every fact the adapter rests
on was re-derived rather than assumed.

**Method:** read the shipped declarations and JS in
`node_modules/.pnpm/@japa+core@10.4.0/node_modules/@japa/core/build/`, then confirm
behaviour at runtime with `probe/` (a real japa suite; `cd probe && node bin/test.js`).

---

## F1 — japa does **not** await `emit`. This is the constraint everything else follows from.

`@japa/core` build/index.js, lines **472, 486, 542, 563**:

```js
this.#emitter.emit("test:end", endOptions);   // no `await`
```

`Emitter extends Emittery<RunnerEvents>` and its `emit` is declared
`emit(...): Promise<void>` — so the call *returns* a promise, but japa never waits on it.

Demonstrated at runtime. A deliberately-async `test:end` listener, alongside a
synchronous one:

```
  024  test:end:exit        epsilon [double]
  025  group:end            gamma
  026  suite:end            default
  027  test:end:ASYNC-late  alpha   (last test:start was "epsilon")
  028  test:end:ASYNC-late  beta    (last test:start was "epsilon")
  ...
  031  test:end:ASYNC-late  epsilon (last test:start was "epsilon")
```

All five async handlers ran **after the suite had ended**, each observing that the last
test to start was the final one. Not merely late — comprehensively detached.

**Consequence for the adapter:** every lifecycle handler must be **synchronous**. A single
`await` inside a `test:end` handler defers the work past the window boundary and corrupts
attribution. This inverts the natural way to write the adapter, and it is the single most
important fact in this document.

## F2 — `takeSync()` works. S1b is load-bearing, not merely convenient.

Spike S1b claimed the in-process inspector's `post` callback fires before `post()`
returns. Confirmed inside a real `test:start` handler:

```js
session.post('Profiler.takePreciseCoverage', {}, (err, res) => { done = true; … })
// `done === true` on the very next line
```

Because of F1 this is exactly where it is needed: a synchronous take runs to completion
inside the handler, before `emit()` returns, and therefore before the next test starts.

## F3 — the per-test delta design works end to end.

`take()` at `test:start` (discard → `@between`), `take()` at `test:end` (attribute to the
test). `takePreciseCoverage` resets on read (spike S1a), so each window is a true delta.
Against a three-function module where tests call `addOne` or `double` and nothing calls
`unused`:

| test | hit set | expected |
|---|---|---|
| alpha | `addOne` | ✓ |
| beta | `double` | ✓ |
| zeta | `addOne` | ✓ |
| delta | `addOne` | ✓ |
| epsilon | `double` | ✓ |
| **nothing** | `unused` never reached | ✓ |

The last row is the **inverse map** — "what code does no test reach?" — working at toy
scale, for free, from the same data.

## F4 — hook inventory (5.4.0). All six names in §13 exist.

| CBD.md §13 name | Installed 5.4.0 | Notes |
|---|---|---|
| `test.setup` / `test.teardown` | ✓ | chainable on the returned `Test` |
| `group.each.setup/teardown` | ✓ | `each` is a **property object**, not methods: `each: { setup, teardown, timeout, retry, skip, disableTimeout }` |
| `runner.onSuite` | ✓ | `Runner.onSuite(cb)` |
| `suite.onGroup` | ✓ | |
| `suite.onTest` | ✓ | |
| `group.tap` | ✓ | |
| `test:start` / `test:end` | ✓ | emitter events |

Two additions §13 did not record: `Test.cleanup(handler)` exists, and
`group.setup/teardown` (group-level, distinct from `group.each.*`) exist.

## F5 — `test:cleanup` is **not** an event. (Correcting an earlier claim of mine.)

It appeared in a grep and I first read it as an undeclared event. It is an *error-phase
label*: `TestEndNode['errors'][].phase` is one of `'setup' | 'test' | 'setup:cleanup' |
'teardown' | 'teardown:cleanup' | 'test:cleanup'`. `Test.cleanup()` is a cleanup
*handler*. There is no `test:cleanup` lifecycle event, and a listener for one never fires.

## F6 — `getActiveTest()` returns `undefined` inside a hook.

It is for use inside a test *body*. Hooks must take identity from the event payload
(`node.title.expanded`).

## F7 — the plugin **is** the integration point.

`PluginFn` receives `{ config, cliArgs, runner, emitter }` — the emitter directly. So the
adapter can be:

```js
configure({ plugins: [cbd()] })
```

with **zero changes to user test files**. This is cleaner than the approach §7 sketches,
and it is how `@spikedpunch/cbd/auto` would inject itself for the "developer runs tests the way they
always do" requirement.

## F8 — japa hands over the test's file itself: `meta.fileName`. *(Corrected 2026-10-16.)*

**What this said first was wrong.** It claimed `runner.onSuite`, `suite.onTest`,
`suite.onGroup` and `group.tap` are *where the test→file map comes from* — that catching the
test at its defining call site during import yields the file. They do all fire during file
import, before `runner:start` (observed at seq 000–006). But firing at the right *moment* is not
the same as carrying the *answer*: what those callbacks receive is a title, and a suite is
configured over a set of files, so neither identifies one file. Later I over-corrected and
concluded japa exposes no file for a test at all, which was also wrong, and which blocked
`cbd-cpy` until it was checked against the shipped build.

**The file arrives on `meta`, set by japa, needing nothing from the test author.**
`runner/build/index.js` sets `executionPlanState.file = fileURLToPath(fileURL)` immediately
before importing each file; `create_test` then does `testInstance.options.meta.fileName =
options.file` (and the same for groups); and the core emits `test:start` as
`{ ...test.options, title, isPinned }`. So the payload carries it.

Verified at runtime with `probe/bin/files.js` — two fixture files, `a.js` and `b.js`, same
shape, so each observation can be checked against the file it *should* name:

```
  suite.onTest   import   a-lone      fileName=…/tests/files/a.js
  group.tap      import   a-grouped   fileName=…/tests/files/a.js
  suite.onTest   import   b-lone      fileName=…/tests/files/b.js
  group.tap      import   b-grouped   fileName=…/tests/files/b.js
  test:start     emitter  a-lone      fileName=…/tests/files/a.js
  test:end       emitter  a-lone      fileName=…/tests/files/a.js
  group:start    emitter  a-group     fileName=…/tests/files/a.js
```

`meta` on `test:start` is `[abort, fileName, group, suite]`. It is present **before the window
opens**, so the adapter writes the map entry as the window opens rather than buffering to
retrofit at `test:end`. `TestStartNode = Omit<TestOptions, 'title'> & {…}` and `TestOptions.meta`
is `Record<string, any>`, so it is in the declared type, not a private field.

**The stack walk is dead, and the probe is why we know.** Every row above shows
`stack[0] = lib/file-probe-plugin.js` — the plugin's own file. japa invokes these callbacks from
its own frame, so a stack walk finds the *plugin*, not the test, at both import time and run
time. Option (a) — an ESM loader hook — is unnecessary. Neither was needed; the file was on the
payload the whole time.

**Upstream has nothing newer to offer.** Checked 2026-10-16: `@japa/core` 10.4.0 and
`@japa/runner` 5.4.0 are the latest published, which is what was already installed.

## F9 — the async/sync seam, and what it means for integration testing later.

The user asked that this spike leave room to expand into integration testing. A0 shows
precisely where that joint is, and that it is a genuine constraint rather than a TODO:

- **In-process collection can be synchronous** — and for japa it *must* be (F1).
- **Out-of-process collection over CDP is inherently asynchronous** — a WebSocket
  round-trip cannot complete inline.
- **japa will not await an async handler.** So a future `inspectorSource` cannot close a
  window accurately at `test:end` under japa.

The interface must therefore carry **both** shapes: `takeSync()` for in-process and
`take(): Promise<…>` for remote. The adapter drives whichever the configured source
offers, and knows that a sync source is the only one that yields exact boundaries under
japa. Out-of-process under japa will need one of: timer-sampled windows with approximate
boundaries, group-level granularity, or a runner that does await (vitest/jest may differ
— unverified).

Designing `Source` with both members costs nothing now and is the thing that keeps the
integration-testing door open.

---

## F10 — a test's name is its **bare** title. The group is a separate thing.

`TestRunner#getTitle` (core build, ~line 530):

```js
#getTitle(dataset) {
  const title = this.#test.options.title
  return { original: title, expanded: dataset ? interpolate(title, dataset.row, dataset.index + 1) : title }
}
```

**With no dataset, `expanded === original`** — including for a test inside a group. The group
does *not* prefix the title; it arrives separately as `meta.group`. Observed:

```
START: {"o":"a-grouped","e":"a-grouped","g":"a-group"}   ← inside test.group('a-group', …)
START: {"o":"a-lone",   "e":"a-lone"}
```

This matters because it decides what the map keys a test by, and because japa's filter matches
the bare title and nothing else (`Refiner#isTestTitleAllowed`, core build line 963):

```js
#isTestTitleAllowed(test) {
  if (!this.#filters.tests.length) return true
  return this.#filters.tests.includes(test.title)
}
```

So `--tests a-grouped` selects one test; `--tests "a-group a-grouped"` selects **nothing**,
silently. Had the adapter recorded a qualified name and emitted it back, every filter would have
matched zero tests — a *miss*, which is the single failure direction this project forbids. The
map therefore keys on the bare title, and the adapter emits the bare title.

## F11 — `configure()` snapshots `cliArgs` when it is called, so CLI filters are dropped silently.

`runner` build, index.js 137–142:

```js
function processCLIArgs(argv) { cliArgs = new CliParser().parse(argv) }
function configure(options) { runnerConfig = new ConfigManager(options, cliArgs).hydrate() }
```

`configure` reads the module-level `cliArgs` **at call time**. Call it before `processCLIArgs` —
which is what every entry point in this repo did — and it hydrates with the initial empty parse,
where `tests` is `""`. `#getCLIFilters` tests truthiness, so no filter is ever applied.

Demonstrated on CBD's own suite:

```
$ node bin/test.js --tests zzz-no-such-test-xyz
Tests  120 passed (120)      ← a filter matching nothing ran everything
```

**This is a product-level hazard, not a papercut.** CBD's speedup *is* the filter. A discarded
`--tests` yields a green run, zero speedup, and no error — the developer concludes the tool does
not help, and nothing anywhere says why. It also means **no selection run in this repo has ever
actually been filtered**; any earlier "select" result was vacuous, because the CLI args were
ignored and the full suite ran.

**The fix is to not use CLI args at all.** The plugin receives `config`, and mutating
`config.filters.tests` there works *regardless* of the consumer's ordering, because the plugin
runs inside `run()` while the refiner filters are read afterwards by `Planner.plan()`:

```
$ node bin/dbg2.js    # configured the WRONG way round, on purpose
START: {"o":"a-grouped","e":"a-grouped"}
Tests  1 passed (1)
```

So the adapter's select half sets `config.filters.tests` from the plugin. It requires nothing
from the user's npm script, cannot be broken by call order, and removes a class of silent
no-op. Two traps to avoid in the same area: **never emit `--groups`** — `Refiner#allows` line
1000 rejects every ungrouped test as soon as `groups` is non-empty (`if (this.#filters.groups.length
&& !testOrGroup.parent) return false`), so it silently drops tests; and be aware bare titles can
collide across groups, where a filter naming one runs both. Collisions over-select, which is the
safe direction, but the map should know they exist.

## F12 — `runner:end` **does** await an async listener, so a deferred drain can live there.

F1 says japa does not await `emit` for the per-test events. That is true, and it is not true of
`runner:end`, and the difference is what makes out-of-process recording possible at all.

An out-of-process window cannot be written when its boundary is crossed — the reply has not come
back yet. So the drain has to happen somewhere japa waits. `runner.end()` returning a promise and
japa awaiting it is *not* the same claim as japa awaiting a promise returned by a listener on
`runner:end`; the first does not imply the second. Emittery does await listener return values, so
it should hold — which is exactly why it was measured rather than read.

```
$ node bin/test.js
  async handlers landed late ....... 5 of 5, at seq [27,28,29,30,31] — after seq 32
  runner:end awaits an async listener . YES — already settled when run() resolved
```

Both facts hold at once, and the combination is the design: a 30 ms listener on `test:end` lands
after every test has finished, while a 30 ms listener on `runner:end` has already settled on the
line after `await run()` returns. So per-test boundaries must be synchronous and the *end* of the
run need not be.

The measurement is read on the line immediately after `run()` resolves. Any later read is
worthless: the probe's own report sleeps to let detached listeners land, which would set the flag
whether or not japa ever waited for it.

## Reproduction

```sh
cd probe && node bin/test.js      # F1–F9, F12: hook order, window boundaries, the end drain
cd probe && node bin/files.js     # F8/F10, two fixture files, per-file attribution
```
