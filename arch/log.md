# Update history

## 2026-10-15

**Creation** — bundle established. ADR-0001 (observe execution, not a call graph), ADR-0002
(resolve at build time) and ADR-0003 (one factory, five verbs, two tiers) written as unreviewed
drafts. Remaining records listed under *Planned* in [index.md](index.md).

**Update** — ADR-0004 recorded after a pre-mortem on the plan as committed at `4dc5ed9`. It
replaces the absolute goal ("20 min → 2 min") with a constrained percentage metric,
`S = (1−P)(1−φ)(1−r) ≥ 0.60` subject to a zero miss count, and derives two gates from it — one of
which, the startup floor φ, is measurable with no CBD code at all. Two questions are recorded as
open rather than answered: whether 60% is a defended floor, and where the target suite lives.

**Update** — the second of those questions is answered. The target is the `sdk-unit` suite of the
grizzly-platform TypeScript monorepo: japa 5.0.0, 18 spec files under `sdk/tests/`, fully offline,
test doubles injected by DI. Deliberately *not* the project's `stores` suites, which `CBD.md`
Stage 4 names — those are `@japa/api-client` suites driving a separately started server, the
out-of-process shape cut from v1 when the scope narrowed to unit tests. Naming the target exposed
a task nobody had filed: `@cbd/japa` did not exist, though `CBD.md` calls japa the first adapter
and budgets a day for it. It is filed as `cbd-cpy` and blocks Gate B. One consequence is recorded
in the ADR rather than smoothed over: neither gate can run without a coverage map, so Gate A,
designed to be nearly free, now sits behind about a day of adapter work.

## 2026-10-16

**Update** — that target failed its own gate the next day, and the record is amended to say so.
Gate A on `sdk-unit`: `T_full` 1.69 s against a measured floor of 0.72 s, so φ = 42.6%; at P = 0 the
target needs φ ≤ 40%, and `S_max` = 0.574. The choice is marked **superseded** in
[ADR-0004](decisions/0004-success-metric.md), with the arithmetic that supersedes it kept: φ is
`floor / T_full`, the floor is roughly constant per toolchain, and the same repository's
`tests/stores` suites — 1555 tests in 548.6 s — land at φ ≈ 0.5%. Size, not design, separates them,
and the record had no gate for size. A replacement target is being chosen under `cbd-u0v.2`;
measurements are in `.explore/FINDINGS.md` §10–11.

**Update** — both decisions above are now settled, and the metric itself changed.

*Target.* The `tests/stores` suites, measured at 1555 tests in 548.6 s (plus 198 tests in 62.5 s for
`signing`), φ ≈ 0.5%. This reverses the unit-tests-only scope, and with it `FINDINGS.md` §7d's
cuts: the out-of-process instrumentation is v1 work, filed as `cbd-a3v`, and it now **blocks Gate
B** — a map blind to server-side code resolves a key-server change to an unknown file and escalates
to `all` for a reason that has nothing to do with whether subsetting pays.

*Metric.* `S` loses its startup factor: `S = (1 − P)(1 − r)`, from `(1 − P)(1 − φ)(1 − r)`. Startup is
a cost the run pays whether or not CBD acts, so it is identical in the baseline and the subset, it
cancels in the comparison, and it is nothing the selector influences. Keeping it inside the product
made `S` a compound of one thing CBD does and one thing it merely inherits, and it read a suite's
heavy warm-up as a failure of selection. The floor stays load-bearing, but as an admissibility test
on the *suite*: `1 − φ` is the largest wall-clock improvement any selector can deliver, so a suite
needs `φ ≤ 40%` before the 60% goal is even addressable. That is the gate that failed `sdk-unit` and
that the stores suites clear by a wide margin.

**Update** — `cbd-3td` closed: the `inspectorSource` contract is fixed, the CDP client is not
written. What the contract had to settle is that an out-of-process source is the first `Source`
that cannot be synchronous, and `Recorder` cannot stop being synchronous — japa does not await its
hooks, so an awaited take lands after the next test has started. The rule recorded in
`src/source/inspector.ts` is that **dispatch time is the window boundary, not completion time**:
`take()` is called with the window open and must send immediately, may settle later, and overlapping
windows are a contract violation to report rather than to attribute by arrival order. `takeSync()`
and `take()` also drain the same counter, so mixing them yields two half-windows rather than two
views of one. The tests are a shared suite in `tests/support/source-contract.ts`, applied to
`inProcessSource` and to an async-only stand-in, so `cbd-a3v` is held to a contract that already has
a passing implementation of its shape. The security rule — loopback only, `allowRemote: true`
required otherwise, `0.0.0.0` not loopback — is enforced through the real entry point even though
the entry point rejects.

