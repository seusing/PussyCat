import { rmSync } from 'node:fs'

export default async function globalTeardown() {
  const state = globalThis.__VK_E2E__
  if (!state) return
  state.host.kill('SIGTERM')
  await new Promise((resolveExit) => {
    state.host.once('exit', resolveExit)
    setTimeout(resolveExit, 5000)
  })
  state.stub.close()
  rmSync(state.home, { recursive: true, force: true })
}
