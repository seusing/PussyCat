// @vitest-environment node
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fetch as realFetch } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostServer } from './host-server.mjs'
import { createCatalogService } from './catalog-service.mjs'
import { buildExecutionPolicy, loadExecutionPolicy } from './policy.mjs'
import { canonicalJson } from './policy-fingerprint.mjs'
import { createWrssIntegration } from './wrss-integration.mjs'

const origin = 'http://127.0.0.1:5173'
// Task 6 起 `/start` 读的是 **decisionByKey**,不再是 allowedCommands。
// 夹具随之改形:allowedCommands 已被移除而非并存 —— 留着它,哪天有人把
// validateStartRequest 退回读 allowedCommands,本文件全部 /start 用例仍会绿。
// 现在退回去 = decision 恒 undefined = 全部 403,当场红。
const policy = {
  opencliVersion: '1.8.6',
  description: 'test public read policy',
  decisionByKey: new Map([
    ['36kr/news', { commandKey: '36kr/news', state: 'ready', decisionSource: 'legacy-baseline' }],
  ]),
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

describe('WeRSS loopback integration routes', () => {
  it('returns saved/tested state through exact Host routes', async () => {
    const wrssIntegration = createWrssIntegration({
      fetchImpl: async () => ({ status: 200, body: null }),
    })
    const { baseUrl } = await setup({ wrssIntegration })

    const saved = await post(baseUrl, '/vk/v1/integrations/wrss/config', {
      base_url: 'http://127.0.0.1:8001',
    })
    expect(saved.status).toBe(200)
    await expect(saved.json()).resolves.toMatchObject({ configured: true, state: 'saved' })

    const tested = await post(baseUrl, '/vk/v1/integrations/wrss/test', {})
    expect(tested.status).toBe(200)
    await expect(tested.json()).resolves.toMatchObject({
      configured: true, state: 'reachable', status_code: 200, protocol_verified: false,
    })

    const status = await fetch(`${baseUrl}/vk/v1/integrations/wrss`, { headers: { Origin: origin } })
    await expect(status.json()).resolves.toMatchObject({ state: 'reachable' })
  })

  it('rejects remote and credential-bearing WeRSS URLs', async () => {
    const { baseUrl } = await setup({ wrssIntegration: createWrssIntegration() })
    for (const value of ['https://example.com', 'http://user:pass@127.0.0.1:8001']) {
      const response = await post(baseUrl, '/vk/v1/integrations/wrss/config', { base_url: value })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ reasonCode: 'invalid-url' })
    }
  })
})

