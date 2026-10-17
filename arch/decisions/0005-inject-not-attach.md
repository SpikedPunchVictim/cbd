---
type: Architecture Decision
title: "ADR-0005: Reach a service by injecting into it, not by attaching to it"
description: Out-of-process coverage arrives as a module injected by NODE_OPTIONS and served on a unix socket; attaching a debugger to --inspect is the fallback.
status: draft
tags: [integration, safety, multi-process, developer-experience]
generated: { by: process:cbd-adr-draft, at: 2026-10-16T15:28:20-07:00 }
sources:
  - id: cbd-goals
    resource: /CBD.md
    title: CBD design document — §4.3 inspectorSource, §7.6 the manual protocol, §10 the integration surface, §13 what is assumed
  - id: injection-spike
    resource: /.explore/spike/injection
    title: Injection spike — one environment variable, two instrumented processes, attribution partitioned correctly
  - id: inspector-contract
    resource: /packages/core/src/source/inspector.ts
    title: The inspectorSource contract this record demotes to a fallback
  - id: metric
    resource: /arch/decisions/0004-success-metric.md
    title: ADR-0004 — the target suite is the stores suites, and they drive a separate server
  - id: findings-7d
    resource: /.explore/FINDINGS.md
    title: What unit-tests-only removes from the design
---

# Authors and the team

Drafted by Claude Code from a spike the author directed, on the author's question: *"that's a lot of
work for the developer — how can we make this dead simple?"* The decision is the author's. The
spike is four files under `.explore/spike/injection/` and anyone can re-run it.

# Context and problem you want to solve

The target suite drives a server, so the code that matters runs in a process the test process cannot
see, and the map is blind to it [^metric]. Something must reach that process.

The design answers with `inspectorSource` [^cbd-goals]: the target starts under `--inspect`, CBD
speaks the Chrome DevTools Protocol to it over a WebSocket, discovers the target through
`/json/list`, and guards the result with a collector lock file and an `allowRemote` rule. That
contract is now written and tested [^inspector-contract].

It also asks a great deal of the developer. To get a map they must find where the server is spawned,
add `--inspect=0`, discover the OS-chosen port — which is not knowable until the process prints it —
keep a second collector from attaching to the same target, reason about the fact that `--inspect` is
unauthenticated remote code execution for anyone who can reach the port, and, for a cluster or a
worker pool, repeat the port-and-discovery work per process because `CBD.md` §4.3 makes that *"the
user's job."*

This is the opposite of what the project already promises. The integration story for tests is one
environment variable — `NODE_OPTIONS="--import @spikedpunch/cbd"` — and the whole point of it is that
the developer does not think about ports. Asking them to think about ports *only* for the server
would be an odd place to draw the line, given a server is just another Node process.

# Functional and non-functional requirements you want to address

- **One line, or none.** The developer's change should be an environment variable they were already
  setting on the test side, or a line in a platform's env template. Not a spawn-site edit.
- **Safe by default.** No unauthenticated code-execution surface, and no way to open one by
  accident.
- **Multi-process without per-process wiring.** A cluster, a worker pool or a spawned child should
  instrument itself for the same reason the parent did.
- **Attribution per process.** Each process's execution must be attributable to it exactly, not
  merged into one heap that cannot be untangled.
- **One mental model.** The server half and the test half should be the same idea, learned once.
- **The window boundary must stay sharp.** `Recorder` is synchronous because japa does not await its
  hooks, so a take that lands late misattributes a test's execution to its neighbour. Whatever
  reaches the server must not make that worse.

# Potential critical user journey (CUJ) the decision impacts

A developer changes a server-side function — a signature check, a key handler — and runs the suite.
For the answer to be honest, the map has to know that *this test* drove *that function*, in a process
the test never entered. If getting the map required them to have restarted their server with a flag
they did not know about, they will not have the map, and the tool silently falls back to running
everything — the outcome the project exists to prevent.

# Overview of the key options

1. **Attach a debugger.** The designed path: `--inspect` plus CDP over a WebSocket. Reaches any Node
   process whose environment can be set. Requires port discovery, exclusivity, an RCE guard, and
   per-process work for multi-process servers.
2. **Inject a module.** `NODE_OPTIONS="--import …"` runs CBD's own code *inside* the target, which
   takes its own coverage through `node:inspector` and serves the deltas on a unix socket. One
   environment variable, inherited by the whole process tree.
3. **Dump V8 coverage to a directory.** `NODE_V8_COVERAGE` — no injection and no ports, but the
   granularity is the process lifetime, not a test, so it cannot attribute anything. It is designed
   for, not usable here [^cbd-goals].
4. **Wrap the process in a CBD launcher.** `cbd run -- <start command>` sets the environment for
   them. One command instead of one variable, but it changes how the developer starts things, and a
   process a launcher does not spawn stays invisible.

# Your decision and reasons behind the accepted choice

**Option 2 is how CBD reaches a service. Option 1 is kept as the fallback, for a process whose
environment genuinely cannot be set.**

```
NODE_OPTIONS="--import @spikedpunch/cbd/instrument"
```

The injected module connects `node:inspector` to its own isolate, starts precise coverage, and
listens on a unix socket. The collector lists a directory and drives each socket it finds.

