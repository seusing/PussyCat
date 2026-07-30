// @vitest-environment node
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fetch as realFetch } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostServer } from './host-server.mjs'
import { createCatalogService } from './catalog-service.mjs'
import { loadExecutionPolicy } from './policy.mjs'
import { canonicalJson } from './policy-fingerprint.mjs'

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

  const effective = (baseUrl) => fetch(`${baseUrl}/catalog/effective`, { headers: { Origin: origin } })

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
    const b = await (await effective(baseUrl)).json()
    expect(b.revision).toBe(a.revision)
  })

  // generatedAt 说的是「**这份判决**何时生成」。端点每次请求都无条件 refresh(),
  // state 每请求重建一次 —— 光把 generatedAt 存进 state 挡不住它每次变。
  // 没有这条守卫,把它写回 `now()` / `Date.now()` 全仓依然全绿(评审实测)。
  it('内容未变 → generatedAt 也必须相同(存进 state 还不够,得沿用旧时刻)', async () => {
    const { service } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const a = await (await effective(baseUrl)).json()
    const b = await (await effective(baseUrl)).json()
    expect(typeof a.policy.generatedAt).toBe('number')
    expect(b.policy.generatedAt).toBe(a.policy.generatedAt)
  })

  // 内容真变了就该换时刻 —— 否则上一条可以靠「永远返回同一个常量」平凡满足。
  it('快照变 → generatedAt 随之更新(反向控制,挡住「恒定常量」的平凡解)', async () => {
    const { service, mutate } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const before = await (await effective(baseUrl)).json()
    mutate()
    const after = await (await effective(baseUrl)).json()
    expect(after.revision).not.toBe(before.revision)
    expect(after.policy.generatedAt).not.toBe(before.policy.generatedAt)
  })

  it('快照变 → revision 必变(否则它挡不住「换了目录却说还是同一份」)', async () => {
    const { service, mutate } = liveCatalogService()
    const { baseUrl } = await setup({ catalogService: service })
    const before = await (await effective(baseUrl)).json()
    mutate()
    const after = await (await effective(baseUrl)).json()
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
})
