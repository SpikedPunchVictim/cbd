/**
 * The adapter contract, version 1.
 *
 * **The problem this fixes is identity.** A test used to be `(file, title)`, and
 * the selection file carried bare titles: a rename, a duplicate title, or a title
 * built from a template made the bridge between `cbd select` and the runner a
 * guess. The runner still filters by whatever it filters by, but the *answer* and
 * every artefact built from it now name tests by a runner-neutral id, so a
 * consumer does not have to reverse-engineer japa's `--tests` semantics.
 *
 * **The id excludes the definition site on purpose.** `file::title` survives edits
 * above the test; a line number does not. Adapters that can report a line and a
 * column may do so, and the map keeps them for explain and for a future
 * disambiguation of genuinely duplicated titles — but they are not part of the id,
 * because a selection must not break when unrelated code moves.
 *
 * **`titlePath` is optional and defaults to `[title]`.** japa exposes the bare
 * title it also filters on and a flattened suite path; it does not expose an array
 * of segments. Inventing one by splitting on a separator would mis-split any title
 * that contains it. An adapter that *does* have a path reports it; the rest report
 * the title and are no less correct.
 *
 * The contract is versioned separately from the package because an adapter may be
 * published against a core it does not pin: `ADAPTER_CONTRACT_VERSION` is what a
 * consumer checks (`cbd --version --format json`), and an incompatible change
 * bumps it.
 */

/** Bumped when the contract's semantics change incompatibly. */
export const ADAPTER_CONTRACT_VERSION = 1

/** The shape an adapter reports for one test at the start and end of its window. */
export interface TestRef {
  /** Canonical, runner-neutral id: `<file>::<title>`. Empty file becomes `::title`. */
  id: string
  file: string | null
  title: string
  /** The title path, outermost first, when the runner exposes one. */
  titlePath?: string[]
  /** Definition site, when the runner exposes one. */
  line?: number
  column?: number
}

/** What an adapter may report beyond the title and file the recorder always needs. */
export interface TestRefDetail {
  titlePath?: string[]
  line?: number
  column?: number
}

/** The canonical id for a test. */
export function testId(file: string | null, title: string): string {
  return `${file ?? ''}::${title}`
}

/** Builds the full ref, filling the optional parts only when they are present. */
export function testRef(file: string | null, title: string, detail: TestRefDetail = {}): TestRef {
  return {
    id: testId(file, title),
    file,
    title,
    ...(detail.titlePath === undefined ? {} : { titlePath: detail.titlePath }),
    ...(detail.line === undefined ? {} : { line: detail.line }),
    ...(detail.column === undefined ? {} : { column: detail.column }),
  }
}