**Update** — [ADR-0005](decisions/0005-inject-not-attach.md) recorded, and it demotes the contract
above to a fallback. The question was the author's: reaching the server by attaching a debugger asks
the developer to pick a port, discover it, keep two collectors off it, guard an unauthenticated
code-execution surface, and repeat all of that per process for a worker pool — which is the opposite
of the one-environment-variable promise the project already makes for tests. The decision is to
inject instead: `NODE_OPTIONS="--import @spikedpunch/cbd/instrument"` runs CBD's own code inside the
target, which takes its own coverage through `node:inspector` and serves the deltas on a unix socket.
A four-file spike in `.explore/spike/injection/` settles it: a service that imports nothing from CBD
instruments under one variable, a worker it spawned instruments too because `NODE_OPTIONS` is
inherited, and the two processes report their own functions and not each other's. Consequences
recorded rather than smoothed over: the lane hook collapses from nine files to one line in an env
template; the socket must carry `Debugger.scriptParsed` and `sourceMapURL` or a compiled service
cannot be mapped back to TypeScript, and that is unbuilt; the module must be inert in every process
the variable reaches, the test runner included; a containerised service needs its socket directory
mounted; and `--import` puts a Node 20.6 floor under the whole path. This also revises the package
layout — one published package with entry points rather than a package per role, since the decision
rests on there being one variable to learn. The package scope moves with it, `@cbd/*` to
`@spikedpunch/*`, but not the sub-package boundary: an earlier draft of the record claimed the
adapters should fold into one package, and that was wrong — each adapter carries its own framework as
a peer, so folding them in would make a mocha user install against japa's peers. They stay siblings.

**Update** — `cbd-cpy` built: `packages/japa/`, 26 tests, and two of its own earlier claims corrected
rather than carried. The adapter was blocked for most of a day on the belief that japa exposes no
source file for a test; that was wrong, and it was wrong because `TestOptions.meta` was read, judged
to be user metadata, and never checked against the runner that populates it. japa sets
`meta.fileName` itself, so the file arrives on every payload and the blocker was never real. The
probe that settled it also killed the alternatives: a stack walk finds the *plugin*, because japa
invokes its callbacks from its own frame, so neither the loader hook nor the stack walk on the
issue's candidate list would have worked.

Two things the probe found that nobody was looking for. A test's identity is its **bare** title —
`expanded` equals `original` even inside a group, and japa's refiner matches `test.title`, so a
qualified name would have matched zero tests and produced a miss. And `configure()` snapshots
`cliArgs` when it is called, which means every entry point in this repository had been calling
`processCLIArgs` too late and having all of its CLI filters silently discarded: `--tests
zzz-no-such-test-xyz` ran the full 120-test suite. The tool's entire speedup is the filter, so a
discarded filter yields a green run with no speedup and no error. Fixed in all six call sites, and
the adapter sidesteps the trap entirely by writing `config.filters.tests` from the plugin, which no
call order can break. This revises `CBD.md` §7.1, which had sketched CLI-arg emission.

One deliberate omission. The issue asks to mirror mocha's `auto.ts`, and there is none here: mocha
has a single funnel a `--import` module can patch, while `@japa/runner` exports only functions and
reads its plugin list from module-private config, so an injected module has nothing to patch. A japa
run costs one line in `configure` instead. The shared projection-env contract moved to the core
(`scanFromEnv`) so two adapters cannot drift on variable names.

**Update** — `cbd-a3v.1` and `cbd-a3v.2` built, and the first of them retracted a claim.

`@spikedpunch/cbd/instrument` is a module a process runs on itself because `NODE_OPTIONS` said so.
It is inert unless the socket directory is set — not politeness, since `NODE_OPTIONS` is inherited by
every Node process a developer starts — silent, and never exits its host on `close`, because a
service is expected to outlive the test run reading it. `socketSource` then reads it over a unix
socket and passes the `Source` contract suite written for the in-process implementation, unchanged.
That was the claim `cbd-3td` made when it wrote those tests: an out-of-process source satisfying the
same suite is what makes the seam a seam.

