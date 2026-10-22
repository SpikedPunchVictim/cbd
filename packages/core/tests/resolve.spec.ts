/**
 * Build-time resolution: a v2 shard's byte ranges -> the map's identities.
 *
 * The recorder no longer names anything, so these are the assertions that used to
 * live in `normalize.spec.ts` — but now they run against the union over every
 * window, which is what fixes the A4 ordinal collision.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { buildLineIndex } from '../src/line-index.js'
import { resolveShard, StaleShardError } from '../src/resolve.js'
import type {
  ShardFunction,
  ShardHeader,
  ShardInput,
  ShardRecord,
  ShardScript,
  ShardTouch,
} from '../src/shard.js'

const SRC = [
  '// a leading comment, so the first function does not start at offset 0',
  'function alpha() {',
  '  return 1',
  '}',
  'const one = () => 1',
  'const two = () => 2',
  'function late() {',
  '  return 3',
  '}',
].join('\n')

interface Tree {
  root: string
  file: string
  url: string
  cleanup: () => void
}

function makeTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'cbd-resolve-'))
  const file = join(root, 'mod.js')
  writeFileSync(file, SRC)
  return {
    root,
    file,
    url: pathToFileURL(file).href,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function header(): ShardHeader {
  return { type: 'shard', version: 2, commit: 'c0ffee', pid: 1, startedAt: 'T0' }
}

function script(tree: Tree): ShardScript {
  const stat = statSync(tree.file)
  return {
    type: 'script',
    scriptId: '1',
    url: tree.url,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: createHash('sha256').update(readFileSync(tree.file)).digest('hex'),
  }
}

function fn(start: number, end: number, name: string): ShardFunction {
  return { type: 'function', scriptId: '1', start, end, name }
}

function rangeOf(text: string): [number, number] {
  const start = SRC.indexOf(text)
  return [start, start + text.length]
}

function shard(records: ShardRecord[]): ShardInput {
  return { name: 's.ndjson', records }
}

function end(tests: number): ShardRecord {
  return { type: 'end', tests, finishedAt: 'T1' }
}

const alpha = rangeOf('function alpha() {\n  return 1\n}')
const arrowOne = rangeOf('() => 1')
const arrowTwo = rangeOf('() => 2')
const late = rangeOf('function late() {\n  return 3\n}')

test('a rebuilt file with identical bytes is accepted; a changed one is not', () => {
  const tree = makeTree()
  try {
    const row = script(tree)
    // A suite that rebuilds its own dist changes the mtime without changing a byte.
    const rebuilt = { ...row, mtimeMs: row.mtimeMs - 60_000 }
    assert.doesNotThrow(() => resolveShard(shard([header(), rebuilt, end(0)])))

    // Same size and mtime shift, different bytes: still refused.
    const changed = { ...rebuilt, hash: '0'.repeat(64) }
    assert.throws(() => resolveShard(shard([header(), changed, end(0)])), StaleShardError)

    // A pre-hash shard keeps the mtime rule.
    const legacy = { ...rebuilt }
    delete legacy.hash
    assert.throws(() => resolveShard(shard([header(), legacy, end(0)])), StaleShardError)
  } finally {
    tree.cleanup()
  }
})

/**
 * A generated-text failure is only dangerous when the file on disk is not the text
 * V8 compiled. A source map is what says so; without one the file *is* the script and
 * the fallback is correct.
 */
test('a missing generated script is partial only when its file has a map', () => {
  const mapped = makeTree()
  const plain = makeTree()
  try {
    writeFileSync(`${mapped.file}.map`, '{"version":3,"sources":[],"names":[],"mappings":""}')
    const health: ShardRecord = { type: 'health', generatedMissing: ['1'] }

    const withMap = resolveShard(shard([header(), script(mapped), health, end(0)]))
    assert.deepEqual(withMap.partialFiles, [realpathSync(mapped.file)])

    const withoutMap = resolveShard(shard([header(), script(plain), health, end(0)]))
    assert.deepEqual(withoutMap.partialFiles, [])
  } finally {
    mapped.cleanup()
    plain.cleanup()
  }
})

test('a health record carries the failed-take count into the resolution', () => {
  const tree = makeTree()
  try {
    const resolved = resolveShard(
      shard([header(), script(tree), { type: 'health', failedTakes: 2 }, end(0)]),
    )
    assert.equal(resolved.failedTakes, 2)
  } finally {
    tree.cleanup()
  }
})

