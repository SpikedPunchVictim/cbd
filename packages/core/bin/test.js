import { configure, processCLIArgs, run } from '@japa/runner'

// Dogfooding: this repository records and narrows its own suite too. The adapter
// is imported only when a recording or a selection asks for it, so an ordinary
// run does not depend on the japa package being built.
const shard = process.env.CBD_SHARD
const commit = process.env.CBD_COMMIT
const enabled = shard !== undefined || process.env.CBD_SELECTION !== undefined
const scan = enabled ? (await import('@spikedpunch/cbd/adapter')).scanFromEnv() : undefined
const plugins = enabled
  ? [
      (await import('@spikedpunch/cbd-japa')).cbd({
        ...(shard === undefined ? {} : { shard }),
        ...(commit === undefined ? {} : { commit }),
        ...(scan === undefined ? {} : { scan }),
      }),
    ]
  : []

// The recording context belongs to this process. A child that inherited it would
// append a second header to the same shard, and a self-inclusive scan would make
// the adapter e2e suites record the files they assert are absent.
delete process.env.CBD_SHARD
delete process.env.CBD_COMMIT
delete process.env.CBD_INCLUDE_SELF

// processCLIArgs MUST precede configure. `configure` hydrates with a snapshot of
// the parsed args taken at call time, so the reverse order silently discards
// every CLI filter — `--tests <anything>` would run the whole suite and report a
// clean pass. See A0 F11.
processCLIArgs(process.argv.slice(2))
configure({ files: ['dist/tests/**/*.spec.js'], plugins })
await run()
