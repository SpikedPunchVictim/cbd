/**
 * The adapter contract's identity rules.
 *
 * The id is what a selection file carries and what every later artefact names a
 * test by. The test that matters is that it does *not* change when code above the
 * test moves: the definition site is reported, but it is not identity.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import {
  ADAPTER_CONTRACT_VERSION,
  testId,
  testRef,
  titlePartReadings,
} from '../src/contract.js'

test.group('adapter contract', () => {
  test('the id is the file and the title, with no definition site', () => {
    assert.equal(testId('packages/core/tests/a.spec.ts', 'adds'), 'packages/core/tests/a.spec.ts::adds')
    assert.equal(testId(null, 'adds'), '::adds')
    assert.notEqual(testId('a.spec.ts', 'adds'), testId('b.spec.ts', 'adds'))
  })

  test('a ref fills only the optional parts the adapter reported', () => {
    assert.deepEqual(testRef('a.spec.ts', 'adds'), {
      id: 'a.spec.ts::adds',
      file: 'a.spec.ts',
      title: 'adds',
    })
    assert.deepEqual(
      testRef('a.spec.ts', 'adds', { titlePath: ['group', 'adds'], line: 12, column: 3 }),
      {
        id: 'a.spec.ts::adds',
        file: 'a.spec.ts',
        title: 'adds',
        titlePath: ['group', 'adds'],
        line: 12,
        column: 3,
      },
    )
  })

  test('the contract is versioned separately from the package', () => {
    assert.equal(ADAPTER_CONTRACT_VERSION, 1)
  })

  // The stored title does not say which ` > ` occurrences were separators, and a
  // title may itself contain one. A runner-facing pattern needs every reading.
  test('a stored title yields every reading of its parts', () => {
    assert.deepEqual(titlePartReadings('adds'), [['adds']])
    assert.deepEqual(titlePartReadings('outer > adds'), [
      ['outer > adds'],
      ['outer', 'adds'],
    ])
    assert.deepEqual(titlePartReadings('outer > a > b'), [
      ['outer > a > b'],
      ['outer', 'a > b'],
      ['outer > a', 'b'],
      ['outer', 'a', 'b'],
    ])
    // 2^9 readings is 512; past the cap the one-part and the plain split remain.
    const stored = Array.from({ length: 11 }, (_, i) => `p${i}`).join(' > ')
    const many = titlePartReadings(stored)
    assert.equal(many.length, 2)
    assert.deepEqual(many[0], [stored])
    assert.equal(many[1]?.length, 11)
  })
})