test('byte ranges resolve to the map identity and line range', () => {
  const tree = makeTree()
  try {
    const resolved = resolveShard(
      shard([
        header(),
        script(tree),
        fn(alpha[0], alpha[1], 'alpha'),
        { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '1': [alpha] } },
        end(1),
      ]),
    )
    // The resolver canonicalizes, and macOS's `tmpdir()` sits behind a symlink.
    assert.deepEqual(resolved.tests[0]?.touches, [[realpathSync(tree.file), 'alpha@0', 2, 4]])
  } finally {
    tree.cleanup()
  }
})

/**
 * A4's regression: the first sighting of a script may be partial, so ordinals
 * cannot be assigned window by window. Two arrows that first appear in different
 * windows must still be two functions, numbered in source order — not both
 * `<anonymous>@0`, merged into one range spanning both.
 */
test('ordinals come from the union, not from the first window that saw a function', () => {
  const tree = makeTree()
  try {
    const resolved = resolveShard(
      shard([
        header(),
        script(tree),
        fn(arrowTwo[0], arrowTwo[1], ''),
        fn(arrowOne[0], arrowOne[1], ''),
        fn(late[0], late[1], 'late'),
        // The later arrow is seen first; the earlier one appears only in the next
        // window, and a per-window ordinal would number it 0 as well.
        { type: 'test', title: 'first', file: null, status: 'passed', durationMs: 1, touches: { '1': [arrowTwo] } },
        { type: 'test', title: 'second', file: null, status: 'passed', durationMs: 1, touches: { '1': [arrowOne, late] } },
        end(2),
      ]),
    )
    const first = resolved.tests.find((t) => t.title === 'first')!
    const second = resolved.tests.find((t) => t.title === 'second')!
    assert.deepEqual(first.touches.map((ref) => ref[1]), ['<anonymous>@1'])
    assert.deepEqual(
      second.touches.map((ref) => ref[1]).sort(),
      ['<anonymous>@0', 'late@0'],
    )
    // And the two arrows are distinct ranges, not one merged row.
    assert.deepEqual(
      [first.touches[0]![2], second.touches.find((r) => r[1] === '<anonymous>@0')![2]],
      [6, 5],
    )
  } finally {
    tree.cleanup()
  }
})