**It answers the developer's cost by removing the work rather than automating it.** There is no port
to choose, so none to discover; no TCP listener, so no reachability question; nothing to keep
exclusive, because each process has its own isolate and its own socket.

**Multi-process stops being a problem rather than becoming a solved one.** `NODE_OPTIONS` is
inherited, so every worker of a pool announces itself without anyone enumerating it. The spike shows
this directly: a parent and a worker it spawned each opened a socket, and neither was wired up
[^injection-spike].

```
[server] pid=15491 ready reversed=fedcba valid=true
[cbd] instrumented pid=15491 sock=…/pid-15491.sock
[cbd] instrumented pid=15493 sock=…/pid-15493.sock
```

**Attribution is exact by construction, not by discipline.** The same run reported that the parent
saw the parent's functions and not the worker's, and the worker saw its own and not the parent's.
Two isolates, two sockets, nothing to disambiguate — where the CDP path would have needed one target
list and one source per process.

**The security model gets smaller, which is the direction that matters.** `--inspect` is
unauthenticated remote code execution on a TCP port; that is why `inspectorSource` carries an
`allowRemote` rule and the design carries a lock file. A unix socket at mode `0600` is a filesystem
object that serves coverage deltas and nothing else, and the injected module opens none of it unless
it is asked to. The fallback keeps its guard, but the primary path no longer needs one.

**The window boundary gets sharper, not looser.** The injected module holds an `inProcessSource`, so
its take is synchronous on the server. Over CDP the coverage resets when a protocol message lands;
over a socket it resets the moment the server reads the request — a loopback hop. The
dispatch-time-is-the-boundary contract [^inspector-contract] is easier to hold this way.

**And it is one idea, not two.** A server is a Node process and so is a test run, so the module can
be one module with two roles: if a test runner is on the stack it installs the adapter's hooks,
otherwise it serves windows. The developer learns the variable once.

# Consequences

**The lane hook collapses.** A dev-cli lane currently needs plumbing to start its server under
`--inspect` and report the port back. Under this decision the lane's server environment carries the
same one line every developer's would, because `startServer` builds the environment from an env file
that `dev-cli` already owns. That work is filed under `cbd-a3v` and is now one line rather than nine
files.

**`inspectorSource` is demoted, not deleted.** It stays as the fallback and its contract stays tested
[^inspector-contract]. It should be built second, and only against a target that cannot be injected
into.

**The socket has to carry the Normalizer's whole input, not just function names.** The spike returned
function names, which was enough to prove attribution and is *not* enough to build a map. The
protocol must carry `Debugger.scriptParsed` — each script's URL and `sourceMapURL` — or a compiled
service cannot be projected back onto its TypeScript sources and the map is worthless on a real
build. This is the largest untested piece and the first thing to build.

**The module must be inert wherever `NODE_OPTIONS` reaches, including the test process.** Inheritance
is the feature and also the hazard: the variable propagates into every Node process in the tree,
including the runner. The module therefore has to be cheap, silent, and harmless when nothing is
collecting — and the collector must not mistake the test process's own socket for a service.

**A containerised service needs its socket directory shared.** The lane happens to run its server on
the host, so a unix socket is visible to both sides. A service inside a container is not, and the
directory has to be mounted. This is a real limit of the approach and belongs in the docs rather than
being discovered.

**A Node version floor becomes a documented requirement.** `--import` needs Node 20.6; the injection
path inherits that floor, where the `--inspect` fallback does not.

**One module, two roles — but not one package.** A service and a test run get the same module and the
same environment variable: `@spikedpunch/cbd/instrument` for a service, the package's own entry for a
test run, because the decision rests on there being one thing the developer learns. That reasoning
does not extend to the adapters, and an earlier draft of this record wrongly extended it. Each
framework adapter carries its own peer dependency, so folding them in would put the union of every
runner's dependency surface into one manifest and make a mocha user install against japa's peers.
They stay sibling packages — `@spikedpunch/cbd-mocha`, `@spikedpunch/cbd-japa` — each with the
framework as a peer, which is what the design document already had [^cbd-goals]. What changes is the
scope, `@cbd/*` to `@spikedpunch/*`, and the existence of `./instrument` on the core package. The
sub-package boundary the document drew — one package per role, core framework-neutral — survives.

Two questions are left open rather than answered. The per-take cost is unmeasured at the target
suite's scale, where 1555 tests mean 1555 socket takes; and whether a take that must cross a socket
can hold the same window contract a local take does is a claim the spike supports but does not prove.

[^cbd-goals]: `CBD.md` §4.3 for the attach path, §4.4 for `NODE_V8_COVERAGE`, and §13 for what the
    design assumed the originating project's spawn point made possible.
[^injection-spike]: `.explore/spike/injection/` — `spike.sh` runs it end to end. The service under
    test imports nothing from CBD.
[^inspector-contract]: `packages/core/src/source/inspector.ts` defines the contract; `arch/log.md`
    records that dispatch time, not completion time, is the window boundary.
[^metric]: ADR-0004, *The suite the metric is measured on*.
[^findings-7d]: `.explore/FINDINGS.md` §7d, which cut the out-of-process machinery when the scope was
    unit-tests-only, and was reversed by the retarget.
