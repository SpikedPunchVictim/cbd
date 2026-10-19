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

## 2026-10-18

**Update** — `cbd-0gw` stage 4 ran against grizzly key-server and its rewritten criterion is met. 391 tests,
527 s, exit 0, recorded from two shards (7.0 MB test process, 12.4 MB service). The lane's client environment
carried the instrument (`cbd-apq`), so the four `stand-alone-boot` tests — and the fifth in the group — finally
had a child to read.

*The group, measured.* Each of the five tests holds its own child's start-up: 434–513 touches, 235–268 of them
under `api/key-server/fastify/src` (`Config.ts`, `Server.ts`, `Routes.ts`, `OpenApi.ts`, `ServerContext.ts`).
`Config.ts` reaches exactly those five tests and nothing else. The five children lived 345–701 ms and all left
snapshots with coverage, so both of ADR-0007's mechanisms did the job they were assigned: a child alive across
a boundary is attached before it, and one that dies inside its window leaves evidence.

*The twelve that must stay empty.* Eleven of the twelve recorded no server execution at all; the twelfth picked
up a stray touch of real service code, which is the over-attribution direction this project accepts. The signal
is now masked by `cbd-qly`: almost every window carries `instrument.ts` and `instrument-protocol.ts`, because
the module serves the take after the reset. That is a separate defect and was not fixed here.

*Four defects were found by making the run possible, and all four are fixed.* They are worth naming together
because each was invisible until the previous one was fixed.

1. **Two collectors on one isolate split the counters.** `cbd-apq` puts `NODE_OPTIONS` on the test runner,
   which is how a suite's children get it; the injected module's 500 ms self-take then competes with the
   in-process source. `takePreciseCoverage` returns and resets counters for the whole isolate: measured, a
   window that ran a function twice reported `count: 1` when the other client took in between. The module now
   publishes an off switch and the in-process source stands it down, removing the socket and snapshot and
   leaving the session connected (`stopPreciseCoverage` is the isolate's switch, not the session's).
2. **A dead target's whole life was replayed into every later window.** The unnumbered snapshot fallback was
   returned at every boundary after the death: one child's start-up landed in 74 windows. Numbered windows are
   now recovered per take; the unnumbered fallback is spent once, by the window that discovered the loss.
3. **A child too short-lived for the interval left nothing.** Three of five children lived 305–404 ms, less
   than one 500 ms tick, and their snapshots held scripts but no coverage. `process.on('exit')` can take
   coverage synchronously when the session is in the same process — measured, three calls reported as
   `count: 3` from inside the handler — so the final snapshot is exact for a normal exit. ADR-0007's
   feasibility paragraph, which said this was impossible, is corrected.
4. **A large reply could stall in the socket buffer.** A child's first take carries its script table and
   produced a 400 KB reply; the collector received 172 KB and stopped, because the synchronous snapshot write
   after it blocked the loop that had to flush the rest. Per-take recovery by number makes that a slower path
   rather than a lost window; the order stays reply-then-snapshot so the client's wait does not include the
   write.

*The cost, named.* The service shard's drift is 783 windows, mean 1.16 ms, worst 30 ms, depth 18, against a
tightest boundary gap of 15.6 ms. Before the snapshot-per-take mechanism the same suite measured 114 µs mean;
the difference is the 12 MB script table written after every served take, on the server's own loop. The worst
case now exceeds the tightest gap, which is the fact `cbd-a3v.3` exists to report rather than hide. The obvious
next step is to stop rewriting the whole table per take; filed rather than absorbed.

