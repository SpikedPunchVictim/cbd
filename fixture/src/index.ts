/**
 * Barrel re-export. A test importing from here pulls in several modules at
 * once, which is the realistic shape that makes a naive "one file, one test"
 * assumption wrong.
 */

export { add, clamp, factorial, multiply } from './math.js'
export { toSlug, titleCase, truncate } from './strings.js'
export { chunk, unique } from './collections.js'
export { loadSettings, settingsPath } from './settings.js'