Two corrections came out of building them. The window rule already on record — dispatch time is the
boundary, not completion time — survived, but its stated reason for refusing overlapping takes did
not: the guard was explained as preventing a late reply being attributed to the wrong window, which
assumes a completion-time model the contract explicitly rejects. It is now explained as what it
actually is, a guard for a caller that has no way to name its windows. And the `close` handling had a
genuine cross-process race: writing the reply and then unlinking the socket let the server be
descheduled in between, so a client woken by the reply could still stat the path. Measured at 2 runs
in 25. Unlinking before replying removes it — 0 in 25, and the suite went from 1-in-5 flaky to six
consecutive clean runs. The comment that first went in explained the libuv mechanism; it was
rewritten to state only what was measured, because the mechanism was inferred and not tested.

**Update** — `cbd-a3v.3` decomposed, and its first piece built: the boundary a synchronous hook
cannot wait for.

The problem it names is real and had no answer in the code. japa does not await its lifecycle hooks
(A0 F1), so the `Recorder` is synchronous end to end; `socketSource` cannot take synchronously. The
escape is that japa *does* await `runner:end` and its plugins, so a boundary can be *written*
synchronously — a write is the boundary — and the replies read at the end where there is already an
awaited hook. `QueuedSource` is that capability as a peer of `Source` rather than a third flag on it,
and `dispatch()` returns a handle numbered by dispatch order so a caller which cannot wait still has
unambiguous windows. `take()` now counts outstanding dispatches too, so the two ways of taking cannot
interleave.

Then the measurement the task was written to ask for, and it did not give the expected answer. Drift
is not a constant of the socket. It is a function of **queue depth**: the peer serves takes one at a
time and a window begins when its boundary is *received*, so a boundary written behind an unanswered
one waits and slides. On this host, boundaries spaced by 0.5 ms drift 68 µs; 200 written back to back
drift 24 ms, about 115 µs of queue delay each. The conclusion drawn from it is deliberately narrow —
real suites space boundaries by whole milliseconds and never accumulate, so the pipeline is not the
problem; a suite whose tests are *faster* than a take round trip (~0.6 ms) is, and nothing would have
told us. So depth is reported rather than reasoned about, and a characterisation test pins the
boundary of the design's validity instead of asserting the happy case.

**Update** — `cbd-a3v.3.2` built, and a japa fact measured that the whole deferred path rests on.

The Recorder now defers. The two recorders differ in exactly one thing — when a record reaches the
sink — so that became a four-function strategy and the `@load`/`@between`/`@teardown` bookkeeping is
written once. The evidence that the extraction preserved behaviour is a byte comparison: the same
scripted payloads driven through both produce identical shard text, and the seven tests that existed
before it pass untouched. That mattered more than it looks, because the `@load` rule is a single
boolean with three call sites, and a second copy drifting on any one of them misfiles an entire import
phase as `@between` — which escalates every file and would present as a conservatism bug rather than a
bookkeeping one.

The deferral needed one japa fact nobody had measured: `run()` awaiting `runner.end()` is not the same
claim as japa awaiting a promise *returned by* a `runner:end` listener. Filed as A0 F12 and probed
rather than read. It holds — the listener's 30 ms had already settled on the line after `run()`
resolved — and it holds *simultaneously* with F1's detachment, which is the asymmetry the design
needs: per-test boundaries must be synchronous, the end of the run need not be.

Two bugs, both found by the comparison test rather than by reasoning, and both the same shape — work
that reads as sequenced and is not. The queue helper took a `() => void` and wrapped its async worker
in a fire-and-forget IIFE, so the chain resolved before the window did and the footer could be written
ahead of the records it follows. And `testEnd` was computing its duration inside the record builder,
which for a deferred window runs when the reply lands rather than when the boundary was crossed, so a
test's recorded duration absorbed whatever happened in between. The rule that came out of the second
one is now stated on the interface: the builder is handed the window and nothing else, because it runs
at two different points in the run depending on the source.

A third thing was not a bug in the code but in how it was being checked: `pnpm run build | tail`
returns the pipe's exit status, so a failing typecheck was reported as a passing step and the tests
were being run against a build that had errored. Caught only because the error text appeared above a
green summary. Build exit codes are now read directly.

**Update** — `cbd-a3v.3.3` wired the deferred recorder in, and the two-shard design was tested rather
than assumed.

The adapter now drives a list of recorders from one set of boundaries, and the plugin decides how many
there are. The rule for the second one is `CBD_SOCKET_DIR`, the same variable the service's own
environment already sets to switch the injected module on (ADR-0005) — so the plugin needs no new
option and the consumer needs to learn no second way of saying it. A configured service that cannot be
reached is an *error*: falling back to the test process alone is precisely the blindness `cbd-a3v`
exists to remove, it would be invisible, and the map would simply have no server-side functions in it.
The service's source is also resolved before either shard is opened, so a misconfiguration leaves no
header-only file behind.

Two shards rather than one, because a shard names the process it came from and the two processes have
different pids — which also meant the source had to report the pid it is reading, since a recorder
defaults to its own. The merge is then free, but that was an inference from reading `buildMap` and not
a measurement, and the whole shape rests on it, so it is now a test: two shards naming one test union
its touches under a single map entry, with the files deliberately disjoint so that a merge and a
collision cannot be confused, and a second test pinning that the pid is provenance rather than
identity. Had it gone the other way, a change reaching the server half would have selected only one of
two same-named tests — under-selecting by exactly the half this work is about.

**Update** — `cbd-a3v.3.4` ran the whole path for the first time, and the two things it found
were both invisible from where the pieces had been tested.

The fixture is a service started the way a developer starts one — `NODE_OPTIONS`, nothing
imported from CBD — driven over HTTP by a japa suite, recorded from two shards and merged into
one map. Attribution is now measured rather than argued: `storeKey` lands in the first test's
window alone, `fetchKey` in the second's alone, the service's module body and listen callback in
`@load`, and `rotateMasterKey` — which V8 reports in every take with a count of zero, so the
control is real data being filtered rather than data that was never there — in nothing at all.
The `fetchKey` assertion is the one that separates a window from a running total: a take that
accumulated would carry `storeKey` into the second window too, and nothing else in the file
would say so.

Two defects came out of running it. **The recorded run never exited.** The plugin opened a socket
source and nothing ever closed it, and an open socket holds Node's event loop, so a run printed
its summary, reported every test green, and hung — measured at `bin/e2e.js` with `CBD_SOCKET_DIR`
set, against 0.06s for the same entry point without it. Output saying a run succeeded, followed by
a CI timeout, is worse than a crash. `Recorder` now closes the source it was handed, and the
adapter closes every recorder *after* the drains: closing earlier would drop the records still in
flight.

**Scripts with no source map and no projection rule were dropped from the map entirely.**
`projectPath` returns `null` for a file no rule describes, which is right when rules exist — the
file is outside the projection and nothing is known about where it came from. But
`createProjectionResolver` read an *empty* rule list as the same answer, when an empty list means
there is no projection in play at all and the script's own file is its original file. Measured: a
service whose coverage arrived over the socket carrying all six of its functions in every take,
none of which reached the map. The map was well-formed, the run was green, and every file of that
service resolved to unknown — the safe direction, escalating to `all` rather than under-selecting,
which is the direction nothing was watching. `out-maps` always carries readable maps and
`out-nomaps` is always run with a rule, so between them they had never reached the empty case.

A third finding is filed rather than absorbed, as `cbd-qly`. The instrument module is what serves
each take, so it runs inside every window it closes, and a workspace-linked map ends up mostly
made of the tool's own implementation. A published install is unaffected — CBD resolves under
`node_modules` and the default prefilter drops it, and pnpm's symlink store does not change that.
It is workspace links, and therefore dogfooding, that are exposed, so it blocks `cbd-0lu`. The
fixture's empty-window assertion is deliberately narrower than "empty" and says why in its
docblock: the defect stays visible rather than being written around.

**Update** — `cbd-a3v.3.5` measured the boundary, and the number the design was telling itself
to watch turned out not to be the number that answers the question.

*The measurement, and how it is delivered.* Drift existed on `socketSource` and nothing read it,
which is the same as not having it. The shard footer now carries it, so it is a property of the
record rather than of a caller's memory and any run can be read for it afterwards. The footer is
the one record that cannot be written where it is built: a drift is the distance between a
boundary being sent and being received, and the boundary `runEnd` dispatches is still in flight
when `runEnd` runs, so snapshotting there would report a run of N windows as N-1 — short by
exactly the teardown boundary, silently, on every run. `Windows` grew a `commitFinal` whose
builder runs when the queue reaches it, which is after every reply ahead of it has landed. The
byte-comparison test that proves the two strategies share one set of bookkeeping now names the
one place they differ and asserts why: a synchronous source answers in the tick it is asked and
has no boundary to miss, so it reports none.

*The numbers.* Five runs of the straddle fixture below: drift means 0.27–0.85 ms, worst windows
0.43–3.5 ms, against boundaries 9.4–14.6 ms apart — the tightest gap any two boundaries came to
in the run. So a boundary lands within a few per cent of the gap it opens, and the worst single
one still lands before the next boundary is sent. `minGapUs` was added to `DriftStats` for it,
because a drift means nothing alone: 300 µs is exact on a suite whose tests run for tens of
milliseconds and worthless on one whose tests run for hundreds of microseconds, and only the run
knows which it is.

