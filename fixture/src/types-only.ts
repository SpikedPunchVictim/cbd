/**
 * Type-only module. Emits no runtime code, and `import type` erases the import
 * entirely — so V8 never loads it. This is the "typesonly" class from the
 * measurement, and the reason a `.ts` change must not automatically mean
 * `mode: all`.
 */

export interface Account {
  id: string
  email: string
  plan: Plan
}

export type Plan = 'free' | 'pro' | 'enterprise'

export type AccountMap = Record<string, Account>

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }
