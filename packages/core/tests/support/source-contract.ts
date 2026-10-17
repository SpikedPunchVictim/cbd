/**
 * The properties every `Source` must have, as tests.
 *
 * Written as a function rather than as assertions inside one spec because the
 * point of `cbd-3td` is that there will be more than one implementation. The
 * in-process source satisfies this today; the out-of-process one must satisfy the
 * same suite when `cbd-a3v` lands, or the seam was not a seam.
 *
 * What is deliberately *not* here: anything about the delta property (that a
 * second take does not repeat the first). That is spike S1a and it is genuinely
 * source-specific — an in-process source sees this spec file running, a remote one
 * sees another process's code and would fail a test written that way.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import type { Source, V8ScriptCoverage } from '../../src/types.js'

export interface SourceContractOptions {
  /** What the implementation declares, so the suite can assert it is honest. */
  supportsSync: boolean
}

/** The payload shape, checked structurally — a source that returns junk must fail. */
function assertPayload(payload: V8ScriptCoverage[], label: string): void {
  assert.ok(Array.isArray(payload), `${label}: a take must resolve to an array`)
  for (const script of payload) {
    assert.equal(typeof script.scriptId, 'string', `${label}: scriptId must be a string`)
    assert.equal(typeof script.url, 'string', `${label}: url must be a string`)
    assert.ok(Array.isArray(script.functions), `${label}: functions must be an array`)
    for (const fn of script.functions) {
      assert.equal(typeof fn.functionName, 'string', `${label}: functionName must be a string`)
      assert.equal(typeof fn.isBlockCoverage, 'boolean', `${label}: isBlockCoverage must be a boolean`)
      assert.ok(
        Array.isArray(fn.ranges) && fn.ranges.length > 0,
        `${label}: a function must carry at least one range`,
      )
      for (const range of fn.ranges) {
        assert.equal(typeof range.startOffset, 'number', `${label}: startOffset must be a number`)
        assert.equal(typeof range.endOffset, 'number', `${label}: endOffset must be a number`)
        assert.equal(typeof range.count, 'number', `${label}: count must be a number`)
        assert.ok(
          range.startOffset <= range.endOffset,
          `${label}: a range must not be inverted (${range.startOffset} > ${range.endOffset})`,
        )
      }
    }
  }
}

export function sourceContract(
  name: string,
  makeSource: () => Promise<Source>,
  options: SourceContractOptions,
): void {
  test(`${name}: declares a kind`, async () => {
    const source = await makeSource()
    try {
      assert.equal(typeof source.kind, 'string')
      assert.ok(source.kind.length > 0, 'kind must not be empty — it identifies the source')
    } finally {
      source.close()
    }
  })

  test(`${name}: advertises supportsSync truthfully`, async () => {
    const source = await makeSource()
    try {
      assert.equal(source.supportsSync, options.supportsSync)
    } finally {
      source.close()
    }
  })

  // The contract's load-bearing half: `Recorder` is synchronous because japa does
  // not await its hooks, so a source that advertises sync must really be sync, and
  // one that cannot be must say so rather than returning a partial window.
  test(`${name}: takeSync does what supportsSync promises`, async () => {
    const source = await makeSource()
    try {
      if (options.supportsSync) {
        assertPayload(source.takeSync(), `${name}.takeSync`)
      } else {
        assert.throws(
          () => source.takeSync(),
          /sync/i,
          'takeSync must throw when supportsSync is false, and say why',
        )
      }
    } finally {
      source.close()
    }
  })

  test(`${name}: take resolves to a well-formed payload`, async () => {
    const source = await makeSource()
    try {
      assertPayload(await source.take(), `${name}.take`)
    } finally {
      source.close()
    }
  })

  // scriptParsed is what lets the Normalizer find source maps, so a source that
  // never populates `scripts()` cannot produce a map at all.
  test(`${name}: scripts reports what was seen, keyed by scriptId`, async () => {
    const source = await makeSource()
    try {
      assert.ok(source.scripts() instanceof Map, 'scripts must be a Map')
      await source.take()
      for (const [scriptId, info] of source.scripts()) {
        assert.equal(typeof scriptId, 'string')
        assert.equal(typeof info.url, 'string')
      }
    } finally {
      source.close()
    }
  })

  // close() runs in a `finally` next to another close, and on a path where the
  // session may already be gone. Throwing there would mask the real failure.
  test(`${name}: close is idempotent`, async () => {
    const source = await makeSource()
    source.close()
    source.close()
  })
}