*What the measurement cost, and it was the metric.* `maxDepth` reads 5 to 7 in every real run,
against a drift of a fraction of a millisecond, which cannot both be true. A trace injected into
the recorded process settled it: boundaries were written 14–88 ms apart and received 340 µs later,
while the client read the replies 40–174 ms late and six of the seven were outstanding at the last
dispatch. The cause is the first take — its reply carries the whole script table and every function
in the service, the recorder normalizes that synchronously, and the loop is not reading a socket
while it does. **`maxDepth` therefore conflates two things that are not the same**: server-side
queueing, where boundaries written behind an unserved one wait and slide, and client-side
back-pressure, where nothing moves at all. Its docblock said the depth "is the number to read";
that is false and is corrected in `DriftStats` and in `source/inspector`'s neighbour. The pair that
does answer it is `maxUs` against `minGapUs`, and the straddle test asserts it.

*The residual, which is the other half.* A service that answers and then keeps working — a
deferred audit, imported lazily so that its file can be reached by nothing else — was built to
produce the bleed on purpose. It produces it: work the server does after answering a test lands in
whichever window is open when it runs, and in the measured run that window belonged to a test that
drove nothing at all, which is then credited with a file it never caused. But it landed in a
*window*, not in `@between`, and that is arithmetic rather than luck — `@between` is the runner's
inter-test gap, some ten milliseconds, while a test's window is open far longer. Across every run
of this task, the share of the service's own execution that reached `@between` was zero. What does
reach it is CBD's own instrument module, which is `cbd-qly` and not this.

*The decision, against those numbers.* **Neither.** Not tightening: the drift is a unix-socket hop
plus one turn of the event loop, it is 3–6% of the tightest boundary in the run, and there is no
knob — the only way to remove it is to stop being out of process, which is the thing ADR-0005
chose. Not loosening: `betweenPolicy: 'ignore'` would suppress the escalation for a file reached
only by `@between`, and the measured residual it would be suppressing is zero, so it would buy
nothing today while trading a certain over-selection for an uncertain under-selection — the one
direction this project does not accept. That the cost falls where it does is worth stating
plainly though: attribution by time means an innocent test can be selected for a file only a
neighbour's leftover work touched, and the fixture pins that as the price rather than a defect.
No ADR is written, because no existing decision is superseded and no policy changes; the entry is
here, and the numbers it rests on are now in every shard a run writes.

**Update** — the acceptance run happened: grizzly's `key-server` suite, on grizzly, and it passed
its acceptance and failed something larger.

*The run.* 393 tests, 478.5 s, exit 0, recorded from two shards — 1.8 MB from the test process and
14.5 MB from the server. It ran in a clone in `/tmp`, brought up with `pnpm install` (34 s) and a
pnpm-recursive build of the server's dependency chain, then a dev-cli lane. Nothing in the live
checkout was touched and no lane of anybody else's was.

*Injection cost one line, which is what ADR-0005 said it would.* `lane effects` starts the server
with `PATH`, `HOME` and the lane's own `server.env` and deliberately not the ambient environment,
so an exported `NODE_OPTIONS` never reaches it — the template is the only hook. Two lines there
(`NODE_OPTIONS` and `CBD_SOCKET_DIR`) and a composite fastify server, importing nothing from CBD,
opened `pid-64871.sock`. Worth recording beside it: `lane up --inspect` already reports its debugger
port as **`CBD_INSPECT`**, so the dev-cli had anticipated the *attach* path first. Injection is the
path that works, because `inspectorSource`'s CDP client is still `cbd-a3v.4`.

*The acceptance, met.* 112 server functions were reached by exactly one test, across 40 files, and
the titles name the behaviour — `refuseUnlessSelfOrAdmin@0` in the dashboard API's `UserRoutes` is
attributed to the N2 test about who may PATCH `/dashboard/users/:id`, and to nothing else. The
`@between` residual is **one range out of 117,396** (0.0009%), and it is identified: an anonymous
function in the deployed copy of `PostgresStore`, run during the gap between two tests. The drift on
a real suite is better than the fixture's — 783 windows, mean 114 µs, worst 6.1 ms, against a
tightest boundary gap of 11.6 ms — which is what the fixture predicted: the longer a window, the
less a fixed hop matters.

