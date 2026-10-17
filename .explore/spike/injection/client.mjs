// Stands in for the collector. It discovers whatever announced itself, with no
// knowledge of ports, --inspect, or /json/list.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const dir = process.argv[2]

function take(sockPath) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath)
    conn.setEncoding('utf8')
    let buf = ''
    conn.on('connect', () => conn.write('take\n'))
    conn.on('data', (chunk) => {
      buf += chunk
      if (!buf.includes('\n')) return
      resolve(JSON.parse(buf.split('\n')[0]))
      conn.write('close\n')
      conn.end()
    })
    conn.on('error', reject)
  })
}

const sockets = fs.readdirSync(dir).filter((f) => f.endsWith('.sock'))
console.log(`discovered ${sockets.length} instrumented process(es): ${sockets.join(', ')}`)

for (const file of sockets) {
  const result = await take(path.join(dir, file))
  console.log(
    `  pid=${result.pid} scripts=${result.scripts} ` +
      `saw handleKeyRequest=${result.names.includes('handleKeyRequest')} ` +
      `saw validateSignature=${result.names.includes('validateSignature')} ` +
      `saw workerWork=${result.names.includes('workerWork')}`,
  )
}
