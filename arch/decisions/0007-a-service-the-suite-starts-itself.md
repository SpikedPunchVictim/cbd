---
type: Architecture Decision
title: "ADR-0007: Attribute a service the suite starts itself"
description: A service that starts mid-run is found by re-scanning the socket directory at window boundaries, and one that dies inside its window leaves its coverage behind on the way out, because a boundary can arrive after the process is gone.
status: draft
tags: [attribution, discovery, lifecycle, soundness]
generated: { by: agent:claude-code, at: 2026-10-17T17:32:02Z }
sources:
  - id: cbd-design
    resource: /CBD.md
    title: CBD design document
  - id: socket-source
    resource: /packages/core/src/source/socket.ts
    title: socketSource, discoverSockets, and the queued take
  - id: role-vocabulary
    resource: /packages/core/src/instrument-protocol.ts
    title: InstrumentRole and the CBD_ROLE override
  - id: acceptance-log
    resource: /arch/log.md
    title: The cbd-0gw measurements and the decision they produced
  - id: lane-client-env
    resource: /tmp/cbd-grizzly/typescript/tools/dev-cli/src/core/env.ts
    title: dev-cli laneClientEnv — the lane's client environment, and what it leaves out
---

# Authors and the team

The spike author, with Claude Code. The decision applies to the recorder and to the injected
instrument, and therefore to every adapter.

# Context and problem you want to solve

`cbd-0gw` was filed from the `cbd-a3v.3.5` acceptance run: 16 of 393 recorded tests on grizzly
key-server have a completely empty service window. Twelve are correct — four pool tests reach
Postgres directly and never touch HTTP, eight are in-process unit tests. Four are a blind spot,
and they are the `key-store.standalone-boot` group, each of which calls
`startBuiltServer('api/key-server/fastify/dist/Server.js')` and so runs a server process of its
own rather than driving the lane's.

**CORRECTED 2026-10-17, after this decision was drafted: the child is not instrumented at
all.** The paragraph that stood here said the child inherits `NODE_OPTIONS` from the test process
and is merely never looked at a second time. It inherits it only if the test process carries it,
and in a lane it does not: `laneClientEnv` [^lane-client-env] is an explicit allowlist — the lane
id, `TEST_API_URL`, the Postgres coordinates, the secrets, the dashboard URLs, `CBD_INSPECT` —
and the instrument module is named only in `tools/dev-cli/grizzly-dev.env.template`, which by its
own comment starts the *server* with PATH, HOME and that file alone. `dev lane run` composes its
command's environment from `laneClientEnv`, and `startBuiltServer` lays `{...process.env}` over
its overrides (`tests/stores/lib/Auth.ts`, `childEnvOf`). So the four children have no socket,
no coverage, and nothing for any discovery mechanism to find.

Two readings of the old runs agree, and neither needed a new one. `socketSource` refuses at
install when the directory holds more than one target, and an instrumented runner puts its own
socket in exactly that directory — so every grizzly run would have failed at install, and none
did. And an instrumented process does not exit [^acceptance-log], while grizzly's `bin/test.ts`
calls `process.exit` only on error — so an instrumented runner would have hung at the end of its
suite. The runs exited 0 in seconds.

What the probe measured stands, and is narrower than it was read as: with `NODE_OPTIONS` set on
both a lane-shaped service and a test-shaped child, `discoverSockets` returns **two** targets,
both `role: service` [^acceptance-log]. That is the collector's reach, and it is why the re-scan
below is worth building. It is not grizzly's environment: inheriting `process.env` and inheriting
the instrument are different claims, and only the second one is the one that matters.

**Consequences for this decision.** The four tests need three things, in this order: the lane's
client environment must carry the instrument (`cbd-apq`), the child must still be instrumented
after that, and it must then be read after it dies — which is the second mechanism below, because
all four stop their server inside the test body. The re-scan alone was never going to reach them;
with the client environment fixed it reaches a different, real shape — a service a suite starts
and keeps alive — which is what the fixture for it exercises.

**And the four measured cases would not be fixed by looking.** All five tests in that group stop
their server inside the test body — `finally { await server.stop() }` — and the failing ones
additionally `waitUntil(() => server.exitCode() !== undefined)`, because asserting that the
process died *is* what they test: a wrong database password, an injected server error, route
schemas that fail to compile, a port already taken. japa emits `test:end` after the test function
resolves, so at the next window boundary the child is already gone, and its coverage lived in its
own memory behind a socket in its own process. **A service that dies inside its window cannot be
read at a boundary by any mechanism.** Discovery answers "which services exist"; it does not
answer "one of them died while nobody was looking".

