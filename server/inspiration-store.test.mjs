// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostServer } from './host-server.mjs'
import {
  BACKUP_KEEP,
  InspirationStoreError,
  createInspirationStore,
  libraryProblem,
} from './inspiration-store.mjs'

const origin = 'http://127.0.0.1:5173'

function library(label = 'a') {
  return {
    version: 1,
    folders: [{ id: `folder-${label}`, name: `文件夹 ${label}`, createdAt: 1, parentId: null }],
    items: [{
      id: `item-${label}`, title: `笔记 ${label}`, content: `内容 ${label}`,
      kind: 'note', format: 'md', folderId: null, createdAt: 1, updatedAt: 1,
    }],
  }
}

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-inspiration-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const files = () => readdirSync(dir).sort()

describe('灵感库文件存储', () => {
  it('文件不存在时 read 返回 exists:false', async () => {
    const store = createInspirationStore({ dir: join(dir, 'inspiration') })
    expect(await store.read()).toEqual({ exists: false, library: null, savedAt: null })
  })

  it('write 建出目录并原子替换,不留临时文件,read 读回同一份', async () => {
    const target = join(dir, 'inspiration')
    const store = createInspirationStore({ dir: target })

    const first = await store.write(library('a'))
    expect(first.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await store.write(library('b'))

    const read = await store.read()
    expect(read).toMatchObject({ exists: true, library: library('b') })
    expect(read.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(JSON.parse(readFileSync(join(target, 'library.json'), 'utf8'))).toEqual(library('b'))
    expect(readdirSync(target).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('并发写入后文件仍是某一次完整写入的内容', async () => {
    const target = join(dir, 'inspiration')
    const store = createInspirationStore({ dir: target })
    await store.write(library('seed'))

    const labels = Array.from({ length: 12 }, (_, index) => `c${index}`)
    await Promise.all(labels.map((label) => store.write(library(label))))

    const saved = JSON.parse(readFileSync(join(target, 'library.json'), 'utf8'))
    expect(labels.map(library)).toContainEqual(saved)
    expect(readdirSync(target).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('结构不合格的库被拒绝,磁盘上的旧文件不动', async () => {
    const store = createInspirationStore({ dir })
    await store.write(library('keep'))

    for (const bad of [null, [], { version: 2, folders: [], items: [] }, { version: 1, folders: [] },
      { version: 1, folders: [], items: [{ id: 1 }] }, { version: 1, folders: [{ id: 'f' }], items: [] }]) {
      await expect(store.write(bad)).rejects.toMatchObject({ statusCode: 400, reasonCode: 'inspiration-invalid' })
    }
    expect(JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8'))).toEqual(library('keep'))
    expect(files().filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('libraryProblem 对合格的库返回 null', () => {
    expect(libraryProblem(library())).toBeNull()
    expect(libraryProblem({ version: 1, folders: [], items: [] })).toBeNull()
  })

  it('文件内容坏掉时 read 报错而不是当作不存在', async () => {
    writeFileSync(join(dir, 'library.json'), '{"version": 1, "items": [')
    const store = createInspirationStore({ dir })
    await expect(store.read()).rejects.toBeInstanceOf(InspirationStoreError)
    await expect(store.read()).rejects.toMatchObject({ statusCode: 500, reasonCode: 'inspiration-corrupt' })
  })

  describe('每日备份', () => {
    const day = (n) => new Date(2026, 9, n, 12, 0, 0)

    it('每天第一次覆盖前复制一份,当天后续写入不再备份', async () => {
      let today = day(1)
      const store = createInspirationStore({ dir, now: () => today })

      await store.write(library('v1'))
      expect(files()).toEqual(['library.json'])

      await store.write(library('v2'))
      expect(files()).toEqual(['library.json', 'library.json.bak-20261001'])
      expect(JSON.parse(readFileSync(join(dir, 'library.json.bak-20261001'), 'utf8'))).toEqual(library('v1'))

      await store.write(library('v3'))
      expect(JSON.parse(readFileSync(join(dir, 'library.json.bak-20261001'), 'utf8'))).toEqual(library('v1'))

      today = day(2)
      await store.write(library('v4'))
      expect(files()).toEqual(['library.json', 'library.json.bak-20261001', 'library.json.bak-20261002'])
      expect(JSON.parse(readFileSync(join(dir, 'library.json.bak-20261002'), 'utf8'))).toEqual(library('v3'))
    })

    it('最多保留 7 份,按日期删最旧的,不碰其它文件', async () => {
      writeFileSync(join(dir, 'notes.txt'), 'keep')
      writeFileSync(join(dir, 'library.json.bak-manual'), 'keep')
      let today = day(1)
      const store = createInspirationStore({ dir, now: () => today })

      await store.write(library('v0'))
      for (let n = 1; n <= 10; n += 1) {
        today = day(n)
        await store.write(library(`v${n}`))
      }

      const backups = files().filter((name) => /^library\.json\.bak-\d{8}$/.test(name))
      expect(backups).toHaveLength(BACKUP_KEEP)
      expect(backups).toEqual(['04', '05', '06', '07', '08', '09', '10'].map((d) => `library.json.bak-202610${d}`))
      expect(files()).toEqual(expect.arrayContaining(['notes.txt', 'library.json.bak-manual', 'library.json']))
    })
  })
})

describe('GET/PUT /inspiration/library', () => {
  let app
  let baseUrl

  async function start(extra = {}) {
    const store = createInspirationStore({ dir: join(dir, 'inspiration'), ...extra })
    app = createHostServer({
      opencliEntry: 'C:\\fixture\\dist\\src\\main.js',
      policy: { opencliVersion: '1.8.6', description: 'test policy', decisionByKey: new Map() },
      allowedOrigins: [origin],
      inspirationStore: store,
    })
    const address = await app.listen({ port: 0 })
    baseUrl = `http://127.0.0.1:${address.port}`
    return store
  }

  const put = (body, headers = {}) => fetch(`${baseUrl}/inspiration/library`, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const get = (headers = { Origin: origin }) => fetch(`${baseUrl}/inspiration/library`, { headers })

  afterEach(async () => { await app?.close(); app = undefined })

  it('读不存在的库返回 exists:false', async () => {
    await start()
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ exists: false, library: null, savedAt: null })
  })

  it('PUT 写入后 GET 读回,文件落在 <dir>/library.json', async () => {
    await start()
    const response = await put(library('x'))
    expect(response.status).toBe(200)
    expect((await response.json()).savedAt).toMatch(/^\d{4}-/)

    const read = await (await get()).json()
    expect(read).toMatchObject({ exists: true, library: library('x') })
    expect(JSON.parse(readFileSync(join(dir, 'inspiration', 'library.json'), 'utf8'))).toEqual(library('x'))
  })

  it('结构校验失败返回 400,body 不是 JSON 也是 400', async () => {
    await start()
    const invalid = await put({ version: 1, folders: [], items: 'nope' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ reasonCode: 'inspiration-invalid' })
    expect((await put('{not json')).status).toBe(400)
    expect((await put(library(), { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await (await get()).json()).exists).toBe(false)
  })

  it('超过上限返回 413,旧文件不动', async () => {
    await start({ maxBytes: 4096 })
    expect((await put(library('small'))).status).toBe(200)

    const big = library('big')
    big.items[0].content = 'x'.repeat(8192)
    const response = await put(big)
    expect(response.status).toBe(413)
    expect((await (await get()).json()).library).toEqual(library('small'))
  })

  it('默认上限是 50MB', () => {
    expect(createInspirationStore({ dir }).maxBytes).toBe(50 * 1024 * 1024)
  })

  it('Origin 不在白名单时 GET 和 PUT 都是 403', async () => {
    await start()
    const foreign = { Origin: 'http://evil.example' }
    expect((await get(foreign)).status).toBe(403)
    expect((await put(library(), foreign)).status).toBe(403)
    expect((await get({})).status).toBe(403)
    expect(() => readFileSync(join(dir, 'inspiration', 'library.json'))).toThrow()
  })

  it('文件损坏时 GET 返回 500 和 reasonCode', async () => {
    await start()
    mkdirSync(join(dir, 'inspiration'), { recursive: true })
    writeFileSync(join(dir, 'inspiration', 'library.json'), 'garbage')
    const response = await get()
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ reasonCode: 'inspiration-corrupt' })
  })

  it('没有接入存储时返回 503', async () => {
    app = createHostServer({
      opencliEntry: 'C:\\fixture\\dist\\src\\main.js',
      policy: { opencliVersion: '1.8.6', description: 'test policy', decisionByKey: new Map() },
      allowedOrigins: [origin],
    })
    baseUrl = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`
    expect((await get()).status).toBe(503)
  })
})
