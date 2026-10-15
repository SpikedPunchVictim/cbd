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
and it is how `@cbd/auto` would inject itself for the "developer runs tests the way they
always do" requirement.

## F8 — import-time hooks are where the test→file map comes from.

`runner.onSuite`, `suite.onTest`, `suite.onGroup` and `group.tap` all fire during *file
import*, before `runner:start` (observed at seq 000–006, before `runner:start` at 007).
That is a free, precise source of "test X is defined in file Y" without parsing source.

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

## Reproduction

```sh
cd probe && node bin/test.js
```