The two halves are independent, and conflating them is what made the issue's option list look
complete when it was not: three of the four recorded options reach only the surviving case, and
the four measured tests are all in the dying one.

A second question rides along and has to be settled whichever way this goes. `discoverSockets`
skips a hello whose pid is the collector's own, and one whose `role !== 'service'`
[^socket-source]. `CBD_ROLE` is declared and **set by nothing in the repository**, so every
process defaults to `service` and the role filter is currently inert — which is precisely why the
child above comes back reachable. The variable's docblock describes the opposite intent: that
anything in the tree which is not the service under test "says so". Any process the test process
spawns inherits the test process's role, so the moment a runner sets `CBD_ROLE=runner` — the use
the variable was invented for — every self-started service inherits it and a re-scan would find
nothing while looking like it had worked.

# Functional and non-functional requirements you want to address

- **Never under-select, in either half.** A test that drove a service must be attributed the
  execution it drove. Where attribution is impossible, the answer must escalate rather than
  return a subset that silently omits it — the failure `cbd-a3v` exists to remove.
- **An empty window keeps meaning "nothing was recorded".** One meaning, not two. It is never
  resolved later by re-reading: the twelve legitimately empty windows in the grizzly run stay
  empty.
- **The one-service path is unchanged.** A service started before the test process is attributed
  exactly as `socketSource` does today.
- **One variable, learned once.** The child is instrumented from the environment the test process
  already carries (ADR-0005). No second variable, and nothing for a consuming suite to declare.
- **Boundaries stay synchronous.** japa does not await its per-test events (A0 F1), so nothing at
  `test:start` or `test:end` may await. Drift is the measure of what this costs: mean 114 µs, max
  6.1 ms, tightest gap 11.6 ms on the grizzly suite.
- **A cost that is named and bounded**, per boundary and per instrumented process.

# Potential critical user journey (CUJ) the decision impacts

A developer changes a file on the start-up path of a stand-alone service — the config loader, the
route registration, the error path that runs when the database is unreachable. They run the
subset-selected suite and the tests that boot that service are in it, because those tests are the
only ones that ever execute that code. Today they are not: the map has no idea what those tests
reached, so the change selects by whatever the surrounding rules happen to say, and the tests
that would have caught it are not run while the answer still looks complete.

# Overview of the key options

**A. Re-scan the socket directory at each window boundary.** One `readdirSync` per boundary
(~393 per grizzly run, microseconds), attaching any target that has appeared since the last look.
Cheap, obvious, no protocol change, no consumer change, and `discoverSockets` already carries the
filters. **The implementation also looks between boundaries, every 25 ms** — added after this
decision was first written and measured as `cbd-ot8`: attaching costs a connect and a hello, and
started at a boundary both land in the same turn as the window normalization, which is the largest
synchronous block of a run. The connect then cannot complete for tens of milliseconds, so the
child's first take is dispatched late enough to carry the *next* test's work. Looking ahead of the
boundary makes that take a synchronous write in the boundary tick. The interval bounds how long a
new target waits to be found; it does not change attribution, and an attach still in flight at a
boundary is chained into that window's take rather than skipped. Its one subtlety is that the
attach is asynchronous and the boundary is not: a child
spawned mid-window is attached at that window's close, and the take a freshly attached child
answers is its **entire** history, which is why it is sent at the moment the socket opens rather
than at the next boundary — the next boundary is a different window, and the window that started
the process is the one that must be credited with its start-up. A child that started earlier
carries its earlier windows into that same window, which over-attributes; the alternative, a
discarded baseline, under-selects. See the decision below.

**B. Discover on an empty take.** If a window comes back empty and the directory holds a socket
not yet opened, open it and re-take. Rejected: the reply that reports "empty" arrives asynchronously
*after* the window, by which time a child that died inside it is unreachable and its coverage is
gone. It is therefore a strict subset of A's reachability with worse semantics, and it gives
"empty" two meanings.

**C. Invert the direction: the recorder listens, every instrumented process dials in.** The
largest change — protocol, instrument, both fixtures — and it still cannot read a process that
has already exited. It must additionally answer what happens to the lane's own server, which
normally starts *before* the recorder is listening. Recorded as the shape a worker pool will want
one day, not as this fix.

