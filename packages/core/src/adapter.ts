/**
 * Tier 2 — the adapter seam (ADR-0003), `@spikedpunch/cbd/adapter`.
 *
 * Everything an adapter author needs to turn a test runner's lifecycle into shard
 * records, and nothing a selection consumer needs. **Explicitly unstable**: this
 * surface may change shape when a second framework disagrees with the assumptions
 * japa and mocha share. The stable surface is the package root and its five verbs.
 *
 * Keeping it separate is what keeps the root small: `Recorder`, the sources, the
 * sinks and the normalizer are implementation, while `createCbd` is the contract.
 */
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
  CORRELATION_ENV,
  CORRELATION_HEADER,
  CORRELATION_HEADER_ENV,
  Correlator,
  type CorrelatedTest,
  type OwnerIndex,
} from './correlate.js'

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

export {
  normalize,
  scan,
  type Definition,
  type OrdinalRegistry,
  type ScanOptions,
  type Touch,
} from './normalize.js'

export { CBD_SELF_ROOTS, packageCodeRoots, packageRoot } from './self.js'

export {
  INCLUDE_SELF_ENV,
  readSelection,
  readSelectionTests,
  scanFromEnv,
  SELECTION_ENV,
  writeSelection,
  type SelectionFile,
  type SelectionTest,
} from './env.js'

export {
  ADAPTER_CONTRACT_VERSION,
  testId,
  testRef,
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

export { installReadTracking, type ReadSink } from './read-tracker.js'
export { installProcessTracking, type ProcessSink } from './process-tracker.js'

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
  FileSink,
  IncompleteShardError,
  ShardVersionError,
  StringSink,
  parseShard,
  summarizeShard,
  type ParseShardOptions,
  type RawRange,
  type ShardFunction,
  type ShardInput,
  type ShardScript,
  type ShardSink,
  type ShardTouch,
} from './shard.js'

export {
  resolveShard,
  StaleShardError,
  type ResolvedShard,
  type ResolvedTest,
  type ResolveOptions,
} from './resolve.js'

export {
  Recorder,
  classifyStatus,
  type ProjectedCapture,
  type ProjectedWindow,
  type RecorderOptions,
  type TestStatus,
} from './recorder.js'
