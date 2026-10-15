/**
 * `import type` is erased at compile time, so `src/types-only.ts` is never
 * loaded and never appears in a coverage payload. A change to that file is the
 * "typesonly" class: invisible to evidence, and cheap to answer for.
 */
import type { Account, Plan } from '../src/types-only.js'
import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test('type-only declarations are usable without loading the module', () => {
  const plan: Plan = 'pro'
  const account: Account = { id: 'a1', email: 'a@example.com', plan }
  assert.equal(account.plan, 'pro')
})