**D. Explicit registration: the test declares its server.** Puts the work on every suite that
boots its own server, and grizzly's tests are not CBD's to edit.

**E. The child leaves evidence on the way out.** The instrument takes its own coverage while the
process is ending and writes it beside its socket with pid, `startedAt` and `endedAt`; the
collector harvests the orphans and matches each to the window containing its lifetime. This is
the only one of the options that reaches a process that died inside its window, which is all four
of the measured cases. Its cost is smaller than first recorded: an inspector take is synchronous
when the session is in the same process, so `process.on('exit')` **can** take the exact final
window — measured, three calls made before exit are reported as `count: 3` from inside the
handler. What an abrupt death cannot do is run anything at all: a SIGKILL executes no handler, so
the periodic self-take remains the bound on what a killed process leaves behind.

**F. Do not attribute it; refuse to under-select.** Notice an unopened socket at the close
boundary and mark the service half of that window unattributable, so the policy escalates to
`mode: all` instead of returning a subset that omits it. Small and honest, and it satisfies the
"empty means empty" requirement, but it attributes nothing: it trades a silent wrong answer for a
loud expensive one.

# Your decision and reasons behind the accepted choice

**A and E, together, with the role guard reduced to the pid.** Chosen by the author from the
options above.

They are not two answers to one question. A is about *existence* — which services are there, one
readdirSync at a time — and E is about *mortality* — a service that stops existing during the
window it belongs to. A alone leaves the four measured tests exactly as they are; E alone leaves
the long-lived case (a server a group starts in its setup and every test in the group drives)
invisible, which is a worse gap than the one filed, because it is not measured anywhere. Only
together do they cover the two shapes a suite actually contains.

The order in which they are consulted matters. E's evidence is a process's whole lifetime, so it
is attributable only when that lifetime falls inside one window; when a child's lifetime
straddles a boundary the harvester must escalate rather than choose the window it overlaps most,
because "most" is a guess with a subset on the far side of it.

**A's rule is one rule, and it discards nothing.** The instrument starts precise coverage when it
starts, so the first take any client is given is the process's whole life, no more and no less.
That take is dispatched at the boundary that discovered the process — install's targets at the
first boundary, which is `@load`, exactly as `socketSource` has always answered; a mid-run
target's at the moment its socket opens, because the next boundary is a different window and a
test that starts a server would otherwise be recorded as touching none of it. A child that
appeared earlier has its earlier windows folded into the one that discovered it, which
over-attributes: a change to a file it ran then selects a test that did not cause it. That is the
direction this project accepts. Discarding a baseline instead would drop the discovering window's
own server work, which under-selects, and an earlier draft of this decision proposed exactly
that.

**The role filter is removed, and role becomes a description rather than a permission.** The
collector's own pid is already skipped, and that is the fact the doubling risk actually rests on —
the docblock's own reasoning says as much ("the runner's process is additionally skipped by pid,
which covers the case where nobody set a role at all"). Keeping `role` as a declared permission
would make every self-started service indistinguishable from the process that started it, since
`NODE_OPTIONS` and the role are both inherited, and it would do so silently: discovery would keep
succeeding, then stop, with no error. `role` stays in the hello and stays true in the shard; it
just stops deciding.

F is not adopted, and is recorded because it is the right answer if E proves too invasive: it is
the honest fallback for a mechanism that cannot reach a case, and it would be a two-line change
at the boundary. It is not the answer now because it makes the tool expensive exactly where it is
cheapest to be correct — a suite whose stand-alone tests are the ones a developer is editing.

# Consequences

- **The map grows, and it can only grow.** Both mechanisms add evidence to tests that had none,
  so a selection that was a subset can become a larger subset. That direction is the one this
  project accepts.
- **Two ways service coverage arrives.** A live socket read at a boundary, and a file left behind
  by a process that ended. They merge by the same route — a `test` record naming a window — but a
  reader now has two things to hold, and the harvester is a second place where attribution can be
  wrong.
- **A child that is SIGKILLed yields only what its last snapshot caught; one that exits normally
  yields exactly what it ran.** The exit handler's take is synchronous, so the periodic interval
  is no longer the bound for a clean exit — measured on grizzly, three of five `stand-alone-boot`
  children lived 305–404 ms, less than one interval, and left snapshots with no coverage until
  the final take was made exact. For a killed process the bound stands: "coverage up to the last
  snapshot".