// ADR-0002's new failure mode: an offset means nothing against different bytes.
// `cbd-xnp.2`: Jest's VM wrapper and the first function it contains can share a
// start offset, so identity is the range, not the start.
test('two functions that share a start offset resolve separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-resolve-range-'))
  try {
    const generated = join(root, 'wrapper.js')
    writeFileSync(generated, 'function add(a, b) { return a + b }\n')
    const stat = statSync(generated)
    const resolved = resolveShard(
      shard([
        header(),
        {
          type: 'script',
          scriptId: '1',
          url: pathToFileURL(generated).href,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
        fn(0, 100, ''),
        fn(0, 10, 'add'),
        { type: 'load', touches: { '1': [[0, 100]] } },
        { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '1': [[0, 10]] } },
        end(1),
      ]),
    )
    assert.deepEqual(resolved.load.map((ref) => ref[1]), ['<module>@0'])
    assert.deepEqual(resolved.tests[0]?.touches.map((ref) => ref[1]), ['add@0'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// `cbd-x2j`: a loader compiles text that is not the file on disk. The shard
// records the generated text's line starts, so offsets are converted before the
// source map is asked. Without them, the file index clamps the offset to its last
// line and the forward fallback lands on a different mapping.
test('a transformed script resolves through its generated line starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-resolve-generated-'))
  try {
    const file = join(root, 'mod.ts')
    const source = ['// a source comment', 'export function alpha() {', '  return 1', '}'].join('\n')
    writeFileSync(file, source)

    // Ten generated lines before the function make the offset longer than the
    // source file, which is what clamped the old build to the last source line.
    const generated = `${Array.from({ length: 10 }, (_, i) => `// generated ${String(i)}`).join('\n')}\nfunction alpha(){return 1}\n`
    const start = generated.indexOf('function alpha')

    // Line 5 maps to source line 4; line 11 (the function) maps to source line 2.
    // VLQ: AAGA = [0,0,+3,0], AAFA = [0,0,-2,0] from the previous source line.
    const map = {
      version: 3,
      sources: [realpathSync(file)],
      names: [],
      mappings: ';;;;AAGA;;;;;;AAFA',
    }
    const inline = Buffer.from(JSON.stringify(map)).toString('base64')
    const stat = statSync(file)
    const index = buildLineIndex(generated)

    const resolved = resolveShard(
      shard([
        header(),
        {
          type: 'script',
          scriptId: '1',
          url: pathToFileURL(file).href,
          sourceMapURL: `data:application/json;base64,${inline}`,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
        // The end-of-run update row the recorder writes after `prepare()`.
        {
          type: 'script',
          scriptId: '1',
          url: pathToFileURL(file).href,
          generated: { lineStarts: index.starts, length: index.length },
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
        fn(start, generated.length, 'alpha'),
        { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '1': [[start, generated.length]] } },
        end(1),
      ]),
    )
    // The source map says line 2. A file-index conversion would clamp to line 4
    // (the source has four lines) and forward to the line-5 mapping instead.
    assert.deepEqual(resolved.tests[0]?.touches, [[realpathSync(file), 'alpha@0', 2, 2]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a test carries its file and directory reads through the build filter', () => {
  const tree = makeTree()
  try {
    const resolved = resolveShard(
      shard([
        header(),
        script(tree),
        {
          type: 'test',
          title: 'reads',
          file: null,
          status: 'passed',
          durationMs: 1,
          touches: {},
          reads: [tree.file, join(tree.root, 'notes.txt')],
          dirReads: [tree.root, join(tree.root, 'node_modules')],
        },
        end(1),
      ]),
      { scan: { include: (file) => file.endsWith('.js') } },
    )
    // Read files follow include; directories are kept so a change to any file
    // under a listed directory still selects the lister.
    assert.deepEqual(resolved.tests[0]?.reads, [tree.file])
    // Directories are kept as recorded when no relocation rule applies.
    assert.deepEqual(resolved.tests[0]?.dirReads, [tree.root, join(tree.root, 'node_modules')])
  } finally {
    tree.cleanup()
  }
})

test('a shard whose script changed size is refused', () => {
  const tree = makeTree()
  try {
    const input = shard([
      header(),
      script(tree),
      fn(alpha[0], alpha[1], 'alpha'),
      { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '1': [alpha] } },
      end(1),
    ])
    writeFileSync(tree.file, `${SRC}\n// rebuilt after the run`)
    assert.throws(
      () => resolveShard(input),
      (error: unknown) => error instanceof StaleShardError && /changed since it was recorded/.test(error.message),
    )
  } finally {
    tree.cleanup()
  }
})

// `cbd-n9t.1`: the shard omits a map the file declares; the build must read the
// same comment Node would, or the script would fall back to projection.
test('a row without sourceMapURL recovers the map the file declares', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-resolve-inline-'))
  try {
    const generated = join(root, 'gen.js')
    const map = { version: 3, file: 'gen.js', sources: ['src.ts'], names: [], mappings: 'AAAA' }
    const inline = Buffer.from(JSON.stringify(map)).toString('base64')
    writeFileSync(
      generated,
      `function alpha(){return 1}\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
    )
    const stat = statSync(generated)
    const resolved = resolveShard(
      shard([
        header(),
        {
          type: 'script',
          scriptId: '1',
          url: pathToFileURL(generated).href,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
        fn(8, 20, 'alpha'),
        { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '1': [[8, 20]] } },
        end(1),
      ]),
    )
    assert.deepEqual(resolved.tests[0]?.touches, [[join(root, 'src.ts'), 'alpha@0', 1, 1]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a window naming a function with no table row is refused as inconsistent', () => {
  const tree = makeTree()
  try {
    const touch: ShardTouch = { '1': [[12345, 12399]] }
    assert.throws(
      () =>
        resolveShard(
          shard([
            header(),
            script(tree),
            { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: touch },
            end(1),
          ]),
        ),
      /no function record/,
    )
  } finally {
    tree.cleanup()
  }
})

test('a window naming a script with no table row is refused as inconsistent', () => {
  const tree = makeTree()
  try {
    assert.throws(
      () =>
        resolveShard(
          shard([
            header(),
            { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: { '9': [[0, 1]] } },
            end(1),
          ]),
        ),
      /no script record/,
    )
  } finally {
    tree.cleanup()
  }
})