*One flake, recorded.* An earlier full run of the same code lost one lane-driven test ("should get all
KeyRings with cursor pagination", a 500 from the server) and reported a 548 ms worst drift. A clean rerun
passed 391/391 in 527 s with the numbers above, so it is recorded as load-sensitive rather than attributed.

**Update** — `cbd-3z1` removed the snapshot cost, and `cbd-a3v.3` closed on the numbers rather than on the
fixture's.

*What was rewritten, and why it was the table.* The snapshot's job is to hold what a reply has not: a process
can die between writing a take and the client reading it. It was writing the full `Debugger.scriptParsed`
table on every served take alongside that evidence — 4770 rows and 12 MB on the lane server — and the write
is synchronous on the service's own loop. The table is not what a reply has not delivered: an acknowledged
take's reply carried its rows and the collector absorbed them. So rows are now kept with the unacknowledged
window that delivered them, dropped on `ack`, and the file carries the union of those plus `pending`. The
first take before any ack still writes the table (nothing else has delivered it); every take after the first
ack writes its own window.

*Measured at fixture scale, the property the change is for.* The core fixture service parses 146 script rows.
Its first snapshot is 115,544 bytes; after the take is acknowledged, the next take's snapshot is 15,692 bytes
and carries 0 script rows — the remainder is the window's own coverage, which is the evidence the file exists
for. The unit test pins both directions: the pre-ack file equals the reply's rows, and the post-ack file
repeats none of them.

*On grizzly, not re-measured in this entry.* The mechanism and its local bound are what changed; the suite
re-run that would put a new mean and max in the footer is Gate B's (`cbd-2ev`), which now reads drift from
every run. The prediction is specific and falsifiable: the boundary immediately after the first take still
pays for the table, and every later one should return to the 114 µs regime — so a re-run should show a mean
near 114 µs with one outlier of about a millisecond, not a mean near 1.16 ms.

*The decision `cbd-a3v.3` exists for, unchanged.* Neither tighten the boundary nor loosen the policy. The
drift is the socket hop plus one turn of the event loop, 3–6% of the tightest boundary before the snapshot
regression; `betweenPolicy: 'ignore'` would suppress an escalation whose measured residual is one range in
117,396 and trade a certain over-selection for an uncertain under-selection. What the regression showed is
that the boundary's cost can be made to overrun the gap by work that is not the boundary — an argument for
keeping the instrument's per-take work bounded, not for moving the boundary. With `cbd-3z1` in, the numbers
rest where the decision was made.

*cbd-jmn and `cbd-a3v` closed on the same day's evidence.* The deployed-copy run keys its files at checkout
paths (334 of 334), one logical file with evidence under two paths is one entry holding the union (73 = 70 +
3 for `CreateEncrypt.ts`), and the `@between` residual stayed at one range. Core is 177 tests and japa 61,
with the new snapshot test in core; the whole workspace builds.

**Update** — Gate B (`cbd-2ev`) was measured on the retargeted suite, and the target is not met with a margin.

*The recording.* The target is the stores suites `npm test` runs plus `signing`: key-server, auth-server,
user-service, assets, dashboard-api, integrations, signing. A fresh dev-cli lane in the `/tmp` clone, the CBD
plugin on the test runner and the instrument in the lane's own `server.env`, recorded 2588 test records —
2573 passed, 1 failed (a dashboard-api keyring lookup) and 14 skipped/todo. The map has **2565 green tests,
472 files with per-test evidence, 508 files seen**, from a 13.8 MB test shard and a 53.1 MB service shard.
The run took 2208 s, and that number is **not** T_full: it is the recording path (socket takes plus the
synchronous normalize of the service payload), and `cbd-7yd` owns the comparison. Gate B's numbers are
test-count based, so they do not depend on it; the wall-clock ratio does, and is not claimed here.

*The method.* One map, at the clone's HEAD (`38c6aebe`), and a range of non-merge commits. For each commit,
`git show --unified=0` gives the changes; `select` runs with `unknownPolicy: 'all'`, `betweenPolicy: 'all'`
and the §8.3 `alwaysAll` globs. `P(all)` is the share of commits that escalate among commits touching the
include scope. `r` is `|testsForLine(map, file, line)| / |tests|` for every changed line; lines in an
escalated commit count as 1, because the run does run all of it. `S = (1-P)(1-r)` over the lines the selector
*answered*; escalated lines are `P` and must not be charged twice. `r` over all lines is reported separately
because it is what a developer feels: the fraction of the suite one changed line runs.

*The scope is the knob, so the spectrum is the result.* Documentation (`.md`, `.example`, `.txt`) is out —
a README is not code the runtime loads. Test files are the suffixes that define tests, not everything under a
`tests/` directory (see the defect below). "Loaded packages" means the workspace packages the recorded run
actually touched.

| map | include | commits | P(all) | r answered (mean/p50/p90) | S | r all lines |
|---|---|---|---|---|---|---|
| key-server only (390 tests) | loaded packages | 1000 | 96.3% | — | impossible | 100% |
| full suite | `api` + `libs` + `sdk` + `stores` + `tests/stores` | 1000 | 74.7% | 12.4 / 6.0 / 32.5% | 22.2% | 80.8% |
| full suite | loaded packages | 1000 | 31.6% | 11.9 / 6.0 / 32.5% | **59.9%** | 51.3% |
| full suite | loaded packages | 3000 | 39.5% | 15.2 / 8.3 / 32.5% | **51.2%** | 92.0% |

*What the numbers say.* The selector is good where it answers: a changed line inside a mapped function runs
**6.0%** of the suite at the median (11.4% over the longer range). The problem is entirely escalation.
Unknown-file is the reason in 79 of the 100 escalated commits over the month, `load` in 8, `always-all` in 13;
in the week it is 22 unknown, 3 load. The files are real and in scope — `libs/core/src/KeyStore.ts`,
`sdk/src/stores/File.ts`, `api/key-server/service/src/KeyService.ts`, the rate-limit services, migration
index files — code the suites do not execute, so the map cannot answer for it and §8.3 escalates. A change to
each of those runs all 2565 tests.

The longer range is worse than the shorter one, and the reason is line weighting: 53,622 of 59,230 changed
lines sit in escalated commits, because a handful of large commits in that month touch exactly those unknown
files. `P(all)` by commit is 39.5%, just under the 40% line that makes the target impossible; by changed line
it is 90.5%. The gate is a knife edge at one week (59.9%) and fails at one month (51.2%), and the wider scope
fails outright. **Gate B is not passed with a margin.** Whether a 60% floor is the right demand, and whether
a suite that does not execute a third of its own backend's changed files can meet it, is the decision
ADR-0004 put here.

*A defect the measurement found.* `select`'s default `testFiles` includes `**/tests/**`, which calls every
helper and fixture under a tests directory a test file. Rule 3 then asks for "every test defined in it", the
helper defines none, and rule 7 escalates — even though the map has per-test evidence for that helper. The
stores suites keep 16 helpers under `tests/stores/lib/`; with the default glob, `tests/stores/lib/Auth.ts`
alone escalated 19 commits in the sample, and the tuned glob moved `P(all)` from 58.0% to 31.6%. It was fixed
the same day as `cbd-e9l`: rule 3 now applies only when the file actually defines tests in the registry, and a
helper falls through to the map rules (two tests in `select.spec.ts`). The table above is re-measured with
`select`'s **defaults** after that fix, and reproduces the tuned number exactly — `P(all)` 31.6%, and S moved
by 0.2 points only because the default glob classifies 38 more lines as test-file lines.

*What this does not settle.* The map is at HEAD and the range is historical, so a function whose lines moved
between the commit and HEAD can be misattributed; files added or deleted since the map commit are answered as
unknown, which inflates `P(all)` rather than flattering it. `include` is a choice, and ADR-0004 warns it is
the one that moves the number; the table is the answer to that warning. `cbd-vqc`'s replay harness is what
removes the map-at-HEAD approximation, and the full-run overhead is `cbd-7yd`.

*The tuned include, for reproduction.* The 29 prefixes are the workspace packages the recorded run loaded:
`typescript/api/{admin,api-utils,assets,asym-key-server,auth-server,dashboard-api,fastify-server,fastify-utils,integration,key-server,sdk-server}`, `typescript/libs/{activity-mix,asset-signer,asset-verify,assets,core,leases,netguard,password-store,postgres,postgres-fuse,pqc-native,pqc-noble,secret-cipher,test-kit/src/MockIdp.ts}`, `typescript/sdk`, `typescript/stores`, `typescript/tests/{harness-engine,stores}`; the four stores specs not in the recorded suites are excluded. Command: `node packages/core/scripts/gate-b.mjs --repo <grizzly> --shards <shard-dir> --range 1000 --include <list> --exclude <four specs> --exclude-ext md,example,txt --json <out>` (no `--test-files`: the measured rows use `select`'s defaults after `cbd-e9l`).

**Update** — the all-rate by reason, and by file (`cbd-0l1`). The reports already carried
`allRate.why`; the useful cut is which files put a commit there. Re-read from
`/tmp/cbd-exp2/report-fix-{1000,3000}.json` (the fixed `select`, no shard parsing):

| range | escalated | unknown-file | load | always-all |
|---|---|---|---|---|
| week (1000) | 24 / 79 | 33 occurrences over 12 files | 5 over 4 | 1 |
| month (3000) | 99 / 253 | 175 over 50 | 30 over 20 | 47 over 23 |

`unknown-file` dominates and is concentrated: `libs/core/src/KeyStore.ts` (19 commits in the month),
`libs/leases/src/types.ts` (17), `api/key-server/service/src/KeyService.ts` (14), `sdk/src/stores/File.ts`
(8), then the two `postgres-fuse` migration index files (7 each), `netguard/src/GuardedSocket.ts` (6),
and `sdk/tests/rest-asset-store.spec.ts` (6). `load` is mostly migrations and
`tests/stores/bin/test.ts`; `always-all` is manifests and tsconfigs, as configured. So the lever
these numbers point at is not a selection rule: the files are real, in scope, and code the stores
suites do not execute. Escalating them is the map being honest. A rule change there would trade a
certain over-selection for an uncertain under-selection; the choices are a wider suite or an explicit
acknowledgement, which is ADR-0004's decision and not a selector bug.

Two details worth keeping. `alwaysAll` here is Gate B's own list, which does **not** include
`**/migrations/**` or `tests/**/bin/*.ts` (the example config does); adding them moves those files
from `load` to `always-all` and changes no outcome, because both force `mode: all`. And a commit can
escalate for more than one reason (8 of 24 in the week, 41 of 99 in the month), so the reason counts
do not sum to the commit count.

**Update** — `cbd-qly` is fixed: the tool no longer records itself, and fixing it exposed a boundary transient it had been hiding.

*The mechanism.* Each package names its own implementation roots — core in `src/self.ts` by walking
up to the `package.json` whose name matches, so `src/` and `dist/src/` work without counting `../`
hops — and `scan` applies them as a **floor**: core's roots always, an adapter's roots added by
`beginShard`, and a caller's `prefilter` can narrow the scan further but cannot opt the tool back in.
The roots are matched in both spellings (as given and realpath) because a synthesized payload and a
macOS `/tmp` can disagree with Node's canonical URL. Deliberately the package's `src` and `dist/src`,
not its root: this repository's hermetic tests use in-package fixtures as the code under test, and a
floor over the whole package dropped `backgroundWork` from the in-process spec — a failure that is
itself the evidence the narrower roots are the right line.

*What it removed, and what that changed.* The instrument module was in every service window and the
adapter/recorder in every test window; now `japa`'s recorded shard and the straddle service shard
both assert that no touch is under either package. Two assertions in the straddle e2e had been resting
on the defect, and both were corrected rather than widened: the drift completeness check compared
`drift.windows` to **records**, but a recorder takes `2n + 1` boundaries for `n` tests (load, each
test's end, each subsequent test's start, teardown) and writes nothing for an empty bucket — it only
ever matched because CBD's own rows made the empty buckets non-empty. It now compares to the takes.
And the "@between window exists" guard was removed: `@between` being empty is now the result, and
`map.seen` is the non-vacuity guard.

*The transient the fix revealed is `cbd-h09`.* With the collector no longer normalizing ~10ms of its
own rows per window, the service's back-to-back boundaries bunch at about 1ms, and the first take's
7.4ms start-up cost (every parsed script plus a cold inspector) makes the second and third boundaries
drift 5-6ms. The work lands in the preceding bucket, which escalates — the safe direction — but the
fixture now gives its first test 50ms so the drift assertion measures steady state, and the transient
is recorded in `DriftStats` and filed rather than smoothed over.

Core 183, japa 63, mocha 2; workspace build clean; `smackdebt` unchanged. `cbd-0lu` (dogfooding) is
unblocked by this.

**Update** — `cbd-awg` landed the surface ADR-0003 promised: one factory, five verbs, two tiers.

*Tier 1 — `createCbd(config)`.* `build`, `select`, `explain`, `stats`, `verify`, all returning plain
data. Config binds `root`, `stateDir` and the selection config once. `build` merges the shards under
`<stateDir>/shards` whose header names the target commit (an explicit `shards` list bypasses the
filter), refuses an interrupted shard unless `partial`, records whether the tree was dirty (ignoring
the state directory, which is an artifact), and writes `<stateDir>/maps/<commit>/map.json`.
`select` loads the **nearest ancestor of HEAD with a map** rather than demanding one at HEAD — a
developer selects between recordings — resolves git's repository-relative paths into the map's
absolute coordinates (the bug the first test run caught), and passes the commit distance so
`maxAgeCommits` can fire. `explain` answers a file or `file:line` from `testsForFunction` /
`testsForLine` and names the bucket a file was reached by. `stats` counts tests, files, seen files,
untested ones and the per-test-file distribution. `verify` takes outcomes as data and delegates to
the pure core function; nothing in the core spawns a suite.

*Tier 2 — `@spikedpunch/cbd/adapter`.* `Recorder`, the sources (in-process, socket, rescan,
inspector), the sinks, `parseShard`, the normalizer, the self roots and `scanFromEnv` moved out of
the package root. The root is now the factory, the map and its queries, the diff, the selection and
the shard *types* `buildMap` consumes. japa, mocha and the measurement scripts import the seam from
the subpath, so the boundary is exercised by every adapter on every build. `CoverageMap.dirty` is
additive and optional, so `MAP_VERSION` did not move.

Core 193 tests (10 for the factory), japa 63, mocha 2; workspace build clean; `smackdebt` rates the
factory a watch for size and no high findings.

**Update** — `cbd-uyb`: `cbd.config.json` and its schema.

`loadConfig` reads one committed file at the repository root and returns a `CbdConfig` for
`createCbd`; a missing file is the safe default, a malformed one is an error. `parseConfig` is the
pure validator, so the CLI's `--config` and tests share one set of checks. Repository-relative
globs are joined onto the canonical root once, because the map is keyed absolutely; `include` and
`exclude` compose into the single predicate `select` takes. Unknown keys and unimplemented values
are refused (`granularity: "group"` says it is a B2 lever, not a typo), and policy values are
limited to the two the selector implements. The schema ships at
`@spikedpunch/cbd/cbd.config.schema.json` for editor autocomplete; there is no validator
dependency, and no config verb. Core 199 tests (6 for the config).

**Update** — `cbd-63j`: the `cbd` binary.

`@spikedpunch/cbd-cli` is one entry point over four commands (`build`, `select`, `explain`, `stats`),
each resolving the config the same way, calling one `createCbd` verb and rendering on the way out.
`--format json` prints the verb's own result rather than a second rendering, so a human and a script
cannot be told different stories; text keeps the §9.2 rule of one line per selected test plus a
summary.

**Exit codes are the interface, not output parsing.** `select` exits 0 for a subset and 3 for "all";
a failure (no map, not a repository, unreadable config) exits 1 and a malformed command exits 2.
Keeping "all" distinct from "failed" is what lets CI branch on `cbd select` without skipping the
suite when the tool breaks. Warnings go to stderr so a pipe cannot mistake them for tests.

Two small surface changes made this honest rather than a second implementation:

- `SelectResult.selected` resolves `selection.tests` against the map the call already loaded. Without
  it the CLI — and a selection file an adapter would read — had to re-read and re-parse the map for
  titles the call had in hand. `selection.tests` stays the index identity japa uses.
- `loadConfigFile(path, root)` is the explicit-path half of `loadConfig`, which is now its default
  path. `--config` that names a missing file is an error; the default `cbd.config.json` may be
  absent, as before.

`--no-worktree` diffs the map commit with HEAD instead of the dirty tree; `--worktree` remains
accepted so a script can spell the default. Argument parsing is hand-written and rejects unknown
flags per command (`cbd stats --partial` is a usage error), because a silently ignored flag is the
same class of bug as an ignored config key.

CLI 15 tests against real git and a real map (build → select → explain → stats, both exit codes,
JSON, config, usage errors); core 200, japa 63, mocha 2; workspace build clean. `smackdebt` puts one
watch on `takeFlag` (a parser, cyclomatic 12) and no high findings in the package.

**Update** — `cbd-pfu`: `cbd collect` and the select/collect/build policy.

`cbd collect -- <test command>` resolves the selection first, spawns the suite with CBD's
environment, and merges the shards in the same process afterwards. The policy is the standing goal
in one command: **select on, collect opt-in, build on**. Collection is opt-in by the fact that you
ran `collect`; once you did, narrowing the run (`--no-select`) and merging the map (`--no-build`)
are what the command is for, so both are on and each has an off switch.

*Crossing the process boundary.* The selection is written to `<stateDir>/selection.json` and its
path passed as `CBD_SELECTION`; the japa plugin reads it when no explicit `only` is given. A file,
not the titles inline: unix caps one variable at ~128 kB, which a few thousand titles reach. The
reader refuses an empty list, because japa reads an empty filter as "run everything" — the safe
direction, but not what a caller who selected nothing asked for, so `collect` does not spawn at
all when the subset is empty.

*Build is in-process.* A detached build racing the next reader is a half-written map, which is a
silent wrong answer; a slow `collect` is merely slow. A child killed by a signal never wrote its
footer, so nothing is built and the command says which signal — `parseShard` would refuse the
shard anyway.

*A missing map is a full recording, not a failure.* CBD.md §10's rule, and the first run of any
repository is exactly that case. `nearestMapCommit` was extracted from the factory's private search
so `collect` and `select` answer "which map" the same way.

`CBD_SHARD` and `CBD_COMMIT` are absolute so the child's working directory does not matter. The
test command's status is `collect`'s status (a failing suite still leaves a usable map, because
non-green windows are excluded by `buildMap`). The mocha adapter does not read `CBD_SELECTION` yet,
so a mocha suite under `collect` runs everything — safe over-selection; filed as `cbd-dap`.

Core 204 (4 for `CBD_SELECTION`), japa 66 (3 for the plugin's environment path), cli 24 (9 for
collect), mocha 2; workspace build clean. `smackdebt`: no high findings; two watches, both argument
dispatch (`takeFlag`, `run`).

**Update** — `cbd-0lu`: dogfooding CBD on the fixture suite.

The fixture is now a real consumer: `fixture/bin/test-maps.js` installs `cbd()` the way a user does
(one plugin line, inert without `CBD_SHARD`/`CBD_SELECTION`) and `fixture/cbd.config.json` states the
selection scope. `cbd collect --no-select -- node bin/test-maps.js` recorded **42 tests** (a skipped
test is excluded, correctly) into **26 reached files**, 27 seen, 1 seen-but-untested; buckets: load 28,
between 4, teardown 2; test files 14 (median 3, p90 5, max 5).

**Selection on known answers.** Nineteen edits, one per function: every one was a subset of
**1–4 tests of 42** (median 1–2), with the expected titles. Twelve file-level probes (a change outside
every function) gave 9 subsets of 1–8 and 3 `all` answers, each structural:

- `src/index.ts`, the barrel: reached at `@load`, so rule 2 escalates — startup code, correct;
- `src/types-only.ts`: erased at runtime, never loaded, so unknown-file — `alwaysAll`-style safety;
- `src/uncovered.ts`: never imported by any test, so unknown-file, **not** rule 6's `untested`. The
  inverse map can only call "untested" a file it has seen; a wholly unimported file is
  indistinguishable from unknown. Conservative and documented, but the inverse map under-reports
  them — worth remembering when `cbd-mm3` renders it.

**One real bug, found and fixed.** Changing `data/settings.json` selected **nothing** although
`alwaysAll` named `data/**`: `select` checked `include` first, and the documented example config lists
migrations in `alwaysAll` while `include` covers only `src/**` — so every such always-all file was
dropped before rule 1 could fire. That is under-selection, the dangerous direction. Rule 1 now runs
before the include gate, and the factory keeps an always-all change even outside the scope filter. The
same probe now answers `all tests: always-all (data/settings.json)`, exit 3.

**Two smaller findings.** A source-mapped test file (`tests/math.spec.ts`) does not reach rule 3: the
registry names the executed path (`out-maps/tests/…`), the change names the source. Rules 4/5 still
answered precisely (the edited test's own callback, 1 test) and the file-level fallback would have
given the same set rule 3 would, so this is precision, not a miss. And a change to a test *module* in
`src/` behaves as designed.

**What could not be dogfooded, and why.** CBD's own `packages/core` and `packages/japa` suites cannot
be their own subject: `cbd-qly` excludes the tool's implementation roots as a floor, exactly so the
recorder's own execution does not dominate a map. A self-run would map the tests, not the tool, and
every change to the tool would be unknown-file → `all`. The fixture is the real consumer available
now; the grizzly stores suite remains the target once Gate B clears.

Core 207 (one select test for the always-all ordering, one factory test for the include scope), japa
66, cli 24, mocha 2; workspace build clean.

**cbd-m5l** — request-id correlation, and the I1-I4 scenario harness.

*The decision.* I2's "request-id header" is built as ADR-0008: the test window names itself,
the instrument in the service reads that name and takes a tagged window at each request
boundary, and the recorder credits each delta to the test that sent it. The mechanism is
instrument-level (`http.Server.prototype.emit`, below every Node framework) because a
service-side middleware would need one adapter per framework and would only see requests the
consumer routed through it. No new `createCbd` verb and no shard change: the join is resolved
live into ordinary `test` records that `buildMap` already unions by title and file.

*What the wire carries.* `TakeResult.ids` is the set of requests in flight when the boundary was
crossed, so coverage another test's boundary happened to take still credits its sender;
`TakeResult.requests` are the deltas the instrument took on its own at request start/end. Each
is a set, not one id, because `takePreciseCoverage` resets one counter for the isolate and
concurrent requests cannot be separated — attributing to the set over-selects, picking one
guesses. The tags are kept on the unacknowledged window in the snapshot, so ADR-0007's
recover-by-take-id still returns them; queued request windows that no reply has delivered sit in
the snapshot's `pendingRequests` and are read by the unnumbered fallback.

*The test side.* `Correlator` names a window `<pid>-<n>` and remembers its owner. The plugin
installs a patch on `http`/`https` request/get and `fetch` that adds `x-cbd-correlation` only
while a window is open, never overwriting a header the caller set, and releases it at
`runner:end`. An id no owner resolves becomes `@between` — the escalation §8.3 already defines,
never a dropped window.

*Two bugs the measurements found.*

- **The instrument imported `https` into every service.** Correlation's constants lived beside
  the client patch, so the injected module loaded `https`/`tls` at start-up. The straddle
  fixture, whose subject is the first take's cost, began failing its drift gate. The constants
  moved to `instrument-protocol.ts` (no runtime imports); the instrument loads `http` alone.
  This was confirmed against a baseline worktree at `b827374`: 10/10 passes before, a 50%
  failure rate after, and 4/5 + a stable 10/10 after the move and the assertion change below.
- **A spawned service could lose the race to the `correlate` op.** The collector configures an
  already-running service with an op; a child a test spawns only got it when the re-scan
  attached, and on the own-service fixture the request could precede the attach, putting the
  handler's work in the child's first (whole-life) take credited to the *previous* test. The
  plugin now exports `CBD_CORRELATION_HEADER` to the runner's environment before tests, so a
  child inherits correlation and installs it at start-up; `HelloResult.correlating` lets the
  collector skip the redundant op, which also removes a round trip from the attach path. The
  own-service fixture's first test now holds its window 100 ms — the re-scan interval is 25 ms —
  so it measures the attribution rule rather than the scheduler.

*A pre-existing flake, measured rather than attributed to this work.* The straddle gate
`maxUs < minGapUs` fails under load on the baseline too: the pre-existing worktree recorded
3.9-11.7 ms maxima at windows 4-7 against gaps of 1.3-2.3 ms, while the mean stayed in the
hundreds of microseconds. The assertion now uses `meanUs` (the steady-state cost the design
claims); `maxUs` is still in the footer. The straddle run also sets `CBD_CORRELATION=off`,
because its subject is the time-based boundary and correlation adds a take per request.

*The harness.* `packages/cli/tests/scenarios-e2e.spec.ts` builds four real repositories under
`packages/cli/.scenario-tmp` (gitignored), each with a real japa entry point, and drives
`cbd collect` and `cbd select` as processes:

| scenario | shape | assertion |
|---|---|---|
| I1 | an HTTP server in the test process | `price` reaches the one test; a change selects it |
| I2 | a request fired by one test, finished by the service during the next | `handlePrice` reaches **only** the sender |
| I3 | a worker the suite forks, discovered by the re-scan | `crunch` reaches the spawning test |
| I4 | a queue consumer with no request boundary | the work is `@load`, and a change answers `all` (exit 3) |

I2's decoy is deliberate: the service delays 150 ms and does the handler work *after* the delay,
so time-based attribution would credit the next test. I4 asserts the escalation, not merely that
the work was recorded.

Core 215 (6 `Correlator`, 1 instrument request window, 1 recorder attribution), japa 66 (the
own-service fixture's window wait and the straddle assertion), cli 28 (4 scenarios), mocha 2;
workspace build clean. `smackdebt diff b827374`: no high findings; watches are the pre-existing
argument dispatch (`takeFlag`, `run`) plus `hasHeader`, `handle` and the plugin's setup — all
below the high threshold. The only `better` unit is `select`, from the earlier rule-1 move.

## 2026-10-18 — `cbd-mm3`: the inverse map's untested half is named

**Update** — `cbd stats` used to count the files no test reaches and stop there. It now names them,
sorted, as `untestedFiles` in the verb's result and one relative path per line in the text output.

*What the map can and cannot say.* A file is `untested` only if it appears in `map.seen` — some
recorded process loaded it — and has no function entry any test touched. That is the inverse map's
honest limit: a source file no run ever imported leaves no evidence, so it is absent from the list
and indistinguishable from a file the map has never heard of. `select` answers the two cases
differently (nothing versus everything), which is why the text output carries
`a file no run loaded is unknown, not untested: select runs all for it` rather than letting the list
read as "everything else is covered". Adding a `git ls-files`-based unmapped count was considered and
rejected for this task: `include` defaults to the whole repository, so such a list would mostly be
documents and erased type-only modules, and the design's own fixture (`src/types-only.ts`) is exactly
the file it would mislabel.

*The zero answer in `explain`.* `explain` already listed each function with its tests or `no tests`,
but a zero answer did not say which zero it was. It now says `(seen, no test reaches it)` versus
`(not in the map: select runs all)`, and a line query in a file with no function evidence says
`nothing in the file was executed` instead of the misleading "outside every function: the whole
file's tests" (which is true only when the file has tests at all).

Tests: core 215 (`factory.spec` asserts the count and the names agree), cli 31 (three new: the named
list and its footer, the JSON carrying every file rather than a count, and both zero answers from
`explain`). Workspace build clean.

## 2026-10-18 — `cbd-vax`: retention for shards and maps

**Update** — `cbd gc [--keep <n>]` prunes `<state>/shards/*` and `<state>/maps/<commit>/`, keeping
the newest `n` of each by mtime (default 10). A shard is tens of megabytes on a real suite; maps are
small but were equally unbounded.

*Two safety properties, both tested.* The map `select` would read — `nearestMapCommit`'s answer — is
kept even when it is older than the newest `n`, because maps from another branch can be newer while
the map this repository's next selection depends on is not; removing it turns a working selection
into "no map in the last 200 commits". And the candidate sets are narrow by construction: regular
files directly in `shards/`, directories directly in `maps/`. Anything else in `.cbd` is not gc's to
delete.

*Ordering and validation.* mtime rather than the shard's name, because a shard written by hand or by
another adapter need not follow `collect`'s naming. `--keep` must be a positive integer: zero is the
value a typo produces that deletes the map the next command needs, so it is refused rather than read
as "remove everything". An absent state directory is an empty pool, not an error.

Core 215, cli 36 (five gc tests: pools and bytes, the essential map, the empty case, the text line,
`--keep` validation), japa 66, mocha 2; workspace build clean. `smackdebt packages/cli/src/gc.ts`
and the baseline diff stay at the pre-existing watches.

## 2026-10-18 — `cbd-dap`: mocha reads `CBD_SELECTION`

**Update** — `@spikedpunch/cbd-mocha/auto` now applies the subset `cbd collect` writes, so a mocha
suite under collect runs the selected tests rather than the full suite. Before this, selection was
safe but absent for mocha: the run was over-inclusive, never a miss, but the speedup was zero.

*Why one regexp is enough.* Mocha's single `grep` is tested against `test.fullTitle()` — the exact
string the adapter records — so an anchored alternation of the map's titles selects precisely the
mapped set. Each title is escaped before it is joined: a title is data, and `it('adds 1 + 1')` must
not match `adds 11`. The pattern refuses an empty list, because mocha reads "matches nothing" as
"run no tests", which is the direction the project refuses.

*Selection and recording were separated, as in the japa plugin.* The module previously did nothing
unless `CBD_SHARD` was set; it now also patches `Mocha.prototype.run` for a selection-only run. The
two variables are independent inputs, and a recording is what `cbd collect` always asks for, not
what selection requires.

*Two filters cannot be combined safely, so the selection wins.* A consumer's own `--grep` is
overwritten by the selection: intersecting them could only narrow the run below the set collect
chose. `--invert` is the case that cannot be overridden — mocha exposes no way to unset it, and the
complement would skip every selected test — so a selection plus `--invert` stops the run with a
message rather than measuring the wrong set.

Mocha 8 (3 `selectionPattern`, 2 selection e2e, 1 refusal, plus the existing 2); core 215, japa 66,
cli 36. `smackdebt` on `packages/mocha/src` is clean.

## 2026-10-18 — Gate B, experiment 1: the escalations are mostly map artefacts

**Update** — the Gate B JSON was regenerated from the saved shards (`/tmp/cbd-gateb`, map at
`38c6aebe`) and every escalated commit was classified by the files that forced it. The measured
P(all) reproduces: **31.6%** over one week (25/79, S 60.2%) and **39.5%** over one month (100/253,
S 51.3%). What the headline hides is where the escalation comes from.

| category of unknown file | week: reason entries | month: reason entries | fixable by |
|---|---|---|---|
| absent at the map's commit | 5 | 5 (11 unique) | a current/replayed map |
| types-only, erased at runtime | 4 | 14 | a policy for no-runtime-export files |
| data file read by tests | 1 | 1 | a policy, or mapping reads |
| suites that were not recorded | 5 | 7 | recording `rate-limits` / `integrations-resilience`, sdk tests |
| migration runner / seed code | 5 | 14 | instrumenting the runner or excluding it |
| runtime modules with no evidence | 16 | 35 | unknown — see the issue below |
| policy escalations (`load`, `always-all`) | 3 | 8 | nothing; they are the correct answer |

*What the numbers become.* Over the week, only **2 of 25** escalated commits are policy-correct;
the other 23 involve an unknown file, and 20 of them would be answered if every unknown-file
artefact were removed. P falls from 31.6% to **6.3%** (S ≈ 83%). Removing only the provable
artefacts — absent, types-only, data, unrecorded suites, migration runner — and leaving the
unexplained modules escalating gives **16.5%** (S ≈ 74%). Over the month the tail is longer and the
HEAD-map approximation is under more strain: provable artefacts alone take P to 33.2% (S ≈ 57%),
and removing every unknown leaves 25.7% (S ≈ 63%). So the week clears the floor once the input is
fixed; the month does not clearly, and it is the sample the replay harness exists for.

*The one anomaly worth an issue.* Four modules (`libs/core/src/KeyStore.ts`, `SigningPolicy.ts`,
`api/dashboard-api/src/Config.ts`, `libs/postgres/src/Utils.ts`) are absent from coverage although
the map saw their importers — 30 package barrels executed, including `libs/core/src/index.ts`,
which re-exports values from `KeyStore` and `SigningPolicy`. Both `tsc` and SWC emit eager
`require` for those re-exports, and a direct check confirmed V8 reports the module body when the
barrel is loaded. Either those modules loaded before coverage started (an `--import` ordering
window), or a script was dropped in resolution. This is not B2's problem and not a policy choice; it
needs one instrumented re-run with the take's script table retained.

*Conclusion for the gate.* The selector is not what fails: on the lines it answers, the median
change runs **6.0%** of the suite. The measured all-rate is dominated by the map's blind spots and
by the scope choice. The 60% floor question remains a human decision, but it should be answered on a
replayed, whole-suite recording — not on this number.

Reproduction: `node packages/core/scripts/gate-b.mjs --repo /tmp/cbd-grizzly --shards /tmp/cbd-gateb --range {1000,3000} --include <the 29 loaded packages from the entry above> --exclude <integrations-resilience, rate-limits, store, perf specs> --exclude-ext md,example,txt --json /tmp/cbd-gateb/report-<range>.json`.

## 2026-10-18 — Gate B, experiment 2: recording the missing suites barely moves it

**Update** — the two suites the recording omitted were run with CBD against fresh lanes
(`rate-limits` on a `--rate-limiting` lane, `integrations-resilience` on a normal one), their
shards merged with the original pair, and the gate rerun with only `store.spec.ts` and
`perf.spec.ts` still excluded. The map grew from **2565 to 2638 tests** and **508 to 511 seen
files**; `RateLimitPlugin.ts` is now seen. The gate moved by one escalation.

| range | P(all) before → after | r before → after | S before → after |
|---|---|---|---|
| 1 week | 31.6% → **30.4%** (25 → 24 of 79) | 11.9% → 11.6% | 60.2% → **61.5%** |
| 1 month | 39.5% → **39.1%** (100 → 99 of 253) | 15.2% → 14.8% | 51.3% → **51.9%** |

*Exactly one commit cleared* (`44066d44`, which touched only `RateLimitPlugin.ts`). The others that
looked like unrecorded-suite cases did not: the rate-limit commits also touch `RateLimitStore.ts`,
which is absent at the map's commit, and the leases commits touch `Columns.ts`, which the resilience
suite did run past — `libs/leases/src/index.ts` is seen and re-exports `addLeaseColumns` from it, so
this is the **same blind spot as `cbd-1ci`**, now with a second independent example. `Columns.ts`
remained unknown even though the suite that exercises it was recorded.

*The failures are environmental.* 1 of 29 rate-limit tests failed on a window-timing assertion
(500 served vs 502); 21 of 64 resilience tests failed connecting to a collector, Loki, Elasticsearch
and an authorization server that the lane does not start. A failed test's window is excluded from
the map by design, and the leases tests were among the 43 that passed.

*What the week still looks like after experiment 2.* Unknown-file reason entries: residual modules
(the `cbd-1ci` pattern) **18**, absent-at-HEAD **5**, types-only **4**, migration/seed **5**, data
file **1**; 3 policy escalations plus the always-all/load answers remain correct. Eight commits are
residual-only. If `cbd-1ci` were fixed, P would fall to roughly **20%** (S ≈ 70%); adding a replayed
map for the absent-at-HEAD files would take it to roughly **14%** (S ≈ 74%). The unrecorded suites
were not the lever this gate needed.

Reproduction: the runs are `/tmp/cbd-exp2-run.mjs` against lanes `cbd-exp2-rl` and `cbd-exp2-res`;
shards are `/tmp/cbd-exp2/{rate-limits,resilience}{,.service}.ndjson`, merged into
`/tmp/cbd-exp2/shard{,.service}.ndjson`; the gate command is the one in the experiment 1 entry with
`--shards /tmp/cbd-exp2` and `--exclude typescript/tests/stores/tests/store.spec.ts,typescript/tests/stores/tests/perf.spec.ts`.

## 2026-10-18 — `cbd-1ci`: the missing modules were resolution and a lost handoff

**Update** — the modules absent from the map although their barrels were seen were never a
selection question. Two defects compounded, and both are fixed:

1. **The module body was unmappable on a tsc build.** `@jridgewell/trace-mapping`'s
   `originalPositionFor` searches one generated line and never crosses into the next. `tsc` opens
   every emit with unmapped boilerplate (`"use strict"`, `__createBinding`), so byte offset 0 — the
   module body, which spans the whole script — had no mapping of its own and none on its line. The
   body was dropped from *every* source-mapped script; for most files a later-executing function
   kept the file visible, but a file whose only executed function is its module body (a module of
   classes or constants re-exported by a barrel) vanished. `original()` now falls forward to the
   first mapping at or after the offset's generated line.

2. **Standing the injected module down discarded what it had already taken.** On a test process
   that carries `NODE_OPTIONS` (it must, for the services it starts), the module starts at process
   birth and its 500 ms snapshots take the isolate counters. `inProcessSource()` stood it down and
   started its own session, but the counters the snapshots had consumed were gone: no client ever
   read this process's snapshot. Everything before the collector, including the test entrypoint's
   static imports, was lost. `stop()` is now a handoff — it runs a final take through the same queue
   and returns the accumulated coverage, and the in-process source delivers it in its first window
   (the `@load` bucket), once.

*Proof on the real files.* A process started with `--import …/instrument.js` that requires
`libs/core/dist/index.js` now reports `libs/core/src/KeyStore.ts <module>@0` (line 126) and
`libs/core/src/SigningPolicy.ts <module>@0` (line 1). Before the change neither appeared anywhere in
the take, although `KeyStore.js` was in the coverage payload with its module body at count 1. The
same resolution path explains `libs/leases/src/Columns.ts` from experiment 2 and
`api/dashboard-api/src/Config.ts` / `libs/postgres/src/Utils.ts` from experiment 1.

*What this does to the gate: nothing — and the earlier estimate is withdrawn.* The recovered
evidence is an `@load` touch, because a module body that ran during import is startup code. §8.3
rule 2 forces `mode: all` for a file reached only at load, exactly as `unknown-file` did. The
experiment-2 entry's "if `cbd-1ci` were fixed, P would fall to roughly 20%" is wrong: the corrected
measurement converts an unknown into a load answer, and P stays where it was. That is a real result
for the floor decision — this was never a lever, and the remaining levers are the map's commit
(absent-at-HEAD) and the scope choice, which is what the replay harness is for.

Tests: core 217 (two new — the unmapped-prefix resolution and the handoff delivered once — plus the
existing off-switch test now asserting that it hands coverage over), japa 66, mocha 8, cli 36.
Workspace build clean.

## 2026-10-18 — `cbd-vqc`: the replay harness, and the insertion bug it found

**Update** — `packages/core/scripts/replay.mjs` implements the B1 replay: record the full suite
once at a base commit (the map selection uses), then for each commit in `base..head` check it out,
run a full recording, build the oracle map from that run, select against the base map, run the
subset, and compare. It reports P(all), r by count and by test time, both S readings, T_full /
T_subset / E[time], and the two soundness oracles:

- **coverage** (`cbd-1uv`): Required = tests executing the commit's NEW-side hunks in the commit's
  own map; Miss = Required − Selected. A title the base map never knew (a test added inside the
  replay window) is reported apart as `newTests`, because a one-map replay cannot select it.
- **outcome** (`cbd-2jx`): failures in the full run that the subset did not select (`missedFailures`),
  failures only in the subset (`subsetOnlyFailures`), and new failures apart.

The harness is repository-agnostic: checkout, build and run are caller commands; it supplies
`CBD_SHARD`/`CBD_COMMIT` (and `CBD_SELECTION` for the subset) and reads the shards back. Paths are
canonicalized on both sides — a map key from a module URL is a realpath, a projection prefix or a
`/tmp` shell path is not, and `select` compares them by string. The patch mode covers a worktree
whose recording wiring is itself uncommitted, and the repository is restored in a `finally`.

**It found a selector bug on its first real run.** A pure insertion into an existing file is
`@@ -N,0 +M,K @@` — zero old-side lines — and `parseUnifiedDiff` dropped it, so `select` saw the
commit as changing only the earlier hunks. In the synthetic replay, appending `div()` to
`src/calc.ts` selected only the previously-edited `sub()` test. Under-selection, silent. Fixed
(`cbd-81h.1`): `Change.insertions` carries the old-side insertion points; `select` attributes an
insertion strictly inside a mapped function to that function, and one outside every function to
every test that touched the file (rule 5's treatment). A second finding is filed but not fixed
(`cbd-81h.2`): a test added to a known spec file is unselectable from an older map, and whether to
force `mode: all` for changed test files is a policy decision for the replay data.

*Validation.* A synthetic three-commit repository driven through the real mocha adapter records,
selects and reruns correctly, reports zero misses after the fix, and restores the worktree. Gate B
was rerun on the experiment-2 shards with the fixed `select`: P, r and S are unchanged (30.4%/11.6%/
61.5% week; 39.1%/14.8%/51.9% month) — Gate B computes line fractions without running a subset, so a
selection fix that only widens a subset is invisible to it. That is the division of labour between
the gates and the replay, stated by measurement rather than assumed.

*Not yet done.* The grizzly replay itself: each replayed commit needs a checkout, a rush build and
a full recorded suite (~20+ minutes per commit before B2), so the harness is validated but the miss
count is not yet measured on the target. The bead stays open for that run.

Tests: core 222 (four insertion cases in `select`, one parser case in `changes`), japa 66, mocha 8,
cli 36. Workspace build clean.

## 2026-10-18 — B2: the shard records bytes, and the build resolves them

ADR-0002 implemented as shard v2. A window now holds `scriptId -> [[startOffset, endOffset], …]`
for the functions that ran; a `script` row holds the URL, the `sourceMapURL` the inspector reported,
and the file's size and mtime; a `function` row holds one `(start, end, name)` per distinct function.
Nothing in a window names a file, a line or a key.

*The recorder stopped resolving.* Its hot path is now a projection of the V8 payload: filter scripts
with the same prefilter/self-root floor, keep the functions whose top range counted, and emit each
table row once. The union over every window is what the build assigns ordinals from, which is the
proper fix for A4: two anonymous arrows first seen in different windows are now `<anonymous>@0` and
`<anonymous>@1`, in resolved source order, instead of colliding on one key. `resolve.spec.ts` holds
that as a regression.

*The build does the work once.* `resolveShard` opens one resolver per script (one `FileCache` for
the whole build), resolves each distinct function, applies projection/relocation/include/exclude,
and assigns keys. `mergeShards` is the pure merge half, so the map's merge tests need no tree of
generated files. The build-side rules are the same `CBD_PROJECTION_*`, `CBD_RELOCATE_*` and
`CBD_INCLUDE` variables, now read by `cbd build` (and by `cbd collect`, which builds in-process).
A missing rule names a path no diff produces, so it escalates to `mode: all`; it cannot under-select.

*Bytes are checked.* A v2 offset means nothing against different bytes, so `verifyScript` compares
size and mtime and refuses with `StaleShardError`. This surfaced a real workflow: after a recording,
editing a recorded file makes the map commit's shard stale, and `cbd collect` rebuilds by default.
Refusing the *rebuild* must not fail the test run the developer asked for, so `collect` keeps the
existing map and says why (`collect.spec.ts` has the dirty-tree path). The recorder also records the
*relocated* URL for a script, so a deployed lane's shard names the checkout's bytes — the file whose
stat can still be checked after the copy is gone (ADR-0006).

*Version 1 is refused*, with an error that says to re-record: a v1 touch is a resolved tuple and a v2
touch is a script id, and reading one as the other yields a well-formed empty map.

*Validation.* core 228, japa 66, mocha 8, cli 37, fixture 43 (42 passed, 1 skipped); workspace build
clean. The mocha adapter e2e now asserts on resolved windows and the built map, which is what
`cbd-24b` asked for. `smackdebt` shows no new high finding; `collect` is clean and `resolve.ts`'s
remaining watches are the resolver's own complexity.

*The replay, and what it cost under v1.* The first full-suite grizzly replay was stopped at 47
minutes with 881 of 1555 tests recorded. The bottleneck was the thing this stage removes: the test
process normalized the service's accumulated payload on every window, and on this suite that
payload reached 117 MB.

*The v2 replay found a second bottleneck that was not the recorder.* The first v2 attempt keyed the
service's scripts by the lane copy and had to be stopped (the recording now sets
`CBD_RELOCATE_FROM=$GRIZZLY_DEV_LANE_DIR`). The corrected run then exposed the instrument's
self-snapshot: every 500 ms it rewrote the whole undelivered state, and on this service that state
reached **398 MB** — 5,681 pending request windows and 753 untaken script coverages — while the
service sat at ~97% CPU (918 CPU-minutes over a run that advanced 1,268 of 1,555 tests). That is
crash-recovery insurance, not coverage collection, and it dwarfed the cost B2 removed. `cbd-n9t.2`
holds the finding and the deeper fixes; a knob landed for the measurement, `CBD_SNAPSHOT_MS`
(default 500, `0` keeps only the exit write, an interrupted shard is refused rather than trusted).
The measurement run uses `0`, and records the trade rather than hiding it.

**Update — the replay ran, and the miss count is zero.** Window `103bd3d3..3a5b91c6` (the auth
invite/validation change), six stores suites, v2 shards, snapshots off.

| | |
|---|---|
| full run (base / replay commit) | 1800.6 s / 1819.1 s, 1 failed each |
| selection | **subset**, 1,320 of 2,243 tests (58.9% by count, 59.1% by recorded time) |
| subset run | **695.1 s**, 1,318 titles, **0 failures** |
| coverage oracle | **miss 0**; `newTests` 18 |
| outcome oracle | `missedFailures` 0, `subsetOnlyFailures` 0, `newFailures` 1 |
| wall saving | 61.8% (`T_subset / T_full`) |

*What the numbers mean, including what they do not.* The commit changes the shared test helper
`Auth.ts` and `libs/core/src/KeyStore.ts`/`SigningPolicy.ts`, so 59% of the suite honestly reaches
it; that is blast radius, not escalation. The coverage oracle found no test that executed the
change's new-side hunks and was left out. The one full-run failure was the dashboard-api keyring
lookup, which **also failed in the base recording** — so it was excluded from the base map as a
non-green window, and at the replay commit it is correctly reported as a *new* failure rather than
a missed one. The verdict must say that, not just "zero": the only red test was unselectable, and
the map's own rule says an untrusted window does not get to claim it was covered.

*`newTests` is exactly the added tests.* The full run's title set minus the base's is 18 titles,
matching the diff's 18 new `test(...)` blocks one for one. None could be named from the older map.
Two selected titles are gone at the replay commit (one renamed along with its replacement in the 18,
one removed), so 1,318 of 1,320 ran; a selectable title that no longer exists is a no-op, not a loss.

*The subset's wall saving exceeds its recorded-time fraction.* Selected durations sum to 1,031.5 s
(59.1% of the full run's recorded time) but the subset finished in 695.1 s (38.2%). The recorded
`durationMs` includes the recording work between a test's start and end, and the full run's
durations also carry its own contention; the wall ratio is what a developer feels, the duration
ratio is what `E[time]` models. Both are reported, neither is substituted for the other.

*Overhead, for `cbd-7yd`.* ~1,810 s recorded against a count-scaled unrecorded baseline of ~790 s
(548.6 s × 2243/1555) is about **2.3×**, far from the ~10% target. The snapshot pathology is gone;
what remains is the take/socket/parse/shard path. The target is not met, and the stage's verdict
should say so rather than re-scope the denominator.

*The harness had one bug left, and the run found it.* Its `finally` restored the worktree by
checking out the original ref with the recording patch still applied; git refused because a patched
file differs between commits, the exception escaped the `finally`, and `report.json` — the product
of a 50-minute run — was never written. The numbers above were reconstructed from the shards and
the per-commit line. The harness now discards the patch before switching and makes restoration
best-effort, so a restore failure can no longer cost the report.

**Update — `cbd-81h.2`: a changed test file keeps the fast path and says what it cannot answer.**
The replay's `newTests` was exactly the 18 tests the commit added; a map taken before the edit
cannot name them. The first decision — force `mode: all` for every changed test file — did not
survive the frequency check. In the Gate B measured set, **53 of 79** commits in the week and
**140 of 253** in the month touch a stores spec; the forced default would have made `P(all)` about
97% / 94.5%, destroying the tool's benefit. So the decision is the knob with the fast default:
`select.testFilePolicy: 'known' | 'all'`, default `'known'`, which selects the tests the map knows
in the changed file and **warns** that a test the edit added cannot be named. `'all'` is the opt-in
for a team that prefers the full run. The gap is reported, not hidden — the warning in `select`,
`newTests` in `verify`/the replay — and it is the only remaining unnameable case the harness could
find. Implementation: `select.ts` rule 3, config key + schema, tests in `select.spec`/`config.spec`;
documented in CBD.md §8.3/§9.3.

**The verdict (`cbd-bm2`).** Under ADR-0004, `S = (1−P)(1−r) ≥ 0.60`, subject to **miss = 0**.

- **Soundness: miss 0 on the replay.** No test that executed the change's new-side hunks was left
  out, no full-run failure was omitted except the one the base map could not hold (it was red at
  base), and no subset-only failure appeared. The outcome oracle's `newFailures` 1 is that
  base-red dashboard test, not an escape.
- **Payoff: the floor is not defended with a margin.** Gate B: week `P` 30.4%, `r` 11.6%, `S`
  **61.5%** (clears 60 by 1.5 points); month `P` 39.1%, `r` 14.8%, `S` **51.9%** (fails by 8.1).
  The replay commit is deliberately broad (a shared test helper), so its `r` 59.1% and `P` 0 are a
  blast-radius data point, not a distribution. The test-file policy keeps the measured `P` intact
  (`'known'` is the default); the 18 added tests are a reported `newTests` gap, not a silent one.
- **Overhead: not met.** ~1,810 s recorded against ~790 s count-scaled unrecorded is ~2.3×; the
  ~10% target is an order of magnitude away, and the remaining cost is the take/socket/parse/shard
  path, not the normalize B2 removed.
- **Verdict:** the tool is sound on the measured commit, but on this repository's history the
  subsetting payoff is at the floor on one week and below it on one month, and the recording cost is
  not yet acceptable for an automatic path. Whether 60% is the right floor, and whether a suite
  that does not execute a third of its backend can meet it, remains `cbd-u0v`'s decision; the
  numbers above are the input, and they do not argue for a comfortable pass.

**Update — `cbd-u0v` decided: the floor is 50%.** The author's decision, recorded in ADR-0004's
amendment, is that 60% was a first estimate rather than a defended demand. On the measured numbers
both windows now pass: the week at `S` 61.5% with margin, the month at 51.9% by 1.9 points. The hard
constraint is unchanged — **miss count 0**, with an unnameable test reported as `newTests` and warned
about by `select`, never counted as a miss — and the record states the claim is weaker: the month's
margin is small, the test-file gap is visible rather than eliminated, and the recording overhead
(~2.3×) is a separate failing target that `S` does not measure. At the month's `P` 39.1% the 50%
floor allows `r` up to 18.0%; the selector answered at 14.8%. The max-`r` table in ADR-0004 is
recomputed for 0.50, and Gate A's admissibility line becomes `φ ≤ 50%` (the stores suites measure
≈0.5%, so the line is not near). Anyone quoting the gate must quote the miss count and the overhead
in the same breath.

## 2026-10-19 — the map's statistics are a command (`cbd-sf1`)

The map already held the test↔function relation; the convenient surfaces were `explain` and a thin
`stats`. Two additions, no new recording:

- **`cbd stats`** now reports mapped functions, functions per reached file and tests per mapped
  function (median/p90/max), and the most-tested files, in text and JSON, beside the existing
  reached/seen/untested names. It still refuses to claim a coverage percentage: only *executed*
  functions are in the map, so there is no denominator — the honest aggregates are reached counts
  and the inverse at file granularity.
- **`cbd reaches <title> <file>[:line]`** and `createCbd.reaches(...)` answer the inverse question:
  whether one test reaches a file or line, the functions it executed there, and every file it
  reached. A line outside every function is answered by the file-level rule (§8.3 rule 5), and a
  bare title that names tests in more than one file is refused with the candidate files rather than
  guessed at (`--file` disambiguates). The core inverse index is `functionsForTest`: a scan of the
  function index, because the map is read far more often than queried this way and a second index
  would be stale-prone storage for a convenience.
- `map.json` is documented as the supported export, so another tool can read the whole relation
  without going through the CLI.

Tests: core 233, cli 39; japa 66, mocha 8, fixture 42 + 1 skipped unchanged. `smackdebt`: no new
high finding — `mergeShards` is pre-existing, and `cli run`/`checkPositional` each grew one branch.

**Update — a shard stops repeating maps the file already carries (`cbd-n9t.1`).** The v2 script
row embedded `Debugger.scriptParsed`'s `sourceMapURL` unconditionally, and for a tsc build that URL
is the file's own inline map — tens of KB per script, duplicated in the shard even though the build
reads the same stat-verified bytes. `sourceMapUrlOf` now implements Node's magic-comment rule, and
the recorder omits the field when the file declares the same URL (it keeps the inspector's when the
file declares none, or a different one — the bytes V8 ran are authoritative). `resolveShard`
recovers a declared map from the file text it has just stat-checked, so resolution is unchanged.
The deployed-copy e2e, whose fixture is tsc output with inline maps, passes through the omitted row
and the recovered map.

Measured on the last v2 stores recording: the **service shard** held 2,437 script rows and **35.2 MB
of file-declared maps — 62.4% of its 56.3 MB**. Those rows now carry URL, size and mtime only. The
**test shard's** 537 rows are mostly ts-node maps, which exist only in `scriptParsed` (the `.ts`
files declare none) and must stay: 13.9 MB of its 18.2 MB is inherent to the loader, not
duplication. Tests: core 238 (magic-comment forms, three recorder cases, one build recovery), japa
66, mocha 8, cli 39, fixture 42 + 1.

## 2026-10-19 — the last open work: timing decisions and the decision-record backfill

- **`cbd-2v8`** — the drift test asserted an absolute 1 ms gap between a tight and a spaced queue;
  under load the gap was 641 µs while the signature (tight several times spaced) was intact. It now
  asserts the ordering and a ratio, because the absolute floor was measuring the host. Three
  consecutive runs green; no product change.
- **`cbd-h09`** — no instrument-side fix is possible for the inspector's first full take, and a
  warm-up take was measured not to help (the next take's cost scales with the scripts loaded since
  install). The transient is documented where drift is defined (`DriftStats.maxDepth`, naming the
  issue) and here; the straddle fixture's first test waits 50 ms so its assertion measures steady
  state, and the delayed work lands in the preceding bucket, which escalates.
- **`cbd-llm`** — the instrument now omits a script row's `sourceMapURL` when the file itself
  declares the same one, so a tsc service's first take no longer carries the maps: that was 35.2 MB
  of a 56.3 MB table (62.4%) in the measured run, the bulk of the reply whose JSON parse blocked the
  collector. A loader-injected map still travels; the build recovers a declared map from the same
  bytes. `maxDepth` stays **one** number: it is a liveness signal, and telling "queued" from
  "unread" would need a client-side counter for a distinction `maxUs` vs `minGapUs` already makes.
- **`cbd-aia`** — six decision records now exist where the decision lived only in a docblock, the
  design document or this log: ADR-0009 canonicalizes both sides of a prefix match and leaves the
  destination as written; 0010 refuses to project a script whose declared map is unreadable; 0011
  makes the framework's awaited root hook the window; 0012 takes the diff from the map's commit;
  0013 keeps one map per commit and merges its shards; 0014 makes the source array the integration
  seam. The index's *Planned* list is empty.

Tests: core 238, japa 66, mocha 8, cli 39, fixture 42 + 1 skipped; workspace build clean.

## 2026-10-19 — a Vitest adapter (`cbd-xnp.1`)

The probe first, because the adapter's shape depends on facts a documentation page cannot settle:
`setupFiles` execute **once per test file**, and at module scope
`globalThis.__vitest_worker__.filepath` already names that file; `inProcessSource()` works inside a
Vitest worker thread (`session.connect()` targets the worker's isolate, not the process's main
thread); `task.fullTestName` is the suite path plus the name and nothing else; `afterEach` sees
`task.result.state` as `pass`/`fail`/`skip`; and `context.skip()` in `beforeEach` filters a test
without running its body.

The adapter is a setup file with **one recorder and one shard per test file**, named from the base
shard plus the file's name and a hash. One shard for the whole run would have been appended by every
file's setup execution — several headers and footers, which the parser must refuse — and a worker
killed mid-file would corrupt the run's only artifact. Windows are the awaited
`beforeEach`/`afterEach` (first and last for a setup file), the source is created at setup import so
the file's import phase lands in `@load`, and the footer is written in `afterAll`. Script ids are
per isolate, so the shards are separate `buildMap` inputs: two workers can give different scripts
the same id, and resolving each shard against its own table is what keeps that from looking like a
contradiction.

Selection is a runtime skip in `beforeEach`, before a window opens: Vitest's `-t` is a regex, and
arbitrary test titles cannot be pasted into one safely. A statically skipped test opens no window.
The identity is the full test name, so two same-named tests in one file stay distinct. A separately
started service is **not collected yet** — several workers reading one service would split its
isolate's take stream — so the adapter records the test process, warns once, and a server-side
change escalates. `@vitest/coverage-v8` must be off, as the design already said.

Tests: identity cases (title/file/status/shard naming) and two e2e runs against real Vitest 5: two
spec files produce two complete shards and a map that answers `add@0`/`sub@0`; the skipped test is
absent; `CBD_SELECTION` narrows the run to the one named test. Workspace: core 238, japa 66, mocha
8, vitest 6, cli 39, fixture 42 + 1.

## 2026-10-19 — the Vitest adapter against a real app (Directus SDK, Vitest 3.2.7)

The minimal fixture proved the plumbing; a real app found a version fact the fixture could not.
`directus/sdk` was copied to `/tmp/cbd-vitest-directus` (the original tree untouched), with
`@directus/system-data` and `@directus/tsconfig` installed from npm, and a temporary setup file that
imports the app's **own** Vitest hooks and hands them to `installVitest`. That seam was necessary:
the adapter package's own Vitest is 5.0.5 and the app's is 3.2.7; importing hooks from the adapter's
copy would register them in a different runner.

- 14 spec files → **14 shards** (one per file), 82 test records; the map held **82 tests, 178 files,
  183 seen**.
- The first run produced **77** map tests. Vitest 3 has no `task.fullTestName`, and the bare-name
  fallback collapsed five same-named tests within their files — the exact collision the full name
  exists to prevent. `titleOf` now walks the suite chain when `fullTestName` is absent; the rerun
  produced 82/82 with `describe > test` titles, and `testsForFunction(map, format-fields.ts,
  formatFields@0)` returned the tests that exercise it.
- `CBD_SELECTION` with one title: **1 passed, 81 skipped**, exactly one test record — the runtime
  skip filters the real suite.
- All 1,234 script rows carried maps (Vite injects them; the `.ts` files declare none), which is the
  expected shape: the map keys resolved to the `.ts` sources, not the virtual modules.
- Peer range broadened to **`>=3.2 <6`**; 3.2.7 and 5.0.5 are both exercised (the package's own e2e
  runs on 5).

The copy and its shards are under `/tmp`; nothing in the enterprise-apps tree was modified.

**LangChain, Vitest 4.1.12.** `libs/langchain-textsplitters` copied to
`/tmp/cbd-vitest-langchain` with published `@langchain/core` 1.2.18 in place of the workspace peer.
Two spec files, 36 tests; 2 shards; map **36 tests, 3 files, 5 seen**; `splitText@0` in
`src/text_splitter.ts` answers with the splitter tests; all 8 script rows carried maps; selection of
one title ran 1 and skipped 35, recording exactly one test. Together with Directus this covers
Vitest 3.2 and 4.1 through the same injected-hook seam; the package's own e2e covers 5.0.

## 2026-10-19 — a Jest adapter (`cbd-xnp.2`), and a shard identity bug it found

A Jest test environment is created **per test file**, and `setup()` is awaited before the test file
is evaluated — so the source is created there (the file's imports land in `@load`) and `teardown()`
writes the footer. That makes a shard per file the natural unit, named from the file's path. The two
entries Jest names are built as CommonJS (a test environment is loaded with `require`) with a
dynamic import of the ESM core; the rest of the package stays ESM. Windows are the awaited
`handleTestEvent` events (`test_start`, `test_done`); the identity is the enclosing `describe` names
plus the test name with Jest's `ROOT_DESCRIBE_BLOCK` omitted; the outcome reads `mode` first
(`skip`/`todo`, which may never reach `test_done`) and then the test's `errors`. Selection lives in
`setupFilesAfterEnv`, where the framework globals exist: it wraps `describe`/`test` (and
`describe.only`) and turns an unselected test into a skip. `test.each`/`describe.each` are refused
when a selection is active — their rows bypass the wrapper, and skipping a selected row silently is
the failure this project does not accept.

**The app found a core bug, and it is the important part of this entry.** The first real run mapped
`math.js` to `<module>@0` only: `add` and `sub` had disappeared. Jest compiles a CommonJS module in a
VM wrapper, and V8 reports the wrapper (`0–777`) and the first function it contains (`add`, `0–38`)
with the **same start offset**. A v2 shard keyed a function by `(scriptId, start)` — so the second
sighting at start 0 was treated as the first, and the build resolved every start-0 touch to the
wrapper. The identity is now the **range**: the recorder keys and unions by `(start, end)`, and
`resolveShard` keys its function table, its reference check and its touch lookup by the range, with
ordinals sorted by line, start and end. No schema change; a range was already in every row and touch.
This is a shard-identity bug, not a Jest one: any runner that compiles through a VM wrapper with a
function at offset 0 would have hit it, and the Jest adapter is simply the first that did.

Validation: core 240 (two new range-identity tests), japa 66, mocha 8, vitest 6, jest 5, cli 39,
fixture 42 + 1. The japa suite's load-sensitive straddle drift assertion failed once while the
workspace was building concurrently and passed alone; it is a characterisation test of boundary
sliding on a loaded machine, not a regression. `pnpm-workspace.yaml` now allows the build scripts
Jest's dependency tree needs (`@parcel/watcher`, `esbuild`, `unrs-resolver`) — a workspace policy
change, not a package one.

**Update — the Jest adapter against a real app (Strapi `@strapi/utils`, Jest 29.6.0).** The package
was copied to `/tmp/cbd-jest-strapi` and installed with its published dependencies; the adapter was
placed in its `node_modules` the way a consumer would have it, so `require('jest-environment-node')`
resolved the app's Jest 29 rather than this package's devDependency.

- 32 suites → **32 shards**; **611 tests (608 passed, 3 todo)** → 608 records; the map held **588
  tests, 92 files, 99 seen**; all 354 script rows carried the SWC source maps, and the keys resolved
  to `.ts` sources.
- The first selection attempt used the setup-file wrapper. It **failed 12 suites**: those use
  `test.each`, which the wrapper refused rather than silently skipping a selected row. The refusal
  was correct and the mechanism was wrong. Selection moved to `withCbd(config)`, which translates
  `CBD_SELECTION` into an **anchored** `testNamePattern` (titles escaped, ` > ` → `\s+`): the config
  is read before the run and Jest's pattern is the only filter that sees an expanded `.each` row.
  Re-run: 31 suites skipped, 1 passed, **1 test**, one record. An unanchored first version matched
  `... error 2` as well; anchoring is what makes it exact.
- The 20-record gap between records and map tests is same-title collisions within a file (18
  pairs, e.g. two `keeps: $gt number` rows). The map's identity is `(title, file)`; selection runs
  both, which over-selects, but their coverage and failures merge. Filed rather than absorbed.

## 2026-10-19 — a node:test adapter (`cbd-xnp.3`)

`node --import @spikedpunch/cbd-node-test/register --test`. node:test runs each test file in its
own child process, and the preload is evaluated before the file — so the child creates one
in-process source and one shard per file, and the file's imports land in `@load`. Windows are the
global `beforeEach`/`afterEach`; the file `after` hook writes the footer. Identity is `t.fullName`
(bare `t.name` on Node before 20.16); status is `t.passed`, with `t.skip()`/`t.todo()` called from
inside a body tracked by wrapping those context methods, because the runner leaves `passed` true.
Statically skipped tests reach no hook and open no window. A test registered `{todo: true}` reaches
the hooks without a marker and is recorded as passed with a hooks-only window (over-selection safe).

**Selection took three probes to get right.** `t.skip()` in `beforeEach` does not stop the body
(the body still runs and `passed` stays true), so a runtime skip was not available. `--test` never
loads the user preload in the parent runner (only children load it), so the parent's `argv` cannot
be amended. Appending `--test-name-pattern` to the child's `process.execArgv` also does nothing:
the child's harness reads its options during bootstrap, before the preload. What works is a
**re-execution**: the preload spawns the same test file with the extra argument and inherits the
child's stdout, so the runner still parses TAP. The pattern must use the runner's spelling —
parts joined by single spaces, not CBD's ` > ` — which the first probe missed (`^outer > fails$`
matched nothing and the file reported zero tests). One extra process per test file during a subset
run; a caller-supplied pattern is left alone with a warning, and `--test-isolation=none` records
nothing (one process for every file cannot produce a shard per file).

Validation: the package's own e2e runs a real `node --test` over two fixture files — two complete
shards, the failed window present in the shard and absent from the map, the statically skipped test
absent, a body-level `t.skip()` recorded skipped, `@load` holding the imported module, and
selections of both a top-level and a nested test narrowing the run to exactly one record. Package
suite 9 tests. Core 240, japa 66, mocha 8, vitest 6, jest 6, cli 39 and fixture 42 + 1 re-run clean;
smackdebt reports the new package clean.

**A real app (Pulumi's npm package, 56K, CommonJS test files).** Copied to
`/tmp/cbd-node-test-pulumi`: 15 tests across `cache`, `download` and `resolve` produced **15 records
in 3 complete shards**; the map held 15 tests, and `cacheDir@0` answered with both the `cacheDir()`
tests and the four `resolve()` tests that call it. Selecting `cacheDir() > respects PULUMI_HOME`
(exercising the regex escape in the runner's space-joined spelling) ran **one test** and recorded
exactly one record; the other two files still ran but recorded none. CommonJS `require('node:test')`
files work unchanged — the preload is ESM and installs the same global hooks.
