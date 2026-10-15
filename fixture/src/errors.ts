/** Classes and throw paths — a class constructor is a V8 function like any other. */

export class FixtureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixtureError'
  }
}

export function assertPositive(value: number): void {
  if (value <= 0) throw new FixtureError(`expected a positive number, got ${value}`)
}

export function safeDivide(a: number, b: number): number {
  if (b === 0) throw new FixtureError('division by zero')
  return a / b
}
