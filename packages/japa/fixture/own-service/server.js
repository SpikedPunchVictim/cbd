/**
 * A service the suite starts for itself, in the middle of a run.
 *
 * `cbd-0gw`. Every other service fixture here is started *before* the suite, by the
 * harness, because that is what `dev-cli` does for a lane — and that is exactly why the
 * defect this file exists for went unseen. A source is opened at install and holds the
 * targets that were there at install; a service a test starts was never in that set, and
 * nothing ever looked again.
 *
 * **Its start-up is a path the map can name.** `noting <port>` is written from the
 * module's own body, so the body ran inside whichever window the process was started in,
 * and `own-service-e2e.spec.ts` can ask which window that was. That is the claim ADR-0007
 * turns on: a process's first take is its whole life, so it belongs to the window that
 * caused the process to exist — not to the window after it.
 *
 * **`retireNote` is never called.** V8 reports it in every take with a count of zero, so
 * it is present in the data the recorder reads and must be absent from the map.
 *
 * Plain JavaScript, importing nothing from CBD. The child is instrumented because it
 * inherited `NODE_OPTIONS` from the test process and `CBD_SOCKET_DIR` with it (ADR-0005);
 * a fixture that reached for the instrument module would prove only that the module works
 * when it is called.
 */
import { createServer } from 'node:http'

const notes = new Map()

/** Reached by exactly one test, and by no other. */
function recordNote(text) {
  const note = text.trim().toLowerCase()
  notes.set(note, note)
  return `noted:${note}`
}

/** The control. No route below mentions it, and none ever will. */
function retireNote(text) {
  return notes.delete(text.trim().toLowerCase())
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (url.pathname === '/note') {
    response.end(recordNote(url.searchParams.get('note') ?? ''))
    return
  }

  response.statusCode = 404
  response.end('no such route')
})

// Port 0, with the chosen port announced on stdout, so a fixture never collides with
// whatever else is running on the machine. The word is not `listening`, which is what the
// service the harness starts says: the two are read by different processes, and one
// reader mistaking one announcement for the other would look like a passing test.
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`noting ${String(address.port)}\n`)
})
