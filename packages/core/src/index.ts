export type {
  ScriptInfo,
  Source,
  V8Function,
  V8Range,
  V8ScriptCoverage,
} from './types.js'

export { inProcessSource } from './source/in-process.js'

export { normalize, scan, type Definition, type ScanOptions, type Touch } from './normalize.js'

export { projectPath, type ProjectionRule } from './projection.js'

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
