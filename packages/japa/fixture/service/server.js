/**
 * A service under test, started the way a developer starts one.
 *
 * `cbd-a3v.3.4`. The acceptance for this work names a suite that drives a
 * separately started server, and that suite lives in another repository — so the
 * shape is reproduced here, at the smallest size that can still tell a correct
 * recording from a plausible wrong one.
 *
 * **It imports nothing from CBD, and must not.** The claim is that a process which
 * has never heard of this project instruments itself because one environment
 * variable was set (ADR-0005). A fixture that reached for the instrument module
 * would prove only that the module works when it is called.
 *
 * **`rotateMasterKey` is never called, and that is its job.** V8 reports it in
 * every take with a call count of zero — measured, not assumed — so it is present
 * in the data the recorder reads and must be absent from the map. Without it, a
 * pipeline that had lost its "did this function actually run?" filter would
 * attribute every function in this file to whichever window loaded it, and would
 * read exactly like a correct map.
 *
 * **Plain JavaScript, deliberately.** A source map here would put two failures
 * behind one symptom — the windowing and the mapping — and
 * `packages/core/tests/service/main.ts` already covers the mapping half against a
 * compiled service. This file's coordinates are its own.
 */
import { createServer } from 'node:http'

const keys = new Map()

/** Reached by exactly one test, and by no other. */
function storeKey(input) {
  const key = input.trim().toLowerCase()
  keys.set(key, key)
  return `stored:${key}`
}

/**
 * A *second* reachable function, and it is what makes a window distinguishable
 * from a running total. A take that accumulated rather than resetting would show
 * `storeKey` in this test's window too, and nothing else in the file would say so.
 */
function fetchKey(input) {
  return keys.get(input.trim().toLowerCase()) ?? ''
}

/** The control. No handler below mentions it, and none ever will. */
function rotateMasterKey() {
  return 'rotated'
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const key = url.searchParams.get('key') ?? ''

  if (url.pathname === '/store') {
    response.end(storeKey(key))
    return
  }

  if (url.pathname === '/fetch') {
    response.end(fetchKey(key))
    return
  }

  response.statusCode = 404
  response.end('no such route')
})

// Port 0, with the chosen port announced on stdout, so a fixture never collides
// with whatever else is running on the machine.
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`listening ${String(address.port)}\n`)
})
