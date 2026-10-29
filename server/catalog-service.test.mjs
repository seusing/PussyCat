// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createCatalogService, CatalogServiceError } from './catalog-service.mjs'

const LIST = JSON.stringify([
  { command: 'a/ok', site: 'a', name: 'ok', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
])
const MANIFEST = JSON.stringify([{ site: 'a', name: 'ok', type: 'json' }])

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig); return true }
  return child
}

function setup(overrides = {}) {
  const children = []
  const spawnCalls = []
  const service = createCatalogService({
    opencliEntry: 'C:/fixture/dist/src/main.js',
    resolveManifest: () => 'C:/fixture/cli-manifest.json',
    spawnImpl: (cmd, argv, opts) => {
      spawnCalls.push({ cmd, argv, opts })
      const child = fakeChild()
      children.push(child)
      return child
    },
    readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"9.9.9"}' : MANIFEST),
    timeoutMs: 30,
    ...overrides,
  })
  return { service, children, spawnCalls }
}

function emitSuccess(child, payload = LIST) {
  child.stdout.emit('data', Buffer.from(payload))
  child.emit('close', 0)
}

describe('CatalogService', () => {
  it('初始快照立即提供同源 policy，首屏不会 spawn opencli list', () => {
    const initialSnapshot = {
      schemaVersion: 1,
      generatedAt: 123,
      opencliVersion: '9.9.9',
      source: 'bundled',
      listSha256: 'list',
      manifestSha256: 'manifest',
      commands: JSON.parse(LIST),
    }
    const { service, spawnCalls } = setup({ initialSnapshot })
    expect(spawnCalls).toHaveLength(0)
    expect(service.current()).toMatchObject({ snapshot: initialSnapshot, generatedAt: 123 })
    expect(service.current().policy.decisionByKey.get('a/ok')).toBeDefined()
  })

  it('成功刷新:spawn 姿势正确 + snapshot/policy 原子生效', async () => {
    const { service, children, spawnCalls } = setup()
    const refreshing = service.refresh()
    emitSuccess(children[0])
    const snapshot = await refreshing
    expect(spawnCalls[0].cmd).toBe(process.execPath)
    expect(spawnCalls[0].argv).toEqual(['C:/fixture/dist/src/main.js', 'list', '-f', 'json'])
    expect(spawnCalls[0].opts).toMatchObject({ shell: false })
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.commands[0].type).toBe('json')            // manifest 字段已 merge
    expect(snapshot.opencliVersion).toBe('9.9.9')
    // 正向控制:证明 policy 确实从**新快照**重建过。判决覆盖全目录,新命令出现在判决里即是证据。
    // 为什么不用 allowedCommands:夹具里的 a/ok 不落任何 tier,允许集为空是 fail-closed 的
    // **正确行为**,不是需要绕开的障碍。
    const decision = service.current().policy.decisionByKey.get('a/ok')
    expect(decision).toBeDefined()
    expect(decision.state).toBe('unknown')
  })

  it('真刷新构造的 policy 消费显式 deny 覆盖表', async () => {
    const list = JSON.stringify([
      { command: 'a/ok', site: 'a', name: 'ok', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
      { command: 'paperreview/review', site: 'paperreview', name: 'review', description: '', access: 'read', strategy: 'public', browser: false, args: [] },
    ])
    const manifest = JSON.stringify([
      { site: 'a', name: 'ok', type: 'json' },
      { site: 'paperreview', name: 'review', type: 'json' },
    ])
    const { service, children } = setup({
      readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"9.9.9"}' : manifest),
    })

    const refreshing = service.refresh()
    emitSuccess(children[0], list)
    await refreshing

    const current = service.current()
    expect(current.snapshot.commands.some((command) => command.command === 'paperreview/review')).toBe(true)
    // 正向控制:理由同上一条(9.9.9 → 基线集体失效),改从判决取。
    expect(current.policy.decisionByKey.get('a/ok')).toBeDefined()
    // deny 臂**加强**:钉住「**为什么**被拒」,而不只是「不在允许集里」。
    // 后者在空集上平凡成立 —— 证明不了覆盖表真的被消费过。
    expect(current.policy.decisionByKey.get('paperreview/review').decisionSource).toBe('explicit-deny')
    expect(current.policy.allowedCommands.has('paperreview/review')).toBe(false)
    expect(current.policy.deniedCommands.get('paperreview/review')).toContain('capability token')
  })

  it('single-flight:并发 refresh 只 spawn 一次', async () => {
    const { service, children, spawnCalls } = setup()
    const p1 = service.refresh(); const p2 = service.refresh()
    emitSuccess(children[0])
    await Promise.all([p1, p2])
    expect(spawnCalls).toHaveLength(1)
  })

  it('非零退出 → 502 且旧值不动', async () => {
    const { service, children } = setup()
    const p1 = service.refresh(); emitSuccess(children[0]); await p1
    const before = service.current()
    const p2 = service.refresh()
    children[1].stderr.emit('data', Buffer.from('boom'))
    children[1].emit('close', 3)
    await expect(p2).rejects.toMatchObject({ statusCode: 502 })
    expect(service.current()).toBe(before)                    // 原子:失败旧值不动
  })

  it('超时 → 504 + kill', async () => {
    const { service, children } = setup({ timeoutMs: 15 })
    const p = service.refresh()
    await expect(p).rejects.toMatchObject({ statusCode: 504 })
    expect(children[0].kills.length).toBeGreaterThan(0)
  })

  it('stdout 超限 → 502 + kill', async () => {
    const { service, children } = setup({ maxOutputBytes: 8 })
    const p = service.refresh()
    children[0].stdout.emit('data', Buffer.from('123456789'))
    await expect(p).rejects.toMatchObject({ statusCode: 502 })
    expect(children[0].kills.length).toBeGreaterThan(0)
  })

  it('坏 JSON → 500', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    emitSuccess(children[0], '{not json')
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('manifest 读取失败 → 500', async () => {
    const { service, children } = setup({ readFileImpl: () => { throw new Error('ENOENT') } })
    const p = service.refresh()
    emitSuccess(children[0])
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('schema 校验失败(命令缺字段) → 500', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    emitSuccess(children[0], JSON.stringify([{ command: 'a/bad' }]))
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('schema 深校验失败(args:[null]) → 500(三轮复审 F2)', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    emitSuccess(children[0], JSON.stringify([
      { command: 'a/ok', site: 'a', name: 'ok', description: '', access: 'read', strategy: 'public', browser: false, args: [null] },
    ]))
    await expect(p).rejects.toMatchObject({ statusCode: 500 })
  })

  it('close() kill 在途子进程,之后 refresh 拒绝', async () => {
    const { service, children } = setup()
    const p = service.refresh()
    service.close()
    expect(children[0].kills.length).toBeGreaterThan(0)
    await expect(p).rejects.toBeInstanceOf(CatalogServiceError)
    await expect(service.refresh()).rejects.toMatchObject({ statusCode: 500 })
  })

  it('manifest 惰性:resolver 每次 refresh 调用,失败不缓存,文件出现后自愈(验收条件②)', async () => {
    let available = false
    const { service, children, spawnCalls } = setup({ resolveManifest: () => { if (!available) throw new Error('ENOENT'); return 'C:/fixture/cli-manifest.json' } })
    const p1 = service.refresh()                                    // resolver 失败于 spawn 之前,本轮无子进程可 emit(复审 F5)
    await expect(p1).rejects.toMatchObject({ statusCode: 500 })
    expect(service.current()).toBeUndefined()                       // 失败不缓存也不落状态
    expect(spawnCalls).toHaveLength(0)   // fail-fast:resolver 失败时根本没 spawn opencli list(复审 F5)
    available = true
    const p2 = service.refresh(); emitSuccess(children[0])          // 本轮才是第一次真正 spawn
    await expect(p2).resolves.toMatchObject({ schemaVersion: 1 })   // 自愈
  })

  it('同步 spawn throw → 502(状态码矩阵补齐)', async () => {
    const { service } = setup({ spawnImpl: () => { throw new Error('EPERM sync') } })
    await expect(service.refresh()).rejects.toMatchObject({ statusCode: 502 })
  })
})

// OpenCLI 2.0:list 是分页的 {ok,data} 外壳,条目只有 command/description/access,参数回 manifest 取。
describe('CatalogService —— OpenCLI 2.0 输出', () => {
  const page = (commands, nextOffset) => JSON.stringify({ ok: true, data: { commands, total: 4, nextOffset } })
  const MANIFEST_2 = JSON.stringify([
    { site: 'a', name: 'ok', description: 'manifest desc', access: 'read', strategy: 'public', browser: false, type: 'js', modulePath: 'a/ok.js',
      args: [{ name: 'limit', type: 'int', default: 20 }], columns: ['x'] },
    { site: 'b', name: 'two', description: 'two', access: 'read', args: [{ name: 'q', type: 'str', positional: true, required: true }] },
    { site: 'c', name: 'not-listed', description: 'cannot load', access: 'read', args: [] },
  ])

  // 每个子进程按其 argv 自动喂一页输出并关闭。
  function pagedSetup(pages, overrides = {}) {
    const spawnCalls = []
    const service = createCatalogService({
      opencliEntry: 'C:/fixture/dist/src/main.js',
      resolveManifest: () => 'C:/fixture/cli-manifest.json',
      spawnImpl: (cmd, argv) => {
        spawnCalls.push(argv)
        const child = fakeChild()
        const key = argv.includes('--offset') ? argv[argv.indexOf('--offset') + 1] : '0'
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(pages[key]))
          child.emit('close', 0)
        })
        return child
      },
      readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"2.0.2"}' : MANIFEST_2),
      ...overrides,
    })
    return { service, spawnCalls }
  }

  it('翻页取全,条目从 manifest 构造并按 1.8.8 口径规整参数', async () => {
    const { service, spawnCalls } = pagedSetup({
      0: page([{ command: 'a ok', description: 'list desc', access: 'read' }, { command: 'browser open', description: 'x', access: 'read' }], 2),
      2: page([{ command: 'b two', description: 'two', access: 'read' }], null),
    })
    const snapshot = await service.refresh()

    expect(spawnCalls).toEqual([
      ['C:/fixture/dist/src/main.js', 'list', '-f', 'json'],
      ['C:/fixture/dist/src/main.js', 'list', '-f', 'json', '--limit', '100', '--offset', '2'],
    ])
    expect(snapshot.opencliVersion).toBe('2.0.2')
    // 内置命令组(browser open)和 list 里没出现的 manifest 条目都不进目录
    expect(snapshot.commands.map((command) => command.command)).toEqual(['a/ok', 'b/two'])
    expect(snapshot.commands[0]).toMatchObject({
      site: 'a', name: 'ok', aliases: [], description: 'list desc', modulePath: 'a/ok.js', columns: ['x'],
      args: [{ name: 'limit', type: 'int', default: 20, choices: [], valueRequired: false, positional: false, required: false }],
    })
    expect(snapshot.commands[1].args[0]).toMatchObject({ positional: true, required: true, default: null, choices: [] })
    expect(snapshot.listSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(service.current().policy.decisionByKey.get('a/ok')).toBeDefined()
  })

  it('某一页失败 → 整次刷新失败,旧值不动', async () => {
    const { service } = pagedSetup({
      0: page([{ command: 'a ok', access: 'read' }], 1),
      1: '{not json',
    })
    await expect(service.refresh()).rejects.toMatchObject({ statusCode: 500, message: 'opencli list output is not valid JSON' })
    expect(service.current()).toBeUndefined()
  })

  it('入口是 getter:每次刷新取当时的入口', async () => {
    let entry = 'C:/v1/dist/src/main.js'
    const { service, spawnCalls } = pagedSetup({ 0: page([{ command: 'a ok', access: 'read' }], null) }, { opencliEntry: () => entry })
    await service.refresh()
    entry = 'C:/v2/dist/src/main.js'
    await service.refresh()
    expect(spawnCalls.map((argv) => argv[0])).toEqual(['C:/v1/dist/src/main.js', 'C:/v2/dist/src/main.js'])
  })

  it('刷新途中换了入口:这一轮作废,按新入口重来后再生效', async () => {
    let entry = 'C:/v1/dist/src/main.js'
    const spawned = []
    const service = createCatalogService({
      opencliEntry: () => entry,
      resolveManifest: () => 'C:/fixture/cli-manifest.json',
      spawnImpl: (_cmd, argv) => {
        spawned.push(argv[0])
        const child = fakeChild()
        const first = spawned.length === 1
        setImmediate(() => {
          if (first) entry = 'C:/v2/dist/src/main.js'      // 第一轮的 list 还没返回时,入口被切走
          child.stdout.emit('data', Buffer.from(first ? LIST : JSON.stringify([
            { command: 'a/ok', site: 'a', name: 'ok', description: 'from v2', access: 'read', strategy: 'public', browser: false, args: [] },
          ])))
          child.emit('close', 0)
        })
        return child
      },
      readFileImpl: (path) => (String(path).includes('package.json') ? '{"version":"9.9.9"}' : MANIFEST),
    })
    const snapshot = await service.refresh()
    expect(spawned).toEqual(['C:/v1/dist/src/main.js', 'C:/v2/dist/src/main.js'])
    expect(snapshot.commands[0].description).toBe('from v2')
    expect(service.current().snapshot).toBe(snapshot)
  })
})

