/**
 * Has work at import time. Exercises the `@load` bucket: this module evaluates
 * when first imported, which under japa is during test-file import — outside any
 * test window.
 */

const registry = new Map<string, string>()
export const loadedAt: number = Date.now()

export function register(key: string, value: string): void {
  registry.set(key, value)
}

export function lookup(key: string): string | undefined {
  return registry.get(key)
}

export function size(): number {
  return registry.size
}
