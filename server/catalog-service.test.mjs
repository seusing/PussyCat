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
    expect(service.current().policy.allowedCommands.has('a/ok')).toBe(true)
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
