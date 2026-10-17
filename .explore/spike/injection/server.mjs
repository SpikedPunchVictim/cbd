// Stands in for a service the developer already has. It knows nothing about CBD:
// no import, no wrapper, no flag of its own.
import { spawn } from 'node:child_process'

function handleKeyRequest(key) {
  return key.split('').reverse().join('')
}

function validateSignature(input) {
  return input.length > 3
}

const reversed = handleKeyRequest('abcdef')
console.log(`[server] pid=${process.pid} ready reversed=${reversed} valid=${validateSignature(reversed)}`)

// A worker, to show that --import is inherited rather than wired up per process.
if (process.env.SPAWN_WORKER === '1') {
  const child = spawn(process.execPath, ['-e', 'function workerWork(x){return x+1}; setInterval(()=>workerWork(1),1000)'], {
    stdio: 'inherit',
  })
  child.unref()
}

setInterval(() => {}, 1000)
