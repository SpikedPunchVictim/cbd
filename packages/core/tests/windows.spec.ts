/**
 * The Windows branches of the path and socket code, run on any platform.
 *
 * Each function under test takes the platform (or the `path` module) as a parameter,
 * so the win32 behaviour is exercised here rather than only on a Windows runner.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { test } from '@japa/runner'
import { SocketSourceError } from '../src/adapter.js'
import { pipeNameFor } from '../src/instrument-protocol.js'
import { matchesAnyGlob, matchesGlob } from '../src/glob.js'
import { loadPath, storePath } from '../src/map.js'
import { gitRelative } from '../src/paths.js'
import { joinUnder, projectPath, restUnder, within } from '../src/projection.js'
import { rebase } from '../src/relocate.js'
import { endpointOf } from '../src/source/socket.js'

const win = 'win32'

test('a backslash path is within its prefix on win32, case aside', () => {
  assert.equal(within('C:\\repo\\out\\a.js', 'c:\\repo\\out', win), true)
  assert.equal(within('C:\\repo\\out', 'C:\\repo\\out', win), true)
  assert.equal(within('C:\\repo\\out-extra\\a.js', 'C:\\repo\\out', win), false)
  assert.equal(within('C:/repo/out/a.js', 'C:\\repo\\out\\', win), true)
})

test('restUnder and joinUnder use the win32 separator', () => {
  assert.equal(restUnder('C:\\repo\\out\\src\\a.js', 'C:\\repo\\out', win), 'src\\a.js')
  assert.equal(joinUnder('C:\\repo\\', 'src\\a.js', win), 'C:\\repo\\src\\a.js')
  assert.equal(joinUnder('C:\\repo\\', '', win), 'C:\\repo')
})

test('projects a win32 compiled path onto its source with the extension swapped', () => {
  const rules = [{ from: 'C:\\repo\\out', to: 'C:\\repo' }]
  assert.equal(projectPath('C:\\repo\\out\\src\\math.js', rules, win), 'C:\\repo\\src\\math.ts')
  assert.equal(projectPath('C:\\repo\\out', rules, win), 'C:\\repo')
  assert.equal(projectPath('C:\\repo\\src\\math.ts', rules, win), null)
})

test('a dot in a win32 directory name is not mistaken for an extension', () => {
  const rules = [{ from: 'C:\\repo\\out', to: 'C:\\repo' }]
  assert.equal(projectPath('C:\\repo\\out\\v1.2\\index', rules, win), 'C:\\repo\\v1.2\\index')
})

test('relocation rewrites a win32 path under the rule and leaves others alone', () => {
  const rules = [{ from: 'C:\\lane', to: 'C:\\repo' }]
  assert.equal(rebase('C:\\lane\\src\\a.ts', 'C:\\lane\\src\\a.ts', rules, win), 'C:\\repo\\src\\a.ts')
  assert.equal(rebase('C:\\other\\a.ts', 'C:\\other\\a.ts', rules, win), 'C:\\other\\a.ts')
})

test('the git-style prefix of a win32 subdirectory root uses forward slashes', () => {
  assert.equal(gitRelative('C:\\repo', 'C:\\repo\\packages\\app', path.win32), 'packages/app')
  assert.equal(gitRelative('C:\\repo', 'C:\\repo', path.win32), '')
})

test('a win32 map path is stored with forward slashes and loads back to the same file', () => {
  const stored = storePath('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32)
  assert.equal(stored, 'src/a.ts')
  assert.equal(loadPath('C:\\repo', stored, path.win32), 'C:\\repo\\src\\a.ts')
})

test('a win32 path outside the root stays absolute in the map', () => {
  assert.equal(storePath('C:\\repo', 'D:\\cache\\x.js', path.win32), 'D:\\cache\\x.js')
  assert.equal(storePath('C:\\repo', 'C:\\other\\x.js', path.win32), 'C:\\other\\x.js')
})

test('globs ignore case when asked to, and only then', () => {
  assert.equal(matchesGlob('src/App.ts', 'src/app.ts', true), true)
  assert.equal(matchesGlob('src/App.ts', 'src/app.ts', false), false)
  assert.equal(matchesAnyGlob('SRC/a.ts', ['src/**'], true), 'src/**')
  assert.equal(matchesAnyGlob('SRC/a.ts', ['src/**'], false), null)
})

test('a win32 backslash path matches a forward-slash glob', () => {
  assert.equal(matchesGlob('src\\deep\\a.ts', 'src/**/*.ts', false), true)
})

test('the pipe name is a named pipe, per pid and per directory', () => {
  const name = pipeNameFor('/tmp/a', 42)
  assert.match(name, /^\\\\\.\\pipe\\cbd-[0-9a-f]{12}-42$/)
  assert.notEqual(name, pipeNameFor('/tmp/b', 42))
  assert.notEqual(name, pipeNameFor('/tmp/a', 43))
})

test('on win32 the endpoint is the pipe named inside the pid file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-win-'))
  try {
    const file = join(dir, 'pid-7.sock')
    writeFileSync(file, `${pipeNameFor(dir, 7)}\n`)
    assert.equal(endpointOf(file, win), pipeNameFor(dir, 7))
    assert.equal(endpointOf(file, 'linux'), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pid file that names no pipe is refused on win32', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-win-'))
  try {
    const file = join(dir, 'pid-8.sock')
    writeFileSync(file, 'garbage')
    assert.throws(() => endpointOf(file, win), SocketSourceError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
