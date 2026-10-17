/**
 * A service that answers immediately and then keeps working.
 *
 * `cbd-a3v.3.5`. The question is what happens to server work that is still to come
 * when a test's window closes, and the shape that produces it is ordinary: a request
 * whose response has been sent, and whose side effect — an audit, a flush, an eviction
 * — runs afterwards, on a later turn of the service's event loop. `setTimeout` after
 * `response.end()` is exactly that, with the delay as the knob, because where the work
 * lands depends entirely on when it runs relative to the boundary.
 *
 * **The work is imported, not required, and that is load-bearing.** A statically
 * imported module's body runs at start-up, which puts its file in `@load` — and a file
 * in `@load` escalates a change to it through rule 9's load arm whatever else happened.
 * To ask the question this fixture exists for — can a *file* be reached by `@between`
 * and nothing else — the module has to arrive late, on a cold path, the way a lazily
 * loaded dependency of a rarely taken branch does.
 *
 * Plain JavaScript and nothing imported from CBD, so the service is started the way a
 * developer starts one (`NODE_OPTIONS`, ADR-0005) rather than through any hook of ours.
 */
import { createServer } from 'node:http'

const sweeps = []

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const afterMs = Number(url.searchParams.get('afterMs') ?? '0')

  if (url.pathname === '/tick') {
    // Responded first, then deferred. The response is what lets the test end; the
    // deferred call is what the test leaves running, and nothing in this process
    // tells any test whether it has finished.
    response.end('ticked')
    setTimeout(() => {
      void import('./sweeper.js').then(({ sweep }) => {
        sweeps.push(sweep(afterMs))
      })
    }, afterMs)
    return
  }

  if (url.pathname === '/sweeps') {
    response.end(String(sweeps.length))
    return
  }

  response.statusCode = 404
  response.end('no such route')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`listening ${String(address.port)}\n`)
})
