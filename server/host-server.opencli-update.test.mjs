// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fetch as realFetch } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostServer } from './host-server.mjs'
import { createOpencliRuntime } from './opencli-runtime.mjs'

const origin = 'http://127.0.0.1:5173'
const policy = {
  opencliVersion: '1.8.8',
  description: 'test policy',
  decisionByKey: new Map([
    ['36kr/news', { commandKey: '36kr/news', state: 'ready', decisionSource: 'tier-evaluation' }],
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
const tempDirs = []

beforeEach(() => {
  vi.stubGlobal('fetch', realFetch)
})

afterEach(async () => {
  await Promise.all([...openApps].map(async (app) => {
    openApps.delete(app)
    await app.close()
  }))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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

function fakeEntry(dir, version) {
  const packageRoot = join(dir, 'node_modules', '@jackwener', 'opencli')
  mkdirSync(join(packageRoot, 'dist', 'src'), { recursive: true })
  writeFileSync(join(packageRoot, 'dist', 'src', 'main.js'), '')
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }))
  return join(packageRoot, 'dist', 'src', 'main.js')
}

// 临时目录里的 runtime;active 给了就当作已经更新过。
function fakeRuntime({ active } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'host-opencli-'))
  tempDirs.push(base)
  const runtime = createOpencliRuntime({ bundledEntry: fakeEntry(join(base, 'bundled'), '1.8.8'), dataRoot: join(base, 'data') })
  if (active) runtime.activate(active, fakeEntry(join(runtime.root, 'versions', active), active))
  return runtime
}

// 不联网:查版本的请求一直挂着,直到任务被取消。
const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason))
})

