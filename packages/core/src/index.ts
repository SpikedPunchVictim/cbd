export type {
  DriftStats,
  PendingTake,
  QueuedSource,
  ScriptInfo,
  Source,
  V8Function,
  V8Range,
  V8ScriptCoverage,
} from './types.js'

export { inProcessSource } from './source/in-process.js'

export {
  SocketSourceError,
  discoverSockets,
  socketSource,
  type SocketSourceOptions,
  type SocketTarget,
} from './source/socket.js'

export {
  rescanningSocketSource,
  type RescanningSocketSourceOptions,
} from './source/rescan.js'

export {
  DEFAULT_INSPECTOR_HOST,
  DEFAULT_INSPECTOR_TIMEOUT_MS,
  InspectorTargetError,
  inspectorSource,
  isLoopbackHost,
  resolveInspectorTarget,
  type InspectorSourceOptions,
  type InspectorTarget,
} from './source/inspector.js'

export { normalize, scan, type Definition, type ScanOptions, type Touch } from './normalize.js'

export { scanFromEnv } from './env.js'

export { SOCKET_DIR_ENV } from './instrument-protocol.js'

export { canonicalProjectionRules, projectPath, type ProjectionRule } from './projection.js'

export { relocatePath, type RelocationRule } from './relocate.js'

export {
  buildLineIndex,
  columnAt,
  FileCache,
  lineAt,
  type LineIndex,
} from './line-index.js'

export {
  createScriptResolver,
  type OriginalPosition,
  type ScriptResolver,
} from './source-maps.js'

export {
  SHARD_VERSION,
  FileSink,
  IncompleteShardError,
  StringSink,
  parseShard,
  summarizeShard,
  type ShardBucket,
  type ShardFooter,
  type ShardHeader,
  type ShardRecord,
  type ShardSink,
  type ShardTest,
  type TouchRef,
} from './shard.js'

export {
  Recorder,
  classifyStatus,
  type RecorderOptions,
  type TestStatus,
} from './recorder.js'

export {
  MAP_VERSION,
  buildMap,
  functionsInFile,
  loadMap,
  mapDir,
  mapPath,
  saveMap,
  testsForFunction,
  type BuildOptions,
  type CoverageMap,
  type FunctionEntry,
  type LoadedMap,
  type ShardInput,
  type TestEntry,
} from './map.js'

export { matchesAnyGlob, matchesGlob } from './glob.js'

export {
  changesSince,
  intersects,
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
  type MapInfo,
  type Miss,
  type Reason,
  type SelectConfig,
  type Selection,
  type Verification,
} from './select.js'