describe('CatalogService.settled', () => {
  const seed = {
    schemaVersion: 1,
    generatedAt: 1,
    opencliVersion: '1.0.0',
    source: 'bundled',
    listSha256: 'list',
    manifestSha256: 'manifest',
    commands: JSON.parse(LIST),
  }

  it('没有在途刷新:直接返回当前状态,不 spawn', async () => {
    const { service, spawnCalls } = setup({ initialSnapshot: seed })
    const state = await service.settled()
    expect(state).toBe(service.current())
    expect(state.snapshot).toBe(seed)
    expect(spawnCalls).toHaveLength(0)
  })

  it('在途刷新期间:等它落地,返回的是刷新后的状态', async () => {
    const { service, children } = setup({ initialSnapshot: seed })
    const refreshing = service.refresh()
    let done = false
    const waiting = service.settled().then((state) => { done = true; return state })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    expect(done).toBe(false)                              // 刷新没完,不放行
    emitSuccess(children[0])
    const state = await waiting
    await refreshing
    expect(state.snapshot.opencliVersion).toBe('9.9.9')   // 不是打包快照的 1.0.0
    expect(state).toBe(service.current())
  })

  it('在途刷新失败:不抛,返回刷新前的状态', async () => {
    const { service, children } = setup({ initialSnapshot: seed })
    const before = service.current()
    const refreshing = service.refresh().catch((error) => error)
    const waiting = service.settled()
    children[0].stderr.emit('data', Buffer.from('boom'))
    children[0].emit('close', 3)
    await expect(waiting).resolves.toBe(before)
    expect(await refreshing).toBeInstanceOf(CatalogServiceError)
  })
})
