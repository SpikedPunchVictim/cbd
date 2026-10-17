/**
 * The behaviour of the service, in a file of its own — and the file the two
 * recording paths disagree about.
 *
 * `cbd-jmn`. A deployed lane runs the server from a COPY of its build
 * (`<repo>/.grizzly-dev/<lane>/…`), and the compiler emits inline source maps, so the
 * copy's `dist/handler.js` resolves — correctly, through its own map — to the copy's
 * own `src/handler.ts`. That path is one no repository diff can produce, which is the
 * whole defect: the map is keyed by where the code ran, not by where it lives.
 *
 * This file is where the two halves of a real suite meet. Some tests run it in
 * process, from the checkout's own build; other tests reach it over HTTP, in the
 * copy. One file, two coordinate systems, and a repository diff names only one of
 * them — so the union has to happen in the map.
 *
 * Three functions, and the count is the point: one reached both ways, one reached
 * only over HTTP (so a window can be told from a running total), and one reached not
 * at all (so a pipeline that had lost its "did this actually run?" filter would read
 * exactly like a correct one).
 */

const keys = new Map<string, string>()

/** Reached in this process by one test, and over HTTP by another. */
export function storeKey(input: string): string {
  const key = input.trim().toLowerCase()
  keys.set(key, key)
  return `stored:${key}`
}

/** Reached over HTTP only, by a different test. */
export function fetchKey(input: string): string {
  return keys.get(input.trim().toLowerCase()) ?? ''
}

/** The control. No route below reaches it, and none ever will. */
export function rotateMasterKey(): string {
  return 'rotated'
}
