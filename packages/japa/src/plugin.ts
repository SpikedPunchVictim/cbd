/**
 * The japa plugin — the whole integration point, and the reason there is no
 * `/auto` entry in this package.
 *
 * japa hands its plugins `{ config, cliArgs, runner, emitter }` directly (A0 F7),
 * so the adapter needs no patch and the consumer's test files need no edit. One
 * line in the `configure` call they already have:
 *
 * ```js
 * import { cbd } from '@spikedpunch/cbd-japa'
 * configure({ files: ['tests/**​/*.spec.js'], plugins: [cbd({ shard: process.env.CBD_SHARD })] })
 * ```
 *
 * **Where the mocha adapter ships an `/auto` entry and this one does not.** mocha
 * has a single funnel — `Mocha.prototype.run` — that a `--import` module can
 * patch, so `NODE_OPTIONS` alone is enough to record a run nobody edited.
 * `@japa/runner` exports only functions (`configure`, `run`, …) and no class to
 * reach; the plugin list is read out of a module-private config, and ESM exports
 * are read-only bindings, so there is nothing for an injected module to patch.
 * Recording a japa run therefore costs one explicit line, and pretending otherwise
 * with a loader hook that rewrote the consumer's own entry point would be a far
 * larger and more fragile thing than the line it saved.
 *
 * **One variable decides whether there is a service to record.** `CBD_SOCKET_DIR`
 * is the same variable the service's own environment sets to turn on the injected
 * instrument module (ADR-0005), inherited down the tree. So the plugin does not
 * need to be told about the service and does not invent a second way to say it: if
 * that variable is set, a service was instrumented and is expected to be reachable,
 * and if it is not set there is nothing out there to read. That is the whole rule,
 * and it costs the consumer nothing to obey because they already set the variable
 * for the server's benefit.
 *
 * **A configured service that cannot be reached is an error, not a shrug.** This is
 * the case the epic exists for: a map of a suite driving a separately started server
 * is blind to every server-side file, and a change to one resolves to a file the map
 * has never seen, which escalates to every test. Skipping the service quietly
 * reproduces exactly that, so a run that was asked for server coverage and cannot
 * get it stops and says which directory it looked in.
 *
 * The plugin is `async` because japa awaits its plugins and because opening a
 * coverage source is the one genuinely asynchronous step. That await happens at
 * *install*, before the test files are imported, which is what lets the window
 * boundaries stay synchronous — the requirement japa imposes (A0 F1).
 */
import type { PluginFn } from '@japa/runner/types'
import {
  CORRELATION_ENV,
  CORRELATION_HEADER,
  CORRELATION_HEADER_ENV,
  Correlator,
  FileSink,
  SOCKET_DIR_ENV,
  inProcessSource,
  installProcessTracking,
  installReadTracking,
  readSelection,
  rescanningSocketSource,
  scanFromEnv,
  type OwnerIndex,
  type Recorder,
  type ScanOptions,
} from '@spikedpunch/cbd/adapter'
import {
  applyTests,
  beginShard,
  installJapaAdapter,
  type JapaConfigLike,
  type JapaEmitter,
} from './adapter.js'

export interface CbdOptions {
  /** Set `false` to make the plugin inert without removing it from the array. */
  enabled?: boolean
  /** Where to write shard records. Defaults to `CBD_SHARD`. */
  shard?: string
  /** Defaults to `CBD_COMMIT`, then `'unknown'`. */
  commit?: string
  /**
   * Defaults to `scanFromEnv()`. Only `prefilter`/`selfRoots`/`includeSelf` act
   * here: a v2 shard defers projection and relocation to `cbd build`, which reads
   * the same environment variables itself (ADR-0002).
   */
  scan?: ScanOptions
  /**
   * Restrict the run to these test titles — the select half.
   *
   * Titles, not indices, and *bare* titles: japa filters on the unqualified name
   * and a qualified one matches nothing (A0 F10). `titlesFor` turns a `Selection`
   * into this list. When this option is absent, `CBD_SELECTION` supplies the list —
   * the path `cbd collect` writes before spawning the run — so the common case
   * needs no plugin change at all. An explicit option wins over the environment.
   */
  only?: string[]
}

/** What japa passes a plugin, as far as this adapter is concerned. */
export interface JapaPluginApi {
  config: JapaConfigLike
  emitter: JapaEmitter
}

/**
 * The runner's own plugin type, imported rather than restated (`cbd-amq`).
 *
 * The adapter used to declare `(japa: JapaPluginApi) => Promise<void>` with a
 * structural emitter whose `on(eventName: string, …)` was the minimum it uses.
 * That is not assignable to `PluginFn` on japa 5.0–5.3: their `on` is generic over
 * the event names, parameter checking is contravariant, and `string` is not
 * assignable to the union. The runtime never cared — the adapter only calls
 * `on(name, listener)` — but the consumer's `configure({ plugins: [cbd()] })`
 * failed to compile, on the one line they were told to write.
 *
 * `@japa/runner/types` is a published subpath of both 5.0 and 5.4, so importing it
 * makes our declaration use *the consumer's* installed version rather than ours.
 * The structural types above stay for the adapter internals and for tests that
 * drive the hooks with stubs.
 */
export type JapaPlugin = PluginFn

/** What both recorders of a run share. */
interface Wiring {
  commit: string
  scan?: ScanOptions
  /** Resolves a correlation id to the test that sent it. Absent without correlation. */
  owners?: OwnerIndex
}

/**
 * Where the service's shard goes.
 *
 * Derived from the test process's shard rather than configured separately, because
 * two variables for one run is one variable too many — and a second shard path that
 * had to be kept in step with the first by hand is a thing to get wrong. The suffix
 * goes before the extension so that `x.ndjson` and `x.service.ndjson` sort together
 * and a glob for shards still matches both.
 *
 * The last dot is only an extension if nothing after it is a path separator; in
 * `/tmp/a.b/c` the dot belongs to a directory name, and appending is the honest
 * answer.
 */
export function serviceShardPath(shard: string): string {
  const dot = shard.lastIndexOf('.')
  const slash = shard.lastIndexOf('/')
  if (dot === -1 || dot < slash) return `${shard}.service`
  return `${shard.slice(0, dot)}.service${shard.slice(dot)}`
}

/**
 * The recorders a run needs, opened in the order their windows are taken.
 *
 * Returned as a list rather than installed here, so that the decision — is there a
 * service, and is it reachable — can be exercised without an emitter and without
 * japa.
 */
export async function recordersFor(
  env: NodeJS.ProcessEnv,
  shard: string,
  wiring: Wiring,
): Promise<Recorder[]> {
  const dir = env[SOCKET_DIR_ENV]

  // Reached before either shard is opened, so that a service which cannot be
  // reached leaves nothing behind. Opening the test process's shard first would
  // drop a header-only file on disk, and a header with no footer is exactly the
  // "interrupted run" shape a later reader has to stop and reason about.
  //
  // Deliberately not wrapped in a try/catch that would fall back to the test
  // process alone. That fallback is the failure this whole task exists to remove,
  // and it would be invisible: the shard would be well-formed and the map would
  // simply have no server-side functions in it.
  //
  // `rescanningSocketSource`, not `socketSource`, and the difference only shows up
  // later: a suite that starts services of its own gets them read too, from the
  // window that starts them onward (ADR-0007). The install-time contract is
  // unchanged — a directory with nothing in it is still an error rather than a
  // silent empty map.
  const service =
    dir === undefined || dir === ''
      ? null
      : await rescanningSocketSource({
          dir,
          // Correlation is turned on by the collector, not by the service's own
          // environment: `recordersFor` is the collector's side of the seam, and a
          // source it opens is a process it is about to read.
          ...(wiring.owners === undefined ? {} : { correlationHeader: CORRELATION_HEADER }),
        })

  const recorders = [
    beginShard({
      ...wiring,
      source: await inProcessSource(),
      sink: new FileSink(shard),
    }),
  ]

  if (service !== null) {
    recorders.push(
      beginShard({
        ...wiring,
        source: service,
        sink: new FileSink(serviceShardPath(shard)),
        // The service's execution is the service's. Both shards are merged later by
        // `buildMap`, which unions the touch sets of a test recorded twice.
        pid: service.pid,
        // A window opens for every test on this recorder too; only the tests that
        // actually touched the service can observe its module state.
        role: 'service',
      }),
    )
  }

  return recorders
}

export function cbd(options: CbdOptions = {}): JapaPlugin {
  return async function cbdPlugin(japa): Promise<void> {
    // The parameter is japa's own PluginFn shape; the cast is the two fields this
    // adapter reads. It is confined to this boundary on purpose: everything below
    // works against the structural types, and the public signature is the runner's.
    const { config, emitter } = japa as unknown as JapaPluginApi
    if (options.enabled === false) return

    const shard = options.shard ?? process.env.CBD_SHARD
    if (shard !== undefined) {
      const scan = options.scan ?? scanFromEnv()
      const commit = options.commit ?? process.env.CBD_COMMIT ?? 'unknown'
      // A service is what correlation is for. With none, an id on every request
      // would buy nothing, and patching the process's HTTP client for nothing is
      // exactly the kind of side effect this module exists not to have.
      const dir = process.env[SOCKET_DIR_ENV]
      const correlator =
        dir === undefined || dir === '' || process.env[CORRELATION_ENV] === 'off'
          ? undefined
          : new Correlator()
      if (correlator !== undefined) {
        // Before the test files are imported, so a service a test spawns inherits
        // this and is correlating from its first line. The collector cannot rely on
        // winning the race between "the child started" and "the re-scan attached":
        // measured, that gap is most of a fast test, and a request in it would be
        // attributed by time.
        process.env[CORRELATION_HEADER_ENV] = CORRELATION_HEADER
      }
      const recorders = await recordersFor(process.env, shard, {
        commit,
        ...(scan === undefined ? {} : { scan }),
        ...(correlator === undefined ? {} : { owners: correlator }),
      })
      // Installed after the sources are open, so a service that cannot be reached
      // leaves no patched HTTP client behind.
      correlator?.install()
      // The test process reads; the service's reads happen in its own process and
      // are not observable here. Only the first recorder is the in-process one.
      const stopReads = installReadTracking(recorders[0]!)
      const stopProcesses = installProcessTracking(recorders[0]!)
      emitter.on('runner:end', stopReads)
      emitter.on('runner:end', stopProcesses)
      installJapaAdapter(
        emitter,
        recorders,
        correlator === undefined ? {} : { correlation: correlator },
      )
    }

    // Selecting and recording are independent: a run can be narrowed without
    // being recorded, and recorded without being narrowed.
    //
    // `cbd collect` resolves the selection before it spawns the runner and passes
    // it as a file, because it is the only process holding both the map and the
    // diff. Reading it here is what makes the automatic case automatic; a
    // consumer that never runs `cbd collect` never sets the variable, and one that
    // passes `only` explicitly is not overridden.
    const only = options.only ?? readSelection(process.env)
    if (only !== undefined) applyTests(config, only)
  }
}