const get = (baseUrl, path) => fetch(`${baseUrl}${path}`, { headers: { Origin: origin } })
const postEmpty = (baseUrl, path) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { Origin: origin } })
const post = (baseUrl, path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
// 假视频引擎:status 是 health() 给的状态,jobs 是 /api/jobs 的返回(Error 实例表示取列表失败)。
function fakeSidecar(status, jobs = []) {
  return {
    health: vi.fn(() => ({ status })),
    fetchApi: vi.fn(async () => {
      if (jobs instanceof Error) throw jobs
      return new Response(JSON.stringify(jobs), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    stop: vi.fn(async () => {}),
  }
}
const startNews = (baseUrl, runId) => post(baseUrl, '/start', { runId, commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'] })

describe('/opencli/release 带生效版本与内置版本', () => {
  const release = { checkedAt: 1, current: '1.8.8', latest: '2.0.2', updateAvailable: true, releaseUrl: 'https://github.com/jackwener/opencli/releases/tag/v2.0.2' }

  it('没接 runtime:生效版本和内置版本都取自生效 policy', async () => {
    const opencliRelease = vi.fn(async () => release)
    const { baseUrl } = await setup({ opencliRelease })
    const res = await get(baseUrl, '/opencli/release')
    await expect(res.json()).resolves.toEqual({ ...release, active: '1.8.8', bundled: '1.8.8' })
    expect(opencliRelease).toHaveBeenCalledWith({ currentVersion: '1.8.8' })
  })

  it('接了 runtime:current 等于生效版本,另带内置版本', async () => {
    const opencliRelease = vi.fn(async ({ currentVersion }) => ({ ...release, current: currentVersion, updateAvailable: false }))
    const { baseUrl } = await setup({ opencliRelease, opencliRuntime: fakeRuntime({ active: '2.0.2' }) })
    const res = await get(baseUrl, '/opencli/release')

    expect(opencliRelease).toHaveBeenCalledWith({ currentVersion: '2.0.2' })
    await expect(res.json()).resolves.toMatchObject({ current: '2.0.2', active: '2.0.2', bundled: '1.8.8' })
  })
})

describe('/opencli/update 与 /opencli/rollback', () => {
  it('没有任务时 GET 返回 job: null', async () => {
    const { baseUrl } = await setup({ opencliRuntime: fakeRuntime() })
    const res = await get(baseUrl, '/opencli/update')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ job: null })
  })

  it('POST 开始:202 和任务快照;GET 读到同一个;再 POST 是 409', async () => {
    const { baseUrl } = await setup({ opencliRuntime: fakeRuntime(), opencliUpdateOptions: { fetchImpl: hangingFetch } })

    const started = await post(baseUrl, '/opencli/update', { version: '2.0.2' })
    expect(started.status).toBe(202)
    const { job } = await started.json()
    expect(job).toMatchObject({
      version: '2.0.2', state: 'running', stage: 'resolve', receivedBytes: 0, totalBytes: null, percent: 0,
      error: null, warnings: [], finishedAt: null,
    })
    expect(job.id).toEqual(expect.any(String))
    expect(job.startedAt).toEqual(expect.any(Number))

    const polled = await (await get(baseUrl, '/opencli/update')).json()
    expect(polled.job.id).toBe(job.id)

    const again = await post(baseUrl, '/opencli/update', { version: '2.0.2' })
    expect(again.status).toBe(409)
    await expect(again.json()).resolves.toEqual({ error: '已有更新任务在进行' })
  })

  it('cancel:200 和已取消的任务,生效版本不变', async () => {
    const runtime = fakeRuntime()
    const { baseUrl } = await setup({ opencliRuntime: runtime, opencliUpdateOptions: { fetchImpl: hangingFetch } })
    await post(baseUrl, '/opencli/update', { version: '2.0.2' })

    const res = await postEmpty(baseUrl, '/opencli/update/cancel')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ job: { state: 'cancelled', version: '2.0.2' } })
    expect(runtime.active()).toBeNull()
  })

  it('版本号不合法:400', async () => {
    const { baseUrl } = await setup({ opencliRuntime: fakeRuntime() })
    expect((await post(baseUrl, '/opencli/update', { version: '../evil' })).status).toBe(400)
    expect((await post(baseUrl, '/opencli/update', {})).status).toBe(400)
  })

  it('有命令在运行时拒绝开始:409 和中文原因', async () => {
    const { baseUrl } = await setup({ opencliRuntime: fakeRuntime(), opencliUpdateOptions: { fetchImpl: hangingFetch } })
    expect((await startNews(baseUrl, 'run-1')).status).toBe(202)

    const res = await post(baseUrl, '/opencli/update', { version: '2.0.2' })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: '有命令正在运行，等它们结束后再更新' })
  })

  it('rollback:200 {active: null},退回内置版本,重启 daemon、刷新目录、停视频引擎', async () => {
    const runtime = fakeRuntime({ active: '2.0.2' })
    const runOpenCli = vi.fn(async () => ({ code: 0, failed: false }))
    const vkSidecar = fakeSidecar('stopped')
    const catalogService = { refresh: vi.fn(async () => ({})), current: () => undefined, close: vi.fn() }
    const { baseUrl } = await setup({ opencliRuntime: runtime, runOpenCli, vkSidecar, catalogService })

    const res = await postEmpty(baseUrl, '/opencli/rollback')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ active: null })
    expect(runtime.version()).toBe('1.8.8')
    expect(runOpenCli).toHaveBeenCalledWith(['daemon', 'restart'], expect.objectContaining({ opencliEntry: expect.anything() }))
    expect(catalogService.refresh).toHaveBeenCalledTimes(1)
    expect(vkSidecar.stop).toHaveBeenCalled()
  })

  it('切换期间新的命令启动请求返回 503,切换结束后恢复', async () => {
    const runtime = fakeRuntime({ active: '2.0.2' })
    let finishRefresh
    const refreshing = new Promise((done) => { finishRefresh = done })
    const catalogService = { refresh: vi.fn(() => refreshing), current: () => undefined, close: vi.fn() }
    const { baseUrl } = await setup({ opencliRuntime: runtime, runOpenCli: async () => ({ code: 0, failed: false }), catalogService })

    const rollingBack = postEmpty(baseUrl, '/opencli/rollback')
    await vi.waitFor(() => expect(catalogService.refresh).toHaveBeenCalled())
    const blocked = await startNews(baseUrl, 'run-2')
    expect(blocked.status).toBe(503)
    await expect(blocked.json()).resolves.toEqual({ error: '正在切换 OpenCLI，请稍候' })

    finishRefresh({})
    expect((await rollingBack).status).toBe(200)
    expect((await startNews(baseUrl, 'run-3')).status).toBe(202)
  })

  it('子进程入口随生效版本走:切换后起的命令用新入口', async () => {
    const runtime = fakeRuntime()
    const calls = []
    const { baseUrl } = await setup({
      opencliEntry: () => runtime.entry(),
      opencliRuntime: runtime,
      runManagerOptions: { spawnImpl: (...args) => { calls.push(args); return new FakeChild() } },
    })
    await startNews(baseUrl, 'run-a')
    const newEntry = fakeEntry(join(runtime.root, 'versions', '2.0.2'), '2.0.2')
    runtime.activate('2.0.2', newEntry)
    await startNews(baseUrl, 'run-b')
    expect(calls[0][1][0]).not.toBe(newEntry)
    expect(calls[1][1][0]).toBe(newEntry)
  })

  it('没接 runtime:503', async () => {
    const { baseUrl } = await setup()
    expect((await get(baseUrl, '/opencli/update')).status).toBe(503)
    expect((await postEmpty(baseUrl, '/opencli/rollback')).status).toBe(503)
  })

  it('方法不对是 404;非法 Origin 是 403', async () => {
    const { baseUrl } = await setup({ opencliRuntime: fakeRuntime() })
    expect((await get(baseUrl, '/opencli/rollback')).status).toBe(404)
    expect((await fetch(`${baseUrl}/opencli/update`, { headers: { Origin: 'http://evil.example' } })).status).toBe(403)
    expect((await fetch(`${baseUrl}/opencli/rollback`, { method: 'POST', headers: { Origin: 'http://evil.example' } })).status).toBe(403)
  })
})

