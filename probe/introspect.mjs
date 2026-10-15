/**
 * Stage A0: dump the installed @japa/runner API surface.
 *
 * CBD.md §13 recorded its hook facts against japa 5.0.0; the registry now serves
 * 5.4.0. Rather than assume the hooks are unchanged, read what is actually
 * installed and diff that against what the adapter wants to attach to.
 */
// @japa/core is transitive under pnpm's strict layout; @japa/runner re-exports it.
import * as runner from '@japa/runner'

const METHODS_OF_INTEREST = /setup|teardown|onTest|onGroup|onSuite|tap|event|start|end/i

function dumpExports(label, mod) {
  console.log(`\n=== ${label} exports ===`)
  for (const key of Object.keys(mod).sort()) {
    const value = mod[key]
    const kind = typeof value === 'function'
      ? (value.prototype ? 'class' : 'fn')
      : typeof value
    console.log(`  ${key.padEnd(28)} ${kind}`)
  }
}

function dumpPrototype(label, Ctor) {
  if (typeof Ctor !== 'function' || !Ctor.prototype) return
  const own = Object.getOwnPropertyNames(Ctor.prototype)
    .filter((n) => n !== 'constructor')
  const interesting = own.filter((n) => METHODS_OF_INTEREST.test(n))
  if (!interesting.length) return
  console.log(`\n  --- ${label}.prototype (hooks) ---`)
  for (const name of interesting.sort()) {
    console.log(`    ${name}`)
  }
  const other = own.filter((n) => !METHODS_OF_INTEREST.test(n))
  if (other.length) console.log(`    [other: ${other.sort().join(', ')}]`)
}

dumpExports('@japa/runner', runner)


for (const [label, mod] of [['runner', runner]]) {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function' && value.prototype) dumpPrototype(`${label}.${name}`, value)
  }
}
