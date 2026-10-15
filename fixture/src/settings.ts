/**
 * Reads a JSON file with `fs`. V8 never sees the JSON, so a change to
 * `data/settings.json` is invisible to the coverage map — this is the "data"
 * class that amendment 4's path-convention owners exist to resolve.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findPackageRoot } from './paths.js'

export interface Settings {
  name: string
  retries: number
  features: string[]
}

export function settingsPath(): string {
  return join(findPackageRoot(), 'data', 'settings.json')
}

export function loadSettings(): Settings {
  const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
  return {
    name: parsed.name ?? 'unnamed',
    retries: parsed.retries ?? 0,
    features: parsed.features ?? [],
  }
}

export function hasFeature(feature: string): boolean {
  return loadSettings().features.includes(feature)
}
