/**
 * `NODE_OPTIONS="--import @spikedpunch/cbd-japa/register"` starts recording before
 * the runner entry's own imports run.
 *
 * The plugin cannot do this alone. It starts recording when japa installs it,
 * inside `configure({ plugins: [cbd()] })`, and everything the entry imported
 * above that line — a shared test-kit, a config module — has already run. Those
 * files are then absent from the map, and a change to one is an unknown file,
 * which selects everything. This module opens the session first, while Node is
 * still resolving the `--import` list, and parks it for the plugin to adopt; the
 * executions before the first test land in `@load`, as module loading does.
 *
 * It is still the plugin that installs the window hooks: japa hands its plugins
 * the emitter and nothing else reaches it (see `plugin.ts`). The preload only
 * moves the start of recording earlier, so the plugin-only setup keeps working
 * unchanged and the two compose — the plugin line stays.
 *
 * Inert unless `CBD_SHARD` is set. The value is read and then removed: a child a
 * test spawns inherits `NODE_OPTIONS` and so this preload, and with the variable
 * left in place its own preload would reopen and truncate this process's shard.
 * (The mocha entry point does the same.) A second import of this module in one
 * process is also a no-op.
 *
 * Settings come from the environment (`CBD_SHARD`, `CBD_COMMIT`, the scan
 * variables, `CBD_SOCKET_DIR`); a `shard`, `commit` or `scan` passed to `cbd()`
 * does not apply to a session the preload already started. `only` still does.
 */
import { parkSession, startRecording } from './plugin.js'

const GUARD = Symbol.for('@spikedpunch/cbd-japa/register')
const guarded = globalThis as { [GUARD]?: true }

const shard = process.env.CBD_SHARD || undefined
if (shard !== undefined && guarded[GUARD] !== true) {
  guarded[GUARD] = true
  delete process.env.CBD_SHARD
  parkSession(await startRecording(shard))
}