describe('managed WeRSS runtime route', () => {
  it('forwards only fixed WeRSS API routes and preserves binary response metadata', async () => {
    const calls = []
    const runtime = {
      status: () => ({ state: 'running' }),
      requestApi: async (path, init) => {
        calls.push({ path, init })
        return new Response(path.includes('download') ? 'file' : JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: path.includes('download') ? { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="x.txt"' } : { 'Content-Type': 'application/json' },
        })
      },
      close: async () => {},
    }
    const { baseUrl } = await setup({ wrssRuntime: runtime })
    const listed = await fetch(`${baseUrl}/wrss/api/articles?offset=0&limit=10`, { headers: { Origin: origin } })
    expect(listed.status).toBe(200)
    expect(calls[0].path).toBe('/api/v1/wx/articles?offset=0&limit=10')
    const refreshTask = await fetch(`${baseUrl}/wrss/api/articles/refresh/tasks/task-1`, { headers: { Origin: origin } })
    expect(refreshTask.status).toBe(200)
    expect(calls.at(-1).path).toBe('/api/v1/wx/articles/refresh/tasks/task-1')
    const blocked = await fetch(`${baseUrl}/wrss/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
    expect(blocked.status).toBe(404)
    const preflight = await fetch(`${baseUrl}/wrss/api/articles/1/favorite`, { method: 'OPTIONS', headers: { Origin: origin } })
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
    const download = await fetch(`${baseUrl}/wrss/api/tools/export/download?filename=x.txt`, { headers: { Origin: origin } })
    expect(download.headers.get('content-disposition')).toContain('x.txt')
  })

  it('serves source avatars and allowlisted article images through dedicated runtime methods',async()=>{
    const runtime={status:()=>({state:'running'}),requestSourceAvatar:vi.fn(async()=>new Response('avatar',{status:200,headers:{'content-type':'image/png'}})),requestArticleImage:vi.fn(async()=>new Response('article',{status:200,headers:{'content-type':'image/jpeg'}})),close:async()=>{}}
    const {baseUrl}=await setup({wrssRuntime:runtime})
    const avatar=await fetch(`${baseUrl}/wrss/source-avatar/source-1`,{headers:{Origin:origin}})
    expect(await avatar.text()).toBe('avatar');expect(runtime.requestSourceAvatar).toHaveBeenCalledWith('source-1')
    const image=await fetch(`${baseUrl}/wrss/article-image?url=${encodeURIComponent('https://mmbiz.qpic.cn/a.jpg')}`,{headers:{Origin:origin}})
    expect(await image.text()).toBe('article');expect(runtime.requestArticleImage).toHaveBeenCalledWith('https://mmbiz.qpic.cn/a.jpg')
  })

  it('returns 202 immediately and closes the runtime on Host shutdown', async () => {
    let enabled = 0
    let closed = 0
    const runtime = {
      enable: async () => { enabled += 1 },
      status: () => ({ state: 'installing', summary: 'installing', reason_code: null, progress_log: [], version: null, size_label: '约 356 MB（按需下载）', checked_at: new Date().toISOString() }),
      close: async () => { closed += 1 },
    }
    const { app, baseUrl } = await setup({ wrssRuntime: runtime })
    const response = await post(baseUrl, '/vk/v1/integrations/wrss/enable', {})
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ state: 'installing' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(enabled).toBe(1)
    await app.close()
    expect(closed).toBe(1)
  })
})

describe('video-knowledge runtime lifecycle routes', () => {
  it('lists versions, switches active before stopping the sidecar, and cleans stale versions', async () => {
    const events = []
    const versionResult = {
      versions: [{ version: 'v2', active: true, removable: false, sizeBytes: 10 }],
      reclaimableBytes: 20,
      checkedAt: '2026-08-14T00:00:00Z',
    }
    const runtime = {
      versions: () => versionResult,
      rollback: async (version, { afterActivate }) => {
        events.push(`active:${version}`)
        await afterActivate()
        return { state: 'installed', version }
      },
      cleanup: () => ({ ...versionResult, removed: [{ version: 'v1', sizeBytes: 20 }], reclaimedBytes: 20 }),
    }
    const sidecar = { stop: async () => { events.push('sidecar:stop') } }
    const { baseUrl } = await setup({ vkRuntime: runtime, vkSidecar: sidecar })

    const listed = await fetch(`${baseUrl}/vk/v1/runtime/versions`, { headers: { Origin: origin } })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject(versionResult)

    const rolledBack = await post(baseUrl, '/vk/v1/runtime/rollback', { version: 'v1' })
    expect(rolledBack.status).toBe(200)
    await expect(rolledBack.json()).resolves.toMatchObject({ state: 'installed', version: 'v1' })
    expect(events).toEqual(['active:v1', 'sidecar:stop'])

    const cleaned = await post(baseUrl, '/vk/v1/runtime/cleanup', {})
    expect(cleaned.status).toBe(200)
    await expect(cleaned.json()).resolves.toMatchObject({ reclaimedBytes: 20 })
  })

  it('stops an already-running sidecar after a normal install activates its runtime', async () => {
    const events = []
    let finishInstall
    const installed = new Promise((resolveInstalled) => { finishInstall = resolveInstalled })
    const runtime = {
      status: () => ({ state: 'not-installed', reasonCode: null, summary: 'pending' }),
      install: async ({ afterActivate }) => {
        events.push('active:new')
        await afterActivate()
        finishInstall()
      },
    }
    const sidecar = { stop: async () => { events.push('sidecar:stop') } }
    const { baseUrl } = await setup({ vkRuntime: runtime, vkSidecar: sidecar })

    const response = await post(baseUrl, '/vk/v1/runtime/install', {})
    expect(response.status).toBe(202)
    await installed
    expect(events).toEqual(['active:new', 'sidecar:stop'])
  })
})

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
// id 行可选(扩展支持 gap 帧——按 SSE 规范无 id 行是合法的,故只要求 event:+data: 齐全即计数)。
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
      if (type && data) {
        events.push({ id: id ? Number(id) : undefined, type, data: JSON.parse(data), raw: block })
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

  it('SSE 重启补发:gap 之后必须补发新进程已缓存的全部事件(评审 P1——旧实现全过滤掉)', async () => {
    // restart 成立时恒有 event.id <= nextId-1 <= lastId,若回放仍只发 event.id > lastId,
    // 新进程已缓存的 output/done 会被全部过滤 → 客户端只拿到 gap、丢光真数据。
    // 上一条空缓冲用例按构造覆盖不到这条主路径(我的测试设计缺陷),故本用例先造非空缓冲。
    const { baseUrl, children } = await setup()
    const started = await post(baseUrl, '/start', {
      runId: 'run-restart-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    })
    expect(started.status).toBe(202)
    children[0].stdout.write('{"line":1}\n')
    children[0].emit('close', 0, null)                 // 缓冲:output(id1) + done(id2),nextId=3

    const reconnect = await fetch(`${baseUrl}/events`, {
      headers: { Origin: origin, 'Last-Event-ID': '99' },   // 旧进程游标,远超新 nextId
    })
    expect(reconnect.status).toBe(200)
    const events = await readSseEvents(reconnect, 3)
    expect(events[0].type).toBe('gap')
    expect(events[0].data).toMatchObject({ reason: 'restart' })
    // 关键:gap 之后补发新进程的全部缓存事件,而非一条不发
    expect(events.slice(1).map((e) => e.type)).toEqual(['output', 'done'])
    expect(events[1].id).toBe(1)
    expect(events[2].id).toBe(2)
  })

  it('SSE 补发缺口:服务端重启(客户端游标超前)同样告知 reason=restart(评审 I-3)', async () => {
    // 新 server 的 nextId=1;客户端带着上个进程的 Last-Event-ID 重连 → 游标超前 = 重启丢段。
    // 原实现只查「驱逐」(需 events 非空),这一支会静默漏报——而重启恰是生产里最常见的丢段场景。
    const { baseUrl } = await setup()
    const reconnect = await fetch(`${baseUrl}/events`, {
      headers: { Origin: origin, 'Last-Event-ID': '99' },
    })
    expect(reconnect.status).toBe(200)
    const events = await readSseEvents(reconnect, 1)
    expect(events[0].type).toBe('gap')
    expect(events[0].data).toEqual({ reason: 'restart', from: 1, to: null })
    expect(events[0].id).toBeUndefined()               // 同样不带 id,不打乱续传游标
    expect(events[0].raw).not.toMatch(/^id: /m)
  })

  it('SSE 补发缺口:被驱逐的事件段以 gap 事件显式告知(不再静默丢失)', async () => {
    // bufferSize=2:一个 run 产生 4 个事件(3 output + 1 done,id 1..4)后,环形缓冲只剩最后 2 个(id 3,4);
    // id 1、2 已被驱逐——重连时若不显式告知,客户端将静默漏收这段。
    const { baseUrl, children } = await setup({ sseOptions: { bufferSize: 2 } })

    const started = await post(baseUrl, '/start', {
      runId: 'run-gap-1',
      commandKey: '36kr/news',
      argv: ['36kr', 'news', '-f', 'json'],
    })
    expect(started.status).toBe(202)

    children[0].stdout.write('{"line":1}\n')
    children[0].stdout.write('{"line":2}\n')
    children[0].stdout.write('{"line":3}\n')
    children[0].emit('close', 0, null)

    const reconnect = await fetch(`${baseUrl}/events`, {
      headers: { Origin: origin, 'Last-Event-ID': '1' },
    })
    expect(reconnect.status).toBe(200)
    const events = await readSseEvents(reconnect, 3)   // gap + 补发 output(id3) + done(id4)

    // ① gap 事件正确:from===lastId+1(=2),to===缓冲最老 id-1(缓冲最老为 id3,故 to=2)
    expect(events[0].type).toBe('gap')
    expect(events[0].data).toEqual({ reason: 'evicted', from: 2, to: 2 })
    // ② gap 帧不含 id: 行(不打乱续传游标)
    expect(events[0].id).toBeUndefined()
    expect(events[0].raw).not.toMatch(/^id: /m)

    // ③ 补发事件 id 均严格 > lastId(=1) 且严格递增
    const resent = events.slice(1)
    expect(resent.map((e) => e.type)).toEqual(['output', 'done'])
    for (const event of resent) expect(event.id).toBeGreaterThan(1)
    for (let i = 1; i < resent.length; i += 1) expect(resent[i].id).toBeGreaterThan(resent[i - 1].id)
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
      decisionByKey: new Map([
        ['newsite/hello', { commandKey: 'newsite/hello', state: 'ready', decisionSource: 'legacy-baseline' }],
      ]),
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

describe('/catalog/effective', () => {
  // 用**真的** createCatalogService,不是 stub —— revision 的三条性质全部由
  // catalog-service.mjs 里那段摘要实现承担;换成 stub,Step 5.5 的三处变异一条都红不了,
  // 这一整个 describe 就退化成在测夹具自己。
  function liveCatalogService() {
    const commands = [
      { command: 'a/one', site: 'a', name: 'one', description: 'first', access: 'read', strategy: 'public', browser: false, args: [] },
      { command: 'a/two', site: 'a', name: 'two', description: 'second', access: 'read', strategy: 'public', browser: false, args: [] },
    ]
    const manifest = JSON.stringify([
      { site: 'a', name: 'one', type: 'json' },
      { site: 'a', name: 'two', type: 'json' },
    ])
    let list = commands
    // 单调计数时钟:`Date.now()` 的毫秒分辨率会让「快照变 → generatedAt 也变」
    // 偶然假绿(两次 refresh 落在同一毫秒)。注入自增时钟后两条时刻断言都是确定性的。
    let tick = 0
    const service = createCatalogService({
      opencliEntry: 'C:/fixture/dist/src/main.js',
      resolveManifest: () => 'C:/fixture/cli-manifest.json',
      now: () => { tick += 1; return tick },
      spawnImpl: () => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        // 自驱夹具:catalog-service 在 spawnImpl 返回后**同步**挂完 data/close 监听,
        // setImmediate 晚于当前宏任务,故喂数据时监听一定已就位。
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify(list)))
          child.emit('close', 0)
        })
        return child
      },
      readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"9.9.9"}' : manifest),
    })
    return {
      service,
      // 让下一次 refresh 吐出**条数相同、内容不同**的 catalog。
      // 条数必须相同:否则 revision 摘要里把 commands 换回 commands.length 也照样变,
      // Step 5.5 的变异③ 就什么都测不出来。
      // 只改 description:它不进 reviewShapeHash,故 decisions 逐字节不变——
      // 「快照变 → revision 必变」于是只可能由 commands **全文**那一项撑住。
      mutate() { list = commands.map((c) => ({ ...c, description: `${c.description}-CHANGED` })) },
    }
  }

  const effective = (baseUrl, refresh = false) => fetch(
    `${baseUrl}/catalog/effective${refresh ? '?refresh=1' : ''}`,
    { headers: { Origin: origin } },
  )

  it('已有打包 seed 时首屏不刷新，显式 refresh=1 才刷新', async () => {
    const snapshot = {
      schemaVersion: 1, generatedAt: 1, opencliVersion: '9.9.9', source: 'bundled',
      listSha256: 'x', manifestSha256: 'y', commands: [],
    }
    const policy = {
      opencliVersion: '9.9.9', description: 'seeded', decisions: [],
      decisionByKey: new Map(), allowedCommands: new Set(), deniedCommands: new Map(),
    }
    const state = { revision: 'seed-revision', snapshot, policy, generatedAt: 1 }
    let refreshCalls = 0
    const service = {
      current: () => state,
      refresh: async () => { refreshCalls += 1; return snapshot },
      close: () => {},
    }
    const { baseUrl } = await setup({ catalogService: service })
    expect((await effective(baseUrl)).status).toBe(200)
    expect(refreshCalls).toBe(0)
    expect((await effective(baseUrl, true)).status).toBe(200)
    expect(refreshCalls).toBe(1)
  })

  it('返回 envelope,snapshot 与 decisions 共享同一 revision', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const res = await effective(baseUrl)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.revision).toBe('string')
    expect(body.revision.length).toBeGreaterThan(0)
    expect(Array.isArray(body.snapshot.commands)).toBe(true)
    expect(body.policy.schemaVersion).toBe(1)
    expect(body.policy.decisions.length).toBe(body.snapshot.commands.length)
  })

  // 上面那条**证明不了 revision 有任何用处** —— 服务端返回常量 'x' 也能全绿。
  // I-P4 说的「在 wire 上可验」只有一个意思:客户端拿 envelope 能自己算出同一个值。
  // 下面三条才是 revision 存在的理由。
  it('客户端可从 envelope 自行重算出同一 revision(这才是 I-P4 的「可验」)', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const body = await (await effective(baseUrl)).json()
    const recomputed = createHash('sha256').update(canonicalJson({
      policySchemaVersion: body.policy.schemaVersion,
      opencliVersion: body.snapshot.opencliVersion,
      commands: body.snapshot.commands,
      decisions: body.policy.decisions,
    })).digest('hex').slice(0, 16)
    expect(recomputed).toBe(body.revision)
  })

  it('内容未变 → 两次请求 revision 相同(掺时间戳就做不到这条)', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const a = await (await effective(baseUrl)).json()
    const b = await (await effective(baseUrl, true)).json()
    expect(b.revision).toBe(a.revision)
  })

  // generatedAt 说的是「**这份判决**何时生成」。端点每次请求都无条件 refresh(),
  // state 每请求重建一次 —— 光把 generatedAt 存进 state 挡不住它每次变。
  // 没有这条守卫,把它写回 `now()` / `Date.now()` 全仓依然全绿(评审实测)。
  it('内容未变 → generatedAt 也必须相同(存进 state 还不够,得沿用旧时刻)', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const a = await (await effective(baseUrl)).json()
    const b = await (await effective(baseUrl, true)).json()
    expect(typeof a.policy.generatedAt).toBe('number')
    expect(b.policy.generatedAt).toBe(a.policy.generatedAt)
  })

  // 内容真变了就该换时刻 —— 否则上一条可以靠「永远返回同一个常量」平凡满足。
  it('快照变 → generatedAt 随之更新(反向控制,挡住「恒定常量」的平凡解)', async () => {
    const { service, mutate } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const before = await (await effective(baseUrl)).json()
    mutate()
    const after = await (await effective(baseUrl, true)).json()
    expect(after.revision).not.toBe(before.revision)
    expect(after.policy.generatedAt).not.toBe(before.policy.generatedAt)
  })

  it('快照变 → revision 必变(否则它挡不住「换了目录却说还是同一份」)', async () => {
    const { service, mutate } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const before = await (await effective(baseUrl)).json()
    mutate()
    const after = await (await effective(baseUrl, true)).json()
    // 先证明这确实是一次真变异,**且条数没变** —— 否则下面那条不等式可能只是
    // 「条数变了」撑起来的,摘要里取全文还是取 length 就无从区分。
    expect(after.snapshot.commands).toHaveLength(before.snapshot.commands.length)
    expect(after.snapshot.commands).not.toEqual(before.snapshot.commands)
    expect(after.revision).not.toBe(before.revision)
  })

  it('/catalog 原形状不变 —— 既有前端契约不破', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const res = await fetch(`${baseUrl}/catalog`, { headers: { Origin: origin } })
    const body = await res.json()
    expect(Array.isArray(body.commands)).toBe(true)
    expect(body.policy).toBeUndefined()      // 原端点不得混入 policy
    expect(body.decisions).toBeUndefined()
  })

  // 下面两条与上面 `GET /catalog` 那两条**同构**。新端点的 404 分支与整个 catch 块
  // 是从 /catalog 复制来的,而复制来的那份此前一条测试都没有 —— 实测三处变异
  // (404 改 200、catch 改恒 200、generatedAt 改 Date.now())全仓 332 条全绿逃逸。
  it('未配置 catalogService → GET /catalog/effective 404', async () => {
    const { baseUrl } = await setup()
    const res = await effective(baseUrl)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not enabled/i)
  })

  it('刷新失败 → 透传 CatalogServiceError.statusCode,不下发任何 envelope', async () => {
    const service = {
      refresh: async () => { const e = new Error('timed out'); e.statusCode = 504; e.name = 'CatalogServiceError'; throw e },
      current: () => undefined,
      close: () => {},
    }
    const { baseUrl } = await setup({ catalogService: service })
    const res = await effective(baseUrl)
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.summary).toMatch(/timed out/)
    // 失败时不得混出半份 envelope —— 否则前端可能拿着 undefined revision 往下走
    expect(body.revision).toBeUndefined()
    expect(body.policy).toBeUndefined()
  })
})

// spec §10.1 第 11 道门:状态码表**逐格**。
//
// 为什么单元层不够:policy.test.mjs 那七条全是直接调 validateStartRequest 的单元测试,
// **碰不到 host-server.mjs catch 分支里那行 reasonCode 序列化** —— 把那行整行删掉,
// 单元层七条照样全绿。reasonCode 是 wire 上的稳定标识(spec §6.1),前端业务逻辑只认它,
// 所以它必须在**HTTP 响应体**这一层被守住,而不只是在异常对象的属性上。
//
// 夹具坑,先看清再改:本文件顶部那个 policy 夹具是手捏的,造不出 acknowledgement-required;
// 而 reviewShapeHash 含 opencliVersion(spec §4.1.2),任何非 1.8.6 的合成快照都会让
// 全部 legacy 条目集体漂出基线 → 每条命令都落 unknown/no-tier,428/409 根本不可达。
// 故本节用**真快照**构造 policy 直接注入:不挂 catalogService,activePolicy() 自然回落到它。
describe('/start 状态码表逐格(HTTP 层)', () => {
  const realPolicy = loadExecutionPolicy(resolve('public/catalog.snapshot.json'))

  // 先钉住前提:四个格子各自可达。少了这条,快照一漂移就分不清是「分派错了」
  // 还是「这条命令压根不是那个状态」——两者的红长得一样,但修法完全不同。
  it('夹具前提:注入的是真判决,四种 state 各有一条命令承载', () => {
    expect(realPolicy.decisionByKey.get('trae-cn/setup').state).toBe('ready')
    expect(realPolicy.decisionByKey.get('antigravity/recent-paths').state).toBe('acknowledgement-required')
    expect(realPolicy.decisionByKey.get('paperreview/review').state).toBe('denied')
    expect(realPolicy.decisionByKey.get('trae-solo/state-get').state).toBe('unknown')
  })

  it('202:ready 的命令直接受理', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-ready-1', commandKey: 'trae-cn/setup', argv: ['trae-cn', 'setup', '-f', 'json'],
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ runId: 'r-ready-1' })
  })

  it('428:需确认却未带 acknowledgement', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-ack-1', commandKey: 'antigravity/recent-paths',
      argv: ['antigravity', 'recent-paths', '-f', 'json'],
    })
    expect(res.status).toBe(428)
    expect((await res.json()).reasonCode).toBe('acknowledgement-required')
  })

  it('409:fingerprint 陈旧', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-stale-1', commandKey: 'antigravity/recent-paths',
      argv: ['antigravity', 'recent-paths', '-f', 'json'],
      acknowledgement: { fingerprint: 'stale' },
    })
    expect(res.status).toBe(409)
    // 409 与 RunManager 的「runId 重复」撞码 —— 只断状态码分不开,必须断 reasonCode。
    expect((await res.json()).reasonCode).toBe('fingerprint-stale')
  })

  it('403(denied):显式 deny', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-deny-1', commandKey: 'paperreview/review',
      argv: ['paperreview', 'review', 'tok', '-f', 'json'],
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reasonCode).toBe('explicit-deny')
  })

  it('403(unknown):未审定 —— 与 denied 同码,靠 reasonCode 区分', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-unknown-1', commandKey: 'trae-solo/state-get',
      argv: ['trae-solo', 'state-get', '-f', 'json'],
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reasonCode).toBe('metadata-missing')
  })

  it('400:结构非法,不被判决分派吞掉', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-bad-1', commandKey: 'trae-cn/setup', argv: 'not-an-array',
    })
    expect(res.status).toBe(400)
    // 结构错误没有 reasonCode:那行序列化是**条件**的,不是无条件塞一个字段。
    expect((await res.json()).reasonCode).toBeUndefined()
  })

  // ——— I-P5:acknowledgement 不是安全授权 ————————————————————————
  // 带一个**看似合法**的 fingerprint 不得把 denied/unknown 送进执行面。
  // 借的是 antigravity/recent-paths 那条判决的**真** fingerprint(只是属于另一条命令),
  // 比随手编一个 hex 串更接近真实误用形态。
  //
  // **这两条是行为固定,不是可变异守卫。** 该性质由算法结构保证而非分支顺序:
  // denied/unknown 在第 1/3/4/5/6/7 步就 return,**早于第 8 步的 fingerprint 计算**,
  // 那些判决对象上根本没有 fingerprint 字段(下面第一条断言把这点钉住),
  // 任何供给值都不可能匹配。写下来是防止未来重构把它改掉,不是为了凑一处变异。
  const borrowedFingerprint = () => realPolicy.decisionByKey.get('antigravity/recent-paths').fingerprint

  it('denied/unknown 的判决根本没有 fingerprint 字段 —— 无从匹配,这才是结构性保证', () => {
    expect(realPolicy.decisionByKey.get('paperreview/review').fingerprint).toBeUndefined()
    expect(realPolicy.decisionByKey.get('trae-solo/state-get').fingerprint).toBeUndefined()
    // 对照:需确认的那条才有,证明上面两个 undefined 不是「本来就没人有」。
    expect(typeof borrowedFingerprint()).toBe('string')
  })

  it('403(denied):带看似合法的 fingerprint 也救不回来', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-deny-ack-1', commandKey: 'paperreview/review',
      argv: ['paperreview', 'review', 'tok', '-f', 'json'],
      acknowledgement: { fingerprint: borrowedFingerprint() },
    })
    expect(res.status).toBe(403)                                  // 不得变 202/428/409
    expect((await res.json()).reasonCode).toBe('explicit-deny')
  })

  it('403(unknown):带看似合法的 fingerprint 也救不回来', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-unknown-ack-1', commandKey: 'trae-solo/state-get',
      argv: ['trae-solo', 'state-get', '-f', 'json'],
      acknowledgement: { fingerprint: borrowedFingerprint() },
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reasonCode).toBe('metadata-missing')
  })
})

// Step 7-A:确认协议的核心承诺 —— **你被展示的 fingerprint 就是被校验的 fingerprint**。
// 变异⑥ 查实全仓没有任何测试把 /catalog/effective 与 /start 配对,二者同源只是实现巧合。
// 这条把往返走通:envelope 里拿到什么,就原样发回去,必须 202。
describe('/catalog/effective → /start 往返(两端点判决同源)', () => {
  const realSnapshot = JSON.parse(
    readFileSync(resolve('public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''),
  )

  // /catalog/effective 不挂 catalogService 就是 404,而既有那个合成小目录里
  // 根本没有 antigravity/recent-paths,造不出 acknowledgement-required。
  // 故装一个「真快照 + 由它派生的 policy」的 service:两端点读同一个 state 单引用,
  // 正是本用例要守住的那件事。
  const sameSourceService = () => {
    const state = {
      snapshot: realSnapshot,
      policy: buildExecutionPolicy(realSnapshot),
      revision: 'rev-t6-roundtrip',
      generatedAt: 1,
    }
    return { refresh: async () => realSnapshot, current: () => state, close: () => {} }
  }

  it('envelope 下发的 fingerprint 原样回传 → 202', async () => {
    const { baseUrl } = await setup({ catalogService: sameSourceService() })
    const body = await (await fetch(`${baseUrl}/catalog/effective`, { headers: { Origin: origin } })).json()
    const decision = body.policy.decisions.find((d) => d.commandKey === 'antigravity/recent-paths')

    // 前提:envelope 真的下发了一条需确认判决且带 fingerprint。
    // 少了这两句,哪天它变成 ready,下面的 202 会**平凡满足**,这条用例就与确认协议无关了。
    expect(decision.state).toBe('acknowledgement-required')
    expect(typeof decision.fingerprint).toBe('string')

    const res = await post(baseUrl, '/start', {
      runId: 'r-roundtrip-1', commandKey: 'antigravity/recent-paths',
      argv: ['antigravity', 'recent-paths', '-f', 'json'],
      // **原样回传,未在测试里重算。** 自己算就成了「拿被测对象的输出对照它自己」——
      // reviewShapeHash/decisionFingerprint 一起漂,照样绿。
      acknowledgement: { fingerprint: decision.fingerprint },
    })
    expect(res.status).toBe(202)
  })
})

// ——— 试点 argv 白名单在 HTTP 层生效 ——————————————————————————————————
// 为什么必须有这一层:单元层直接调 validateStartRequest,碰不到 host-server 的 catch 分支与
// reasonCode 序列化那行。Task 5/6 都栽过同一个形状——新增的失败路径只有单元覆盖,
// 把 HTTP 侧那行删掉全仓照样绿。
describe('/start 试点 argv 白名单(HTTP 层)', () => {
  const realPolicy = loadExecutionPolicy(resolve('public/catalog.snapshot.json'))
  const pilotAck = () => realPolicy.decisionByKey.get('xiaohongshu/feed').fingerprint

  it('夹具前提:xiaohongshu/feed 是需确认的试点命令且挂了 argv 约束', () => {
    expect(realPolicy.decisionByKey.get('xiaohongshu/feed').state).toBe('acknowledgement-required')
    expect(realPolicy.argvConstraintByKey.has('xiaohongshu/feed')).toBe(true)
  })

  it('400/argv-not-allowed:带 --trace on 的试点命令被 Host 拒绝(不靠前端)', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-trace-1', commandKey: 'xiaohongshu/feed',
      argv: ['xiaohongshu', 'feed', '--trace', 'on', '-f', 'json'],
      acknowledgement: { fingerprint: pilotAck() },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).reasonCode).toBe('argv-not-allowed')
  })

  it('400/argv-not-allowed:--site-session persistent 同样拒绝', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-session-1', commandKey: 'xiaohongshu/feed',
      argv: ['xiaohongshu', 'feed', '--site-session', 'persistent', '-f', 'json'],
      acknowledgement: { fingerprint: pilotAck() },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).reasonCode).toBe('argv-not-allowed')
  })

  it('202:只带声明过的 --limit 时照常受理 —— 白名单不是把试点命令锁死', async () => {
    const { baseUrl } = await setup({ policy: realPolicy })
    const res = await post(baseUrl, '/start', {
      runId: 'r-limit-1', commandKey: 'xiaohongshu/feed',
      argv: ['xiaohongshu', 'feed', '--limit', '20', '-f', 'json'],
      acknowledgement: { fingerprint: pilotAck() },
    })
    expect(res.status).toBe(202)
  })
})

// ——— 浏览器命令启动前的自动修复 ————————————————————————————————————
describe('/start BrowserBridge preflight', () => {
  const realPolicy = loadExecutionPolicy(resolve('public/catalog.snapshot.json'))
  const bridgeOk = {
    checkedAt: 1, daemon: 'running', extension: 'connected', profile: 'ready',
    profileCount: 1, retryable: false, reasonCode: 'ok', summary: '就绪',
  }
  const pilotRequest = (runId, commandKey) => ({
    runId,
    commandKey,
    argv: [...commandKey.split('/'), '-f', 'json'],
    acknowledgement: { fingerprint: realPolicy.decisionByKey.get(commandKey).fingerprint },
  })

  it('扩展断开时先走修复阶梯并拉起浏览器，再受理登录检查', async () => {
    const noExtension = {
      ...bridgeOk, extension: 'disconnected', reasonCode: 'extension-disconnected', summary: '扩展未连接',
    }
    const launchBrowser = vi.fn(async () => ({ launched: true }))
    const { baseUrl } = await setup({
      policy: realPolicy,
      browserBridgeHealth: async () => noExtension,
      launchBrowser,
    })

    const res = await post(baseUrl, '/start', pilotRequest('browser-preflight-1', 'xiaohongshu/whoami'))

    expect(res.status).toBe(202)
    expect(launchBrowser).toHaveBeenCalledTimes(1)
  })

  it('并发 BrowserBridge 命令共享同一次预检，不会重复拉起浏览器', async () => {
    let finishRepair
    const browserBridgeRepair = vi.fn(() => new Promise((resolveRepair) => { finishRepair = resolveRepair }))
    const { baseUrl } = await setup({ policy: realPolicy, browserBridgeRepair })

    const requests = [
      post(baseUrl, '/start', pilotRequest('browser-preflight-2', 'xiaohongshu/whoami')),
      post(baseUrl, '/start', pilotRequest('browser-preflight-3', 'bilibili/whoami')),
    ]
    await vi.waitFor(() => expect(browserBridgeRepair).toHaveBeenCalledTimes(1))
    finishRepair({ steps: [], health: bridgeOk, repaired: false, alreadyOk: true })

    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status)).toEqual([202, 202])
    expect(browserBridgeRepair).toHaveBeenCalledTimes(1)
  })

  it('非 BrowserBridge 命令不触发浏览器预检', async () => {
    const browserBridgeRepair = vi.fn(async () => ({ steps: [], health: bridgeOk, alreadyOk: true }))
    const { baseUrl } = await setup({ browserBridgeRepair })

    const res = await post(baseUrl, '/start', {
      runId: 'direct-command-1', commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'],
    })

    expect(res.status).toBe(202)
    expect(browserBridgeRepair).not.toHaveBeenCalled()
  })

  it('预检异常时仍把命令交给 OpenCLI，让执行通道返回真实结果', async () => {
    const browserBridgeRepair = vi.fn(async () => { throw new Error('preflight failed') })
    const { baseUrl } = await setup({ policy: realPolicy, browserBridgeRepair })

    const res = await post(baseUrl, '/start', pilotRequest('browser-preflight-4', 'youtube/whoami'))

    expect(res.status).toBe(202)
    expect(browserBridgeRepair).toHaveBeenCalledTimes(1)
  })
})

// ——— BrowserBridge 健康诊断(HTTP 层)————————————————————————————————
describe('/browser-bridge/repair', () => {
  const stopped = {
    checkedAt: 1, daemon: 'stopped', extension: 'unknown', profile: 'unknown',
    profileCount: 0, retryable: true, reasonCode: 'daemon-stopped', summary: 'daemon 未运行',
  }
  const ok = {
    checkedAt: 2, daemon: 'running', extension: 'connected', profile: 'ready',
    profileCount: 1, retryable: false, reasonCode: 'ok', summary: '就绪',
  }

  it('POST 走修复阶梯:重启 daemon 后复检通过', async () => {
    const seen = []
    let call = 0
    const { baseUrl } = await setup({
      browserBridgeHealth: async () => (++call === 1 ? stopped : ok),
      runOpenCli: async (argv) => { seen.push(argv); return { code: 0, failed: false } },
      launchBrowser: async () => ({ launched: true }),
    })
    const res = await fetch(`${baseUrl}/browser-bridge/repair`, { method: 'POST', headers: { Origin: origin } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(seen).toEqual([['daemon', 'restart']])
    expect(body.repaired).toBe(true)
    expect(body.health.reasonCode).toBe('ok')
  })

  it('修不成也返回 200 + 真实 health 与可照做的下一步,不是 5xx', async () => {
    const noExt = { ...ok, extension: 'disconnected', reasonCode: 'extension-disconnected', summary: '扩展未连上' }
    const { baseUrl } = await setup({
      browserBridgeHealth: async () => noExt,
      runOpenCli: async () => ({ code: 0, failed: false }),
      launchBrowser: async () => ({ launched: true }),
    })
    const res = await fetch(`${baseUrl}/browser-bridge/repair`, { method: 'POST', headers: { Origin: origin } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.repaired).toBe(false)          // 动作做了,问题没解决 —— 不许报成功
    expect(body.health.reasonCode).toBe('extension-disconnected')
    expect(body.nextStep).toContain('OpenCLI 扩展')
  })

  it('GET 不是修复入口 —— 有副作用的动作不挂在 GET 上', async () => {
    const { baseUrl } = await setup({ browserBridgeHealth: async () => ok })
    const res = await fetch(`${baseUrl}/browser-bridge/repair`, { headers: { Origin: origin } })
    expect(res.status).toBe(404)
  })

  it('跨源 POST 被拒 —— 与其它端点同一道 Origin 闸', async () => {
    const { baseUrl } = await setup({ browserBridgeHealth: async () => ok })
    const res = await fetch(`${baseUrl}/browser-bridge/repair`, { method: 'POST', headers: { Origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })
})

describe('/browser-bridge/health', () => {
  it('转发结构化诊断,且带上 Host 自己知道的 opencliVersion', async () => {
    const { baseUrl } = await setup({
      browserBridgeHealth: async ({ opencliVersion }) => ({
        checkedAt: 1, daemon: 'running', extension: 'connected', profile: 'ready',
        profileCount: 1, opencliVersion, retryable: false, reasonCode: 'ok', summary: '就绪',
      }),
    })
    const res = await fetch(`${baseUrl}/browser-bridge/health`, { headers: { Origin: origin } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.daemon).toBe('running')
    expect(body.reasonCode).toBe('ok')
    // 版本不是诊断器编的,是 Host 从生效 policy 取的 —— 这一行钉住那条接线。
    expect(body.opencliVersion).toBe(policy.opencliVersion)
  })

  it('daemon 没起来时仍返回 200 + 结构化失败,不是 5xx', async () => {
    // 「桥接没就绪」与「Host 内部错误」给用户的下一步动作完全不同,不能混成一个错误码。
    const { baseUrl } = await setup({
      browserBridgeHealth: async () => ({
        checkedAt: 1, daemon: 'stopped', extension: 'unknown', profile: 'unknown',
        profileCount: 0, opencliVersion: '1.8.6', retryable: true,
        reasonCode: 'daemon-stopped', summary: 'daemon 未运行',
      }),
    })
    const res = await fetch(`${baseUrl}/browser-bridge/health`, { headers: { Origin: origin } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.daemon).toBe('stopped')
    expect(body.retryable).toBe(true)
  })

  it('受 Origin 白名单管辖 —— 非法 Origin 拿不到诊断', async () => {
    const { baseUrl } = await setup()
    const res = await fetch(`${baseUrl}/browser-bridge/health`, { headers: { Origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })
})
