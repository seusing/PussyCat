// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostServer } from './host-server.mjs'
import { createDotHistoryStore, dotHistoryProblem } from './dot-history-store.mjs'

const origin = 'http://127.0.0.1:5173'

function history(question = '周末去哪') {
  return {
    version: 1,
    conversations: [{
      id: 'c1', remoteId: 'dot-1', title: question, createdAt: 1, updatedAt: 2,
      turns: [{ id: 't1', question, answer: '肇庆', steps: [], references: [], sourceTotal: '', state: 'done', startedAt: 1 }],
    }],
  }
}

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-dot-history-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('点点对话记录文件存储', () => {
  it('写入后读回同一份,当天第二次写入前留一份备份', async () => {
    const store = createDotHistoryStore({ dir, now: () => new Date(2026, 10, 26, 9) })
    expect(await store.read()).toEqual({ exists: false, history: null, savedAt: null })
    await store.write(history('第一问'))
    await store.write(history('第二问'))
    expect(await store.read()).toMatchObject({ exists: true, history: history('第二问') })
    expect(readdirSync(dir).sort()).toEqual(['history.json', 'history.json.bak-20261126'])
    expect(JSON.parse(readFileSync(join(dir, 'history.json.bak-20261126'), 'utf8'))).toEqual(history('第一问'))
  })

  it('结构不合格的记录被拒绝,磁盘上的旧文件不动', async () => {
    const store = createDotHistoryStore({ dir })
    await store.write(history())
    await expect(store.write({ version: 1, conversations: [{ id: 'c1' }] }))
      .rejects.toMatchObject({ statusCode: 400, reasonCode: 'dot-history-invalid' })
    expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))).toEqual(history())
  })

  it('dotHistoryProblem 只看顶层和每个对话的 id/turns', () => {
    expect(dotHistoryProblem(history())).toBeNull()
    expect(dotHistoryProblem({ version: 2, conversations: [] })).toBe('version 必须是 1')
    expect(dotHistoryProblem({ version: 1 })).toBe('conversations 必须是数组')
    expect(dotHistoryProblem([])).toBe('顶层必须是对象')
  })
})

describe('GET/PUT /dot/history', () => {
  let app
  let baseUrl

  async function start(withStore = true) {
    app = createHostServer({
      opencliEntry: 'C:\\fixture\\dist\\src\\main.js',
      policy: { opencliVersion: '1.8.6', description: 'test policy', decisionByKey: new Map() },
      allowedOrigins: [origin],
      ...(withStore ? { dotHistoryStore: createDotHistoryStore({ dir: join(dir, 'dot') }) } : {}),
    })
    baseUrl = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`
  }
  const put = (body, headers = {}) => fetch(`${baseUrl}/dot/history`, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const get = (headers = { Origin: origin }) => fetch(`${baseUrl}/dot/history`, { headers })

  afterEach(async () => { await app?.close(); app = undefined })

  it('PUT 写入后 GET 读回,文件落在 <dir>/history.json', async () => {
    await start()
    expect(await (await get()).json()).toEqual({ exists: false, history: null, savedAt: null })
    const response = await put(history())
    expect(response.status).toBe(200)
    expect(await (await get()).json()).toMatchObject({ exists: true, history: history() })
    expect(JSON.parse(readFileSync(join(dir, 'dot', 'history.json'), 'utf8'))).toEqual(history())
  })

  it('结构校验失败返回 400,文件损坏时 GET 返回 500', async () => {
    await start()
    const invalid = await put({ version: 1, conversations: 'x' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ reasonCode: 'dot-history-invalid' })

    mkdirSync(join(dir, 'dot'), { recursive: true })
    writeFileSync(join(dir, 'dot', 'history.json'), 'garbage')
    const corrupt = await get()
    expect(corrupt.status).toBe(500)
    expect(await corrupt.json()).toMatchObject({ reasonCode: 'dot-history-corrupt' })
  })

  it('Origin 不在白名单时 403;没有接入存储时 503', async () => {
    await start()
    expect((await get({ Origin: 'http://evil.example' })).status).toBe(403)
    expect((await put(history(), { Origin: 'http://evil.example' })).status).toBe(403)
    await app.close()
    await start(false)
    expect((await get()).status).toBe(503)
  })
})
