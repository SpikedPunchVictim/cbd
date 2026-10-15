/**
 * Shapes shared by every coverage source and by the Normalizer.
 *
 * Nothing here mentions a test framework. CBD's core is framework-neutral by
 * rule: adapters translate their runner's lifecycle into these types, and the
 * core never learns which runner it was.
 */

/** A coverage range inside a function, in the generated file's byte offsets. */
export interface V8Range {
  startOffset: number
  endOffset: number
  /** With `callCount: true`, executions of this range since the previous take. */
  count: number
}

export interface V8Function {
  functionName: string
  isBlockCoverage: boolean
  /** `ranges[0]` spans the whole function; later ranges are blocks inside it. */
  ranges: V8Range[]
}

export interface V8ScriptCoverage {
  scriptId: string
  url: string
  functions: V8Function[]
}

export interface ScriptInfo {
  url: string
  /**
   * As reported on `Debugger.scriptParsed`. May be relative to the script's own
   * URL, or a `data:` URI carrying an inline map.
   */
  sourceMapURL?: string
}

/**
 * Where coverage comes from.
 *
 * Both a synchronous and an asynchronous take are on the interface because the
 * two consumers genuinely differ (A0 F1/F9): japa does not await its lifecycle
 * hooks, so a japa-driven adapter can only use `takeSync()`; an out-of-process
 * source speaking CDP over a socket can only offer `take()`. Carrying both keeps
 * the integration-testing door open without a breaking change later.
 */
export interface Source {
  readonly kind: string
  /** False when this source cannot produce a delta synchronously. */
  readonly supportsSync: boolean
  /** Throws if `supportsSync` is false. */
  takeSync(): V8ScriptCoverage[]
  take(): Promise<V8ScriptCoverage[]>
  /** `scriptId` -> info, populated from `Debugger.scriptParsed`. */
  scripts(): ReadonlyMap<string, ScriptInfo>
  close(): void
}
