import { rmSync } from 'node:fs'

export default async function globalTeardown() {
  const state = globalThis.__VK_E2E__
  if (!state) return
  state.host.kill('SIGTERM')
  await new Promise((resolveExit) => {
    state.host.once('exit', resolveExit)
    setTimeout(resolveExit, 5000)
  })
  await new Promise((resolveClose) => {
    if (!state.stub.listening) {
      resolveClose()
      return
    }
    state.stub.close(() => resolveClose())
  })
  // Windows can release SQLite handles a moment after the sidecar process exits.
  // Bounded retries keep teardown deterministic without hiding a persistent cleanup failure.
  rmSync(state.home, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}
