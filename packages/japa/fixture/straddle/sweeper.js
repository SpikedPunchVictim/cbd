/**
 * The deferred half of the straddle fixture, in a file of its own.
 *
 * Deliberately its own module, reached by nothing else. The hazard `cbd-a3v.3.5`
 * exists to measure is not "work is misattributed" on its own — it is that a *file*
 * whose only evidence is `@between` escalates to the whole suite (§8.3 rule 9), so a
 * file reached only by work that ran outside every window is the case that raises
 * P(all). Keeping `sweep` alone here is what makes that file exist.
 */
const swept = []

export function sweep(label) {
  swept.push(label)
  return swept.length
}
