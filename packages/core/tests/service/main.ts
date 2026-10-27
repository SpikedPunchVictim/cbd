/**
 * A stand-in for the service under test.
 *
 * It imports **nothing** from CBD, and that is the point: the acceptance for
 * `cbd-a3v.1` is that a process which has never heard of this project instruments
 * itself because one environment variable was set. A fixture that imported the
 * instrument module directly would prove only that the module works when called.
 *
 * It is compiled rather than hand-written JavaScript, and compiled with source
 * maps on, because that is the only way to test the thing most likely to be got
 * wrong: `V8ScriptCoverage` carries no `sourceMapURL`, so if the socket does not
 * deliver `Debugger.scriptParsed` rows the coverage cannot be resolved back to
 * this file. Asserting on `main.ts` — a file that does not exist at runtime —
 * fails unless the whole path works.
 *
 * Work is driven from stdin so the test controls the windows. Doing the work at
 * startup instead would put it in the first take, leaving nothing to show that a
 * take is a *delta* rather than a running total.
 *
 * `neverCalled` is never called by anything. It is the inverse map at socket
 * scale: if it appears in a take, the delta is wrong.
 */
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import { Script } from 'node:vm'

export function normalizeKey(input: string): string {
  return input.trim().toLowerCase()
}

export function reverseKey(input: string): string {
  return [...normalizeKey(input)].reverse().join('')
}

export function validateSignature(signature: string): boolean {
  return normalizeKey(signature).length > 0
}

/**
 * A second command's worth of work, and it exists so a test can tell one window
 * from the next. `run` reaches `reverseKey`; this reaches `persistKey`. Without
 * two distinguishable functions, "the boundary landed where I meant it to" has no
 * observable answer — every window would contain the same names.
 */
export function persistKey(key: string): string {
  return `stored:${normalizeKey(key)}`
}

export function neverCalled(seed: number): number {
  return seed * 2
}

/**
 * The handler work a correlated request exists to attribute.
 *
 * A function of its own, called from the request handler below, so a take can say
 * *which* service function ran rather than only that the server answered. `serve`
 * starts the server on port 0 and announces it, which is the same shape the
 * end-to-end fixtures use.
 */
export function priced(quantity: number): number {
  return quantity * 7
}

let server: Server | null = null

const commands = createInterface({ input: process.stdin })

commands.on('line', (line) => {
  const command = line.trim()

  if (command === 'run') {
    const key = reverseKey('AbCdEf')
    process.stdout.write(`ran key=${key} valid=${String(validateSignature(key))}\n`)
    return
  }

  if (command === 'store') {
    process.stdout.write(`${persistKey('GhIjKl')}\n`)
    return
  }

  if (command.startsWith('read ')) {
    const text = readFileSync(command.slice('read '.length), 'utf8')
    process.stdout.write(`read ${String(text.length)}\n`)
    return
  }

  // Compiles source text under a file name without reading the file, so the script
  // exists for the inspector and the service itself has read nothing.
  if (command.startsWith('compile ')) {
    const { file, source } = JSON.parse(command.slice('compile '.length)) as { file: string; source: string }
    new Script(source, { filename: file }).runInThisContext()
    process.stdout.write('compiled\n')
    return
  }

  if (command === 'idle') {
    process.stdout.write('idle\n')
    return
  }

  if (command === 'serve') {
    if (server === null) {
      server = createServer((_request, response) => {
        response.end(String(priced(3)))
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        const port = address !== null && typeof address === 'object' ? address.port : 0
        process.stdout.write(`port ${String(port)}\n`)
      })
    }
    return
  }

  if (command === 'quit') process.exit(0)
})

process.stdout.write('ready\n')
