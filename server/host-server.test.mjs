// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fetch as realFetch } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostServer } from './host-server.mjs'

const origin = 'http://127.0.0.1:5173'
const policy = {
  opencliVersion: '1.8.6',
  description: 'test public read policy',
  allowedCommands: new Set(['36kr/news']),
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill() {
    return true
  }
}

const openApps = new Set()

beforeEach(() => {
  vi.stubGlobal('fetch', realFetch)
})

async function setup() {
  const children = []
  const app = createHostServer({
    opencliEntry: 'C:\\fixture\\dist\\src\\main.js',
    policy,
    allowedOrigins: [origin],
    runManagerOptions: {
      spawnImpl: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      commandTimeoutMs: 60_000,
    },
  })
  openApps.add(app)
  const address = await app.listen({ port: 0 })
  return { app, children, baseUrl: `http://127.0.0.1:${address.port}` }
}

afterEach(async () => {
  await Promise.all([...openApps].map(async (app) => {
    openApps.delete(app)
    await app.close()
  }))
})

function post(baseUrl, path, body, requestOrigin = origin) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readSseUntilDone(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const events = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) return events
    pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let splitAt
    while ((splitAt = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, splitAt)
      pending = pending.slice(splitAt + 2)
      const type = block.match(/^event: (.+)$/m)?.[1]
      const data = block.match(/^data: (.+)$/m)?.[1]
      if (type && data) {
        events.push({ type, data: JSON.parse(data) })
        if (type === 'done') {
          await reader.cancel()
          return events
        }
      }
    }
  }
}

describe('Node Host HTTP/SSE', () => {
  it('reports health and rejects disallowed origins', async () => {
    const { baseUrl } = await setup()
    const health = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: 'ok',
      opencliVersion: '1.8.6',
      executionPolicy: 'test public read policy',
    })

    const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } })
    expect(denied.status).toBe(403)
  })

  it('streams output/done over SSE for an accepted start', async () => {
    const { baseUrl, children } = await setup()
    const eventResponse = await fetch(`${baseUrl}/events`, { headers: { Origin: origin } })
    expect(eventResponse.status).toBe(200)
    const eventsPromise = readSseUntilDone(eventResponse)

    const started = await post(baseUrl, '/start', {
      runId: 'run-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toEqual({ runId: 'run-1' })

    children[0].stdout.write('[{"rank":1,"title":"A"}]\n')
    children[0].emit('close', 0, null)
    const events = await eventsPromise
    expect(events.map((event) => event.type)).toEqual(['output', 'done'])
    expect(events[0].data).toMatchObject({ runId: 'run-1', seq: 0, stream: 'stdout' })
    expect(events[1].data).toMatchObject({
      runId: 'run-1',
      outcome: 'success',
      result: [{ rank: 1, title: 'A' }],
    })
  })

  it('rejects unsafe/malformed starts and duplicate run ids', async () => {
    const { baseUrl } = await setup()
    const unsafe = await post(baseUrl, '/start', {
      runId: 'run-1',
      commandKey: '12306/login',
      argv: ['12306', 'login', '-f', 'json'],
    })
    expect(unsafe.status).toBe(403)

    const mismatch = await post(baseUrl, '/start', {
      runId: 'run-2',
      commandKey: '36kr/news',
      argv: ['bbc', 'news', '-f', 'json'],
    })
    expect(mismatch.status).toBe(400)

    const body = {
      runId: 'run-3',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    }
    expect((await post(baseUrl, '/start', body)).status).toBe(202)
    expect((await post(baseUrl, '/start', body)).status).toBe(409)
  })

  it('requires JSON content type and makes cancel idempotent', async () => {
    const { baseUrl } = await setup()
    const wrongType = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(wrongType.status).toBe(415)
    expect((await post(baseUrl, '/cancel', { runId: 'not-running' })).status).toBe(204)
    expect((await post(baseUrl, '/cancel', { runId: 'not-running' })).status).toBe(204)
  })
})