*And then it found the thing this run existed for.* **The map is keyed by where the code ran from,
and the lane runs the server from a copy.** Grizzly's `tsc` emits inline source maps, so the copy's
`dist/*.js` resolves through the copy's own maps to the copy's own `../src/*.ts`: all 464 files in
the service shard are keyed under `.grizzly-dev/loafing-pepper/…`, 249 of them as `.ts` inside the
lane. Only 24 have a twin at the repository path, and the twin holds only what the *test process*
ran in-process. Measured rather than argued: a change to
`api/key-server/fastify/src/handlers/CreateEncrypt.ts` selects the 3 F9 tests and omits the 2
`iv-rollover` tests that reach the same handler over HTTP — disjoint sets, so the answer looks
complete and **under-selects**, which is the one failure this project does not accept. The other 269
server files match no repository path at all and escalate to `all` instead. Filed as `cbd-jmn`,
P0, and put in front of Gate B: a gate measured on all-rate cannot be measured on a map that
answers "unknown" to every server file.

The blind spot that made it possible is worth naming, because it is not a coding error: every
fixture in this repo runs code where it lives. The lane is the first environment where the
*recording* path and the *diff* path are different files, and nothing in the design had ever had to
care which one the map recorded.

Two smaller things, both filed rather than absorbed. `cbd-0gw`: 16 of the 393 tests recorded an
empty service window, and 12 of those are correct — pool tests that talk to Postgres directly,
in-process unit tests — while 4 are the `standalone-boot` group, which spawns its own server with
`startBuiltServer` and is therefore covered by nothing. And `cbd-amq`: adding the documented
one-line integration to a consumer on `@japa/runner` 5.0 fails to compile with `TS2322`, because
the adapter's structural `JapaEmitter` is not assignable to 5.0's `PluginFn` in that parameter
position. The repo's own fixture pins 5.4, where it does not arise — so the documented integration
is broken, silently, on the oldest supported version.

## 2026-10-17

**Update** — `cbd-jmn`'s direction is settled and the core of the fix has landed, recorded as
[ADR-0006](decisions/0006-relocate-a-deployed-copy.md) *before* the code. The rule is a
**relocation, not a projection**, and that distinction is the decision: a projection claims "this
script has no map, so the generated file *is* the source file" and is sound only because a 1:1 build
preserves lines; a relocation claims something weaker and comes later — a map has already resolved,
and the only claim is that the tree it resolved into is a copy of the checkout. They fail
differently, too: a misfiring projection puts a wrong line number inside a real file, a misfiring
relocation names a path that is not there. `packages/core/src/relocate.ts` applies it to the resolved
original path, after the map and before `include`/`exclude`; it never swaps extensions (a copy has
the same file names as the tree), and it matches prefixes literally, because a lane id is
user-chosen and a CI staging directory is generated per run. `CBD_RELOCATE_FROM` /
`CBD_RELOCATE_TO` are the whole knob, and they are read by the **test process** — the one that holds
the recorder, the map and the checkout.

**Update** — the reproduction now runs without grizzly, which is what the issue asked for.
`packages/japa/fixture/deployed` is a service compiled the way a lane is — `tsc`, inline source maps,
`dist/` beside `src/` — copied under a staging root and *started from the copy*, driven by three real
japa tests: one runs the handler in this process, two reach it over HTTP in the copy. That one file
is then the whole question, and `packages/japa/tests/deployed-e2e.spec.ts` records it twice, once
with the rule and once without — the pair is what makes the test non-vacuous. With no rule the map
holds two entries for one file, and a diff on the checked-in path selects the single in-process test
while the two HTTP tests are invisible: disjoint sets, so the answer looks complete and under-selects.
That is `CreateEncrypt.ts`'s 3-and-2 at fixture size. With the rule there is one entry holding all
three, and a diff on a file only the copy ever runs answers with a path the repository has instead of
escalating to `all`. 168 core tests, 55 japa tests, 42 fixture tests, all green.

Still open for this issue's acceptance: the re-run on the grizzly clone — 0 service files keyed only
under `.grizzly-dev/<lane>/`, the 269 lane-only files keyed where a repository diff can name them,
`CreateEncrypt.ts` selecting 5 rather than 3, and the `@between` residual still 1 range of 117,396.

**Update** — the fix's acceptance re-run is done, and it took three runs rather than one, because the first
comparison was not attributable and saying otherwise would have been the same sin the issue is about.

*The experiment.* `key-server` on a fresh lane, three times: the recorded pre-fix shards from the earlier
acceptance run; a **control** on the current build with no rule; and the fixed build with
`CBD_RELOCATE_FROM/TO` naming the lane. 391 passed, exit 0, in every run. Each run needs its own lane —
the instrument serves its script table as a delta since the last take, so a second run against an
already-taken service would record coverage it can no longer map.

