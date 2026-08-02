// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostServer } from './host-server.mjs'

const origin = 'http://127.0.0.1:5173'
const policy = { opencliVersion: '1.8.6', description: 'test', decisionByKey: new Map() }
const apps = []

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough() }
  kill() { return true }
}

async function setup({ vkRuntime, vkSidecar }) {
  const app = createHostServer({
    opencliEntry: 'C:\\fixture\\main.js', policy, allowedOrigins: [origin], vkRuntime, vkSidecar,
    runManagerOptions: { spawnImpl: () => new FakeChild() },
  })
  apps.push(app)
  const address = await app.listen({ port: 0 })
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  while (apps.length) await apps.pop().close()
})

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('runtime detect/adopt API', () => {
  it('returns candidates and stops the sidecar before atomically adopting a re-probed candidate', async () => {
    const order = []
    const candidate = {
      pythonPath: 'C:\\fixture\\venv\\Scripts\\python.exe', source: 'developer-venv',
      version: '0.1.0', apiVersion: '1.4.0', schemaVersion: '1.1.0',
      capabilities: [], compatible: true, reason: null,
    }
    const vkRuntime = {
      status: () => ({ state: 'not-installed' }),
      detect: async () => ({ candidates: [candidate] }),
      adopt: async (pythonPath, beforeActivate) => {
        order.push(`probe:${pythonPath}`)
        await beforeActivate()
        order.push('activate')
        return { state: 'installed', source: 'external', version: '0.1.0' }
      },
    }
    const vkSidecar = { stop: async () => { order.push('stop') }, health: () => ({ status: 'stopped' }) }
    const base = await setup({ vkRuntime, vkSidecar })

    const detected = await (await post(base, '/vk/v1/runtime/detect', {})).json()
    expect(detected.candidates).toEqual([candidate])
    expect(detected.checkedAt).toEqual(expect.any(String))
    const response = await post(base, '/vk/v1/runtime/adopt', { pythonPath: candidate.pythonPath })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'installed', source: 'external' })
    expect(order).toEqual([`probe:${candidate.pythonPath}`, 'stop', 'activate'])
  })
})
