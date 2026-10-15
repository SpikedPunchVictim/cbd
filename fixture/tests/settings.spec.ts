/**
 * Depends on `data/settings.json`, which V8 cannot see. A change to that JSON
 * is invisible to the coverage map, so this test is reachable only through a
 * path convention (amendment 4) — not through evidence.
 */
import { test } from '@japa/runner'
import { hasFeature, loadSettings, settingsPath } from '../src/settings.js'
import { expectDeepEqual, expectEqual } from './support/harness.js'

test('loadSettings reads the JSON fixture', () => {
  const settings = loadSettings()
  expectEqual(settings.name, 'cbd-fixture', 'settings.name')
  expectEqual(settings.retries, 3, 'settings.retries')
})

test('hasFeature reports membership', () => {
  expectEqual(hasFeature('selection'), true, 'hasFeature(selection)')
  expectEqual(hasFeature('telepathy'), false, 'hasFeature(telepathy)')
})

test('settingsPath points at the data directory', () => {
  const path = settingsPath()
  expectDeepEqual(path.endsWith('data/settings.json'), true, 'settingsPath suffix')
})