- **A dead target's evidence has two shapes, and only one may repeat.** A window the instrument
  numbered for a take belongs to that take and can be recovered whenever that take is asked for;
  the unnumbered accumulator is a whole lifetime and may be offered exactly once, to the window
  that discovered the loss. Without that distinction one dead child's start-up was credited to 74
  windows on grizzly, because every later take re-read the same snapshot.
- **Every instrumented process pays for the snapshot.** A take in the child is work the consumer
  did not ask for; the interval is therefore a bound on both the cost and the gap, and it has to
  be named and measured rather than chosen by feel.
- **Discovery has a second clock.** The boundary re-scan is joined by a 25 ms background look, so a
  target that appears mid-window is attached before the boundary needs it. The cost is one
  `readdirSync` per tick while the source is open, and the interval is the bound on how long a new
  target waits to be found. Attribution is unchanged (`cbd-ot8`).
- **The collector is instrumented too, and stands down inside itself.** `NODE_OPTIONS` cannot reach
  a suite's children without also reaching the suite's own process, so `cbd-apq` puts the injected
  module inside the test runner. Coverage counters belong to the isolate, not to a session:
  measured, a window that ran a function twice reports one call when a second inspector session
  takes in between, because a take returns and resets the counters for everyone. The module
  therefore publishes an off switch on the global it already used for its duplicate-import guard,
  and the in-process source calls it once its own session is collecting. The module removes its
  socket and any snapshot — a process recorded in-process must not also be reachable as a target —
  and leaves its inspector session connected, because stopping precise coverage is the isolate's
  switch and would turn off the collector's coverage with it. Its reason to exist in that process
  is unchanged: being in the environment the children inherit.
- **The role vocabulary loses its teeth.** Nothing guards against a future multi-process suite
  where a child genuinely should not be read; if one appears, the guard has to come back as
  something a child cannot inherit by accident.
- `cbd-0gw`'s sixth acceptance criterion is rewritten: the four measured tests never reach a
  handler, so what they can name is the start-up path they ran — config loading, route
  registration, and the error path that ends them.
- **The integration has a prerequisite.** `cbd-apq`: the lane's client environment must carry
  `NODE_OPTIONS` and `CBD_SOCKET_DIR`, or a suite's own services are uninstrumented and neither
  of these mechanisms has anything to read. That change in turn needs the instrument module to
  stop keeping its host alive — it now `unref()`s its listening socket, without which an
  instrumented test runner prints a green report and never exits — and to stand down when the
  process containing it is the collector, without which the module's self-snapshot and the
  in-process source split one isolate's counters and every window is silently short.
- **Script ids are namespaced by pid, and that is not optional.** A `scriptId` is unique inside
  one isolate and not across processes, and `normalize` resolves `scripts().get(scriptId)` to
  find the `sourceMapURL`. One shard carrying several processes without namespacing would let one
  process's entry script answer for another's: the wrong map, a wrong file, silently.
- **An open defect, recorded rather than absorbed.** Under japa the fan-out attaches a mid-run
  target at the right boundary and the target answers every take, yet the collector's client
  rejects each one with `write EPIPE`, and the target logs no close. `cbd-a08`. The source spec
  and a standalone probe are green; two of the six end-to-end tests that need it are not.

[^acceptance-log]: `cbd-0gw`'s two measurements, 2026-10-17: the probe that started a
    test-shaped child and had `discoverSockets` return both pids with `role: service`, and the
    reading of `key-store.spec.ts`'s `standalone-boot` group that shows every child dead before
    its `test:end`. Recorded in the architecture log.
[^socket-source]: `discoverSockets` in `packages/core/src/source/socket.ts`: "Our own pid is
    skipped … A role that is not `service` is skipped for the same reason in the general case".
[^lane-client-env]: `laneClientEnv` in `tools/dev-cli/src/core/env.ts`, and
    `tools/dev-cli/grizzly-dev.env.template` beside it. The allowlist is the whole finding: what a
    lane's client gets is a list of names, and the instrument is not on it.
[^role-vocabulary]: `InstrumentRole`, `resolveRole` and `ROLE_ENV` in
    `packages/core/src/instrument-protocol.ts`. `resolveRole` defaults to `'service'` when
    `CBD_ROLE` is unset.
