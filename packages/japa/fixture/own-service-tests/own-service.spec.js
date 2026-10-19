/**
 * A suite that starts a service of its own, and drives it from the next test.
 *
 * `cbd-0gw`. The shape is the one the defect was found in: a handful of tests that boot a
 * server themselves, from the environment the test process already carries, and keep it
 * alive across the boundaries that follow. Nothing here tells CBD that a service exists —
 * the plugin learned it from `CBD_SOCKET_DIR` at install, for the service the run was
 * pointed at, and this one has to be found by looking again.
 *
 * **It is started inside the first test, not in the group's setup.** Group hooks run
 * outside any window, so a service started there would be born in `@between` and the
 * question this fixture asks — *which window does a process's start-up belong to?* — would
 * have an answer decided by japa's hook timing rather than by the rule under test. Started
 * in a test body the answer is not in doubt: this window started it.
 *
 * **The service outlives the test that started it, and that is the point.** A child killed
 * inside its own test is a different fixture and a different mechanism (`cbd-0gw` step 3,
 * the child's own snapshot); here it is alive for every boundary that follows, so the only
 * thing that can read it is a source that keeps looking.
 *
 * **The last two tests drive other things on purpose.** One drives the service the run was
 * pointed at, so that a source which found the new service by losing the old one fails.
 * One drives nothing at all, so that "this test's window holds none of the service" can be
 * told from "this test was not recorded" — and, here, from "the window in which nothing
 * happened was resolved by attaching something later and reading its whole life into it".
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const SERVICE = fileURLToPath(new URL('../own-service/server.js', import.meta.url))

/** The service this suite started, alive from the first test until the group is done. */
let own = null

/**
 * Starts it the way a developer starts a service: an ordinary `node`, no arguments, and no
 * environment added. `spawn` inherits the parent's environment by default, which is the
 * whole promise — the child is instrumented because `NODE_OPTIONS` was inherited, not
 * because this file said anything about it (ADR-0005).
 */
function startOwnService() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVICE], { stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`the service never announced a port. It wrote:\n${output}`))
    }, 10_000)

    const settle = () => {
      const match = /noting (\d+)/.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve({ proc, port: Number(match[1]) })
    }

    proc.stdout.on('data', (chunk) => {
      output += chunk
      settle()
    })
    proc.stderr.on('data', (chunk) => {
      output += chunk
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    // The announcement may have arrived in the chunk that started this.
    settle()
  })
}

test.group('a service the suite starts itself', (group) => {
  group.teardown(() => {
    // A child left alive holds this process's stdio pipes open, so japa finishes the suite
    // and the process then never exits — which reads as a hang with the report buffered.
    own?.proc.kill('SIGKILL')
    own = null
  })

  test('a test that starts a service of its own', async () => {
    own = await startOwnService()
    assert.ok(own.port > 0)
    // Hold the window open long enough for the re-scan to find the child. The
    // assertion this fixture makes is *which window the child's start-up belongs
    // to*; without the wait, a discovery tick that lands after the test ends moves
    // the whole first take to the next test and the fixture measures the scheduler
    // instead of the rule. The interval is 25ms (ADR-0007), so this is one order of
    // magnitude of slack, not a tuned race.
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  test('a test that drives the service the previous test started', async () => {
    const response = await fetch(`http://127.0.0.1:${String(own.port)}/note?note=Alpha`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'noted:alpha')
  })

  test('a test that drives the service the run was pointed at', async () => {
    const response = await fetch(`${process.env.CBD_FIXTURE_URL ?? ''}/store?key=Beta`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'stored:beta')
  })

  test('a test that drives nothing', () => {
    assert.ok(true)
  })
})