describe('切换 OpenCLI 时的视频引擎', () => {
  const rollBack = async (vkSidecar) => {
    const catalogService = { refresh: vi.fn(async () => ({})), current: () => undefined, close: vi.fn() }
    const { baseUrl } = await setup({
      opencliRuntime: fakeRuntime({ active: '2.0.2' }),
      runOpenCli: async () => ({ code: 0, failed: false }),
      vkSidecar,
      catalogService,
    })
    const res = await postEmpty(baseUrl, '/opencli/rollback')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ active: null })
  }

  it.each(['queued', 'running', 'cancel_requested'])('引擎有 %s 的任务:不停,让它跑完', async (status) => {
    const vkSidecar = fakeSidecar('ok', [{ id: 'a', status: 'completed' }, { id: 'b', status }])
    await rollBack(vkSidecar)
    expect(vkSidecar.fetchApi).toHaveBeenCalledWith('/api/jobs')
    expect(vkSidecar.stop).not.toHaveBeenCalled()
  })

  it('任务都结束了(completed、interrupted、failed、没有任务):停引擎', async () => {
    for (const jobs of [[{ status: 'completed' }, { status: 'interrupted' }, { status: 'failed' }], []]) {
      const vkSidecar = fakeSidecar('ok', jobs)
      await rollBack(vkSidecar)
      expect(vkSidecar.stop).toHaveBeenCalledTimes(1)
    }
  })

  it('引擎没在跑:直接 stop(),不去取任务列表', async () => {
    for (const status of ['stopped', 'not-configured', 'failed']) {
      const vkSidecar = fakeSidecar(status)
      await rollBack(vkSidecar)
      expect(vkSidecar.fetchApi).not.toHaveBeenCalled()
      expect(vkSidecar.stop).toHaveBeenCalledTimes(1)
    }
  })

  it('取任务列表失败:不停引擎,切换照常完成', async () => {
    const vkSidecar = fakeSidecar('ok', new Error('connection reset'))
    await rollBack(vkSidecar)
    expect(vkSidecar.stop).not.toHaveBeenCalled()
  })

  it('任务列表响应异常(HTTP 错误、不是数组):不停引擎', async () => {
    const httpError = fakeSidecar('ok')
    httpError.fetchApi.mockResolvedValue(new Response('boom', { status: 500 }))
    await rollBack(httpError)
    expect(httpError.stop).not.toHaveBeenCalled()

    const notArray = fakeSidecar('ok', { jobs: [] })
    await rollBack(notArray)
    expect(notArray.stop).not.toHaveBeenCalled()
  })
})
