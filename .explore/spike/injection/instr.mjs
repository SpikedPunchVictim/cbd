// Injected into ANY Node process via:  NODE_OPTIONS="--import <this file>"
// It instruments its own isolate and offers the deltas on a unix socket.
import inspector from 'node:inspector'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const session = new inspector.Session()
session.connect()

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)))
  })

await call('Profiler.enable')
await call('Debugger.enable')
await call('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

const dir = process.env.CBD_SOCKET_DIR
if (dir) {
  fs.mkdirSync(dir, { recursive: true })
  // One socket per process: `--import` is inherited, so a cluster or a worker pool
  // announces every member without anyone wiring it up.
  const sockPath = path.join(dir, `pid-${process.pid}.sock`)
  try { fs.unlinkSync(sockPath) } catch {}

  net.createServer((conn) => {
    conn.setEncoding('utf8')
    conn.on('data', async (chunk) => {
      const cmd = chunk.trim()
      if (cmd === 'take') {
        const res = await call('Profiler.takePreciseCoverage')
        const names = res.result.flatMap((s) => s.functions.map((f) => f.functionName)).filter(Boolean)
        conn.write(`${JSON.stringify({ pid: process.pid, scripts: res.result.length, names: [...new Set(names)] })}\n`)
      } else if (cmd === 'close') {
        conn.end()
        process.exit(0)
      }
    })
  }).listen(sockPath, () => {
    process.stdout.write(`[cbd] instrumented pid=${process.pid} sock=${sockPath}\n`)
  })
}
