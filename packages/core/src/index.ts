/**
 * The stable surface: one factory and five verbs (ADR-0003).
 *
 * `createCbd(config)` binds the repository and the selection config once and
 * returns `build`, `select`, `explain`, `stats` and `verify`. Everything else here
 * is the data those verbs produce or consume: the map and its queries, the diff,
 * the selection, and the shard records a map is built from.
 *
 * **The adapter seam is not here.** `Recorder`, the sources, the sinks, `parseShard`
 * and the normalizer live behind `@spikedpunch/cbd/adapter` and are explicitly
 * unstable. Keeping them out is what lets a developer describe the whole API from
 * memory, and what stops the CLI, a library caller and an MCP server from each
 * reaching for a different layer.
 */
export { createCbd, nearestMapCommit } from './factory.js'
export type {
  BuildOptions,
  BuildResult,
  Cbd,
  CbdConfig,
  ExplainResult,
  ExplainTarget,
  FileStat,
  MapSummary,
  Quantiles,
  ReachRow,
  ReachRowResult,
  ReachesResult,
  SelectOptions,
  SelectResult,
  StatsResult,
} from './factory.js'

export {
  SHARD_VERSION,
  ShardVersionError,
  type RawRange,
  type ShardBucket,
  type ShardFooter,
  type ShardFunction,
  type ShardHeader,
  type ShardInput,
  type ShardRecord,
  type ShardScript,
  type ShardTest,
  type ShardTouch,
  type TouchRef,
} from './shard.js'

export {
  MAP_VERSION,
  buildMap,
  functionsForTest,
  functionsInFile,
  loadMap,
  mapDir,
  mapPath,
  saveMap,
  testsForFunction,
  testsForLine,
  type CoverageMap,
  type FunctionEntry,
  type LoadedMap,
  type MapBuildOptions,
  type ReachedFunction,
  type TestEntry,
} from './map.js'

export { StaleShardError } from './resolve.js'

export {
  mutantTests,
  type MutantPolicy,
  type MutantSelection,
  type MutantTarget,
  type MutantWhy,
} from './mutate.js'

export { matchesAnyGlob, matchesGlob } from './glob.js'

export {
  configPath,
  loadConfig,
  loadConfigFile,
  parseConfig,
  type CbdConfigFile,
  type LoadedConfig,
} from './config.js'

export {
  changesSince,
  commitsSince,
  headCommit,
  intersects,
  mergeChanges,
  parseUnifiedDiff,
  sameCommit,
  type Change,
  type ChangeStatus,
  type ChangesOptions,
  type LineRange,
} from './changes.js'

export {
  select,
  verify,
  type AllWhy,
  type GroundTruth,
  type GroundTruthTest,
  type MapInfo,
  type Miss,
  type Reason,
  type SelectConfig,
  type Selection,
  type Verification,
} from './select.js'

/**
 * The selection-file contract between `cbd collect` and an adapter.
 *
 * Data, not adapter machinery: the CLI writes `{ titles }` to the path in
 * `CBD_SELECTION` and a runner reads it. The reader itself (`readSelection`) lives
 * behind the adapter seam with the other environment readers.
 */
export { SELECTION_ENV, writeSelection, type SelectionFile, type SelectionTest } from './env.js'

/**
 * The attach-target contract between `cbd collect --target` and an adapter.
 *
 * The CLI resolves and checks the target before spawning the suite and writes it
 * into `CBD_INSPECT`; the adapter opens the source from the same value. Both halves
 * go through one parser so the check the CLI makes is the check the attach makes.
 * The source itself stays behind the adapter seam.
 */
export {
  INSPECT_ALLOW_REMOTE_ENV,
  INSPECT_ENV,
  allowRemoteFromEnv,
  assertInspectorUnheld,
  parseInspectorTarget,
  type InspectorSourceOptions,
} from './source/inspector.js'

export {
  ADAPTER_CONTRACT_VERSION,
  testId,
  testRef,
  titlePartReadings,
  type TestRef,
  type TestRefDetail,
} from './contract.js'
export {
  activateRecordSink,
  recordDependency,
  recordDirRead,
  recordOpaque,
  recordRead,
  recordSink,
  type RecordSink,
} from './record.js'
