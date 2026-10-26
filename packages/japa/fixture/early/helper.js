// Imported by the runner entry before the plugin installs, the way a shared
// test-kit or config module is. It exists only to be recorded (or not).
export function earlyHelper() {
  return 'early'
}

export const early = earlyHelper()
