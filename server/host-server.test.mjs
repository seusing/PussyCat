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

async function setup(extra = {}) {
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
    ...extra,
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

// 读满 n 条事件即返回并 cancel(模拟客户端在收到第 n 条后断线);解析 `id:` 行供补发断言用。
async function readSseEvents(response, n) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const events = []
  while (events.length < n) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let splitAt
    while (events.length < n && (splitAt = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, splitAt)
      pending = pending.slice(splitAt + 2)
      const id = block.match(/^id: (\d+)$/m)?.[1]
      const type = block.match(/^event: (.+)$/m)?.[1]
      const data = block.match(/^data: (.+)$/m)?.[1]
      if (id && type && data) {
        events.push({ id: Number(id), type, data: JSON.parse(data) })
      }
    }
  }
  await reader.cancel()
  return events
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

  it('SSE Last-Event-ID 断线中间重连:补发严格 id>Last-Event-ID、有序、无重无漏(验收条件③)', async () => {
    const { baseUrl, children } = await setup()

    // 1) 首连接先建立(live client),POST /start,FakeChild 依次 emit 3 段 stdout + close(0)
    //    → broker 依次积累 output×3 + done×1(id 1..4)。
    const firstConnection = await fetch(`${baseUrl}/events`, { headers: { Origin: origin } })
    expect(firstConnection.status).toBe(200)
    const firstEventsPromise = readSseEvents(firstConnection, 2)

    const started = await post(baseUrl, '/start', {
      runId: 'run-sse-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    })
    expect(started.status).toBe(202)

    children[0].stdout.write('{"line":1}\n')
    children[0].stdout.write('{"line":2}\n')
    children[0].stdout.write('{"line":3}\n')
    children[0].emit('close', 0, null)

    // 2) 只读前 2 个事件,记 lastId,cancel 断开(readSseEvents 内部已 cancel)。
    const firstEvents = await firstEventsPromise
    expect(firstEvents).toHaveLength(2)
    const lastId = firstEvents[firstEvents.length - 1].id

    // 3) 带 Last-Event-ID 重连 → 补发剩余事件,读到 done 为止(剩余恰好 2 条:output seq2 + done)。
    const reconnect = await fetch(`${baseUrl}/events`, {
      headers: { Origin: origin, 'Last-Event-ID': String(lastId) },
    })
    expect(reconnect.status).toBe(200)
    const resent = await readSseEvents(reconnect, 2)
    expect(resent[resent.length - 1].type).toBe('done')          // 确实读到了 done

    // 4) 断言:补发全部 id > lastId;id 严格递增;断前 2 条 ∪ 补发 = 完整全集,无重无漏。
    for (const event of resent) expect(event.id).toBeGreaterThan(lastId)
    for (let i = 1; i < resent.length; i += 1) expect(resent[i].id).toBeGreaterThan(resent[i - 1].id)
    const allIds = [...firstEvents, ...resent].map((event) => event.id).sort((a, b) => a - b)
    expect(new Set(allIds).size).toBe(allIds.length)              // 无重
    expect(allIds).toEqual([1, 2, 3, 4])                          // 无漏,完整全集(3 output + 1 done)
  })
})

describe('GET /catalog + 动态 policy', () => {
  function stubCatalogService() {
    const snapshot = {
      schemaVersion: 1, generatedAt: 123, opencliVersion: '9.9.9',
      source: 'live: opencli list -f json', listSha256: 'x', manifestSha256: 'y',
      commands: [
        { command: 'newsite/hello', site: 'newsite', name: 'hello', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
      ],
    }
    const policy = {
      opencliVersion: '9.9.9',
      description: 'refreshed',
      allowedCommands: new Set(['newsite/hello']),
    }
    let state
    return {
      snapshot,
      refresh: async () => { state = { snapshot, policy }; return snapshot },
      current: () => state,
      close: () => {},
    }
  }

  it('刷新前旧 policy 拒绝新命令;刷新后放行、旧命令 403(漂移闭环)', async () => {
    const service = stubCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const startNew = () => post(baseUrl, '/start', {
      runId: 'r-new-1', commandKey: 'newsite/hello', argv: ['newsite', 'hello', '-f', 'json'],
    })
    const startOld = () => post(baseUrl, '/start', {
      runId: 'r-old-1', commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'],
    })
    expect((await startNew()).status).toBe(403)               // 刷新前:初始 policy 无 newsite/hello
    const refreshed = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json()).commands[0].command).toBe('newsite/hello')
    expect((await startNew()).status).toBe(202)               // 刷新后:动态 policy 放行
    expect((await startOld()).status).toBe(403)               // 已删命令被拒
  })

  it('刷新失败 → 透传 CatalogServiceError.statusCode,不改 policy', async () => {
    const service = {
      refresh: async () => { const e = new Error('timed out'); e.statusCode = 504; e.name = 'CatalogServiceError'; throw e },
      current: () => undefined,
      close: () => {},
    }
    const { baseUrl } = await setup({ catalogService: service })
    const res = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.summary).toMatch(/timed out/)
    // 原 policy 未被破坏:白名单内命令仍可 start
    expect((await post(baseUrl, '/start', { runId: 'r-ok-1', commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'] })).status).toBe(202)
  })

  it('未配置 catalogService → GET /catalog 404', async () => {
    const { baseUrl } = await setup()
    const res = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    expect(res.status).toBe(404)
  })
})
