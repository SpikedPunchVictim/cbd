/**
 * The service's entry point, and the file only the copy ever executes.
 *
 * `cbd-jmn`. This file is started from the copy, so its map resolves to
 * `<copy>/src/server.ts`, and the test process never imports it. It is therefore the
 * 269-file case in miniature: with no relocation rule, a change to `src/server.ts`
 * matches nothing the map has ever seen, which §8.3 rule 7 answers with `mode: all` —
 * the entire suite, for a change to one route.
 *
 * **The routing is a function, not an inline callback.** A file whose only evidence
 * is its own import is startup code, and a change to it escalates by a different rule
 * (§8.3 rule 2), which would hide the question this fixture is asking. `route` runs
 * inside a request's window, so this file has per-test evidence of its own.
 */
import { createServer } from 'node:http'
import { fetchKey, storeKey } from './handler.js'

export function route(
  method: string,
  pathname: string,
  query: URLSearchParams,
): { status: number; body: string } {
  if (pathname === '/store') return { status: 200, body: storeKey(query.get('key') ?? '') }
  if (pathname === '/fetch') return { status: 200, body: fetchKey(query.get('key') ?? '') }
  return { status: 404, body: `no route for ${method} ${pathname}` }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const answer = route(request.method ?? 'GET', url.pathname, url.searchParams)
  response.statusCode = answer.status
  response.end(answer.body)
})

// Port 0, with the chosen port announced on stdout, so a fixture never collides with
// whatever else is running on the machine.
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  process.stdout.write(`listening ${port}\n`)
})