| | pre-fix shards | control, no rule | with the rule |
|---|---|---|---|
| files the service shard holds | 464 | 334 | 334 |
| …keyed under `.grizzly-dev/<lane>/` | 464 | 334 | **0** |
| …keyed at a checkout path | 0 | 0 | **334**, every one a git-tracked `.ts` |
| map entries a test reaches | 293 | 214 | 215 |
| …keyed only under the lane | 269 | 163 | **0** |
| `@between`, server refs | 1 | 1 | **1** |
| `select` on `CreateEncrypt.ts` | 3 | 3 | **73** |
| wall time | 478.5 s | 532.9 s | 488.4 s |

*Why the first column is not the comparison line.* The pre-fix shards were written at 01:37 by a core build
from 00:34 — which predates the 00:43 edit to `source/socket.ts`, the module that owns the script table.
That build resolved 215 service scripts without a map, so they were keyed by their own `dist/*.js` path
while the same scripts were keyed by their `src/*.ts` in other windows: one file, two or three keys in one
run. Both runs on the current build resolve every service script through its map, and agree with each other
(334 files, no `.js` key at all). The difference is the recorder, not the rule, so the honest comparison is
control against fixed — the two runs that differ in nothing but the rule.

*What that comparison says.* The rule turns **334 files keyed under the lane into 334 keyed at the checkout,
every one of them git-tracked source**; the 163 entries the control could only key under the lane all key at
checkout paths now, checked file by file rather than in aggregate. `select` on `CreateEncrypt.ts` goes from
**3 to 73**, and the arithmetic is exact: the control keyed 70 tests under the lane and 3 at the checkout, the
overlap empty, and the fixed run holds 70 + 3 = 73 in one entry. The `@between` residual does not grow — it is
still **one range**, and after the fix it is named: an anonymous function in `libs/postgres/src/PostgresStore.ts`,
which is the same function the earlier run saw as `PostgresStore.js` in the lane.

*Two numbers in the issue are corrected by this, and both were mine.* "3 + 2 = 5" was an artifact of the older
recorder: it counted the lane's `.ts` key and missed the `.js` key that held 70 more tests of the same file. The
real miss was 70 tests, not 2, and the union is 73, not 5. And the acceptance line "drift stays at mean 114 µs /
max 6.1 ms" is not a property of the fix: measured across the three runs the mean is 114 µs, 188 µs and 150 µs,
so the control — which has no rule in it at all — is the slowest. One window in 783 landed 27.5 ms late against
a tightest gap of 12.0 ms; relocation runs after a take has been received, so the boundary path is untouched,
and the mean is better with the rule than without it. The number to keep is that the fix costs nothing
measurable in wall time: 478 s before, 489 s with it, 533 s for the control.

## 2026-10-17 — `cbd-0gw`, two measurements before the decision

*The child is reachable and nobody looks again.* `startBuiltServer` builds its child's environment as
`{...process.env}` laid over a few overrides (`tests/stores/lib/Auth.ts`, `childEnvOf`), so the child inherits
`NODE_OPTIONS` and `CBD_SOCKET_DIR` and announces itself in the lane's socket directory. Measured by starting a
service the way the lane's is started and then a second one the way a test's would be: `discoverSockets` returns
**two** targets, `pid 69668 role service` and `pid 69689 role service`. `CBD_ROLE` is declared in
`instrument-protocol.ts` and set by nothing in the repository, so `resolveRole` defaults every process to
`service` and the role filter in `discoverSockets` is inert — the pid is the only real guard. That is why the
child is reachable at all, and it means the variable's stated purpose (that anything in the tree which is not
the service under test "says so") is unimplemented, and cannot be implemented naively: a role is inherited down
the tree exactly as `NODE_OPTIONS` is.

*And the four measured tests would not be fixed by looking.* Every test in `key-store.standalone-boot` stops its
server inside the test body, `finally { await server.stop() }`, and the failing ones additionally
`waitUntil(() => server.exitCode() !== undefined)` — asserting the process died is what they test: a wrong
database password, an injected server error, schemas that fail to compile, a port already taken. japa emits
`test:end` after the test function resolves, so at the next boundary the child is gone and its coverage went
with it. **Every boundary-time discovery mechanism — re-scan, discover-on-empty, rendezvous listener, explicit
registration — reaches none of the four.** They need a mechanism inside the child.

*The decision, recorded as ADR-0007.* Two mechanisms, because there are two shapes: a **boundary re-scan** for a
service that is alive across a boundary (cheap — one `readdirSync` per test, and the shard header's `pid` is
read by nothing downstream, so several children share one service shard), and the **child's own snapshot left
behind at exit** for one that dies inside its window. The re-scan's attach is asynchronous while the boundary is
not, so a child born inside the window is read in full (`hello.startedAt` is the test) and one born earlier is
read from a baseline taken at attach. The harvester refuses to choose when a child's lifetime straddles a
boundary: it escalates. The role guard is reduced to the collector's own pid.

*Why this is worth a record rather than a note.* The issue's option list looked complete and was not: three of
its four options answer "which services exist" for a service that is still there to be asked. The measurement
that separated them was two minutes of reading grizzly's test bodies, and it says the acceptance criterion as
written is unreachable — the four tests never reach a handler, so what they can name is the start-up path they
ran. `cbd-0gw`'s criteria are rewritten accordingly.

## 2026-10-17 — the four tests were never instrumented, and what that changes

*The premise of `cbd-0gw` did not survive being checked.* ADR-0007 says the child a grizzly test starts is
instrumented and reachable because it inherits `NODE_OPTIONS` from the test process. It does inherit it — if the
test process is carrying it, and in a lane it is not. `laneClientEnv` (`tools/dev-cli/src/core/env.ts:87`) is an
explicit allowlist: the lane id, `TEST_API_URL`, the Postgres coordinates, the secrets, the dashboard URLs,
`CBD_INSPECT`. No `NODE_OPTIONS`, no `CBD_SOCKET_DIR`. `dev lane run` composes the command's environment as
`{...process.env, ...laneClientEnv(...)}`, and the instrument module is named only in
`tools/dev-cli/grizzly-dev.env.template`, which by its own comment starts the **server** with PATH, HOME and that
file alone. So the runner was not instrumented in any of the runs this task was filed from, and
`startBuiltServer` — `{...process.env}` over its overrides — spawned its child uninstrumented with it.

*Two independent readings of the old data agree, and neither needed a new run.* `socketSource` at install throws
when the directory holds more than one target; an instrumented runner puts its own socket in exactly that
directory, so every grizzly run would have failed at install and none did. And an instrumented process does not
exit — measured today, `CBD_SOCKET_DIR=… node -e 'console.log(1)'` under `NODE_OPTIONS` prints and then hangs,
because the instrument module's listening socket is a referenced handle — while grizzly's `bin/test.ts` calls
`process.exit` only on error, so an instrumented runner would have hung at the end of the suite. The runs exited
0 in seconds.

*What the probe did and did not show.* It started a lane-shaped service and a test-shaped child with
`NODE_OPTIONS` set explicitly on both, and `discoverSockets` returned both. That is a real measurement of the
collector's reach, and it is why the re-scan is worth building. It is not a measurement of grizzly's
environment, and reading `childEnvOf` alone could not tell the two apart: inheriting `process.env` and
inheriting the instrument are different claims, and only the second one was tested.

*So the four empty windows have a different cause.* There was no coverage to read. The missing signal is the
client environment — a dev-cli change, filed as its own issue — and only after that does the question of *when*
to look arise. Both of `cbd-0gw`'s mechanisms are still needed for those four: with the child instrumented, it
still dies inside its window (`key-store.standalone-boot` stops its server in the test body), so the boundary
re-scan reads nothing and stage 3's self-snapshot is what reaches them.

*One change was needed before any of that can work, and it is a fix in its own right.* The instrument module now
`unref()`s its listening socket. A guest that keeps its host alive after the host's own work is done is not
inert, and for a test runner that is fatal in the worst way: the suite reports every test green and the process
never returns. `server.unref()` makes the module stop being a reason to stay alive, exactly as it already
refuses to be a reason to fail to start.

*And the re-scan's own test found a defect that is still open.* `rescanningSocketSource` is built and its source
spec is green: a service that appears mid-run is attached at the boundary that discovered it, its whole life
lands in that window, later windows are deltas, script ids are namespaced by pid, and the lane keeps being read
alongside it. Under japa, the same code attaches the same target at the right boundary and the child logs the
hello and every take — and the collector's client rejects every one of them with `write EPIPE` while the child
logs no close at all. That is filed as its own defect; the two e2e tests that need it fail and the other four
pass.

*Why this is worth a record rather than a note.* A decision document that states a measured premise can be
wrong in the one place it did not measure, and the correction changes what the work is for. The probe measured
the collector; the ADR read the environment. The gap between "this environment variable is spread into the
child" and "this environment variable is set" is one grep in another repository, and it was the difference
between "nobody looks again" and "nothing was ever there to look at".
