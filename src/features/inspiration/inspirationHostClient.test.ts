import { describe, expect, it, vi } from 'vitest'
import { HostRequestError } from '../../host/errors'
import { createHostInspirationPersistence } from './inspirationHostClient'
import { emptyInspirationLibrary } from './inspirationLibrary'

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('灵感库宿主客户端', () => {
  it('load 请求 GET /inspiration/library 并返回 exists 与 library', async () => {
    const fetchMock = vi.fn((_url: string) => reply({ exists: true, library: { version: 1, folders: [], items: [] }, savedAt: 'x' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHostInspirationPersistence('http://127.0.0.1:43117/').load()

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:43117/inspiration/library')
    expect(result).toEqual({ exists: true, library: { version: 1, folders: [], items: [] } })
  })

  it('宿主上没有文件时 exists 为 false', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply({ exists: false, library: null, savedAt: null })))
    expect(await createHostInspirationPersistence('http://h').load()).toEqual({ exists: false, library: null })
  })

  it('save 以 PUT 发送整份库', async () => {
    const fetchMock = vi.fn(() => reply({ savedAt: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    const library = emptyInspirationLibrary()

    await createHostInspirationPersistence('http://h').save(library)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://h/inspiration/library')
    expect(init).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(init.body as string)).toEqual(library)
  })

  it('宿主返回错误时抛出带状态码和 reasonCode 的 HostRequestError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply({ error: '灵感库文件无法解析', reasonCode: 'inspiration-corrupt' }, 500)))

    const failure = await createHostInspirationPersistence('http://h').load().catch((error) => error)

    expect(failure).toBeInstanceOf(HostRequestError)
    expect(failure).toMatchObject({ message: '灵感库文件无法解析', status: 500, reasonCode: 'inspiration-corrupt' })
  })

  it('连不上宿主时给出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))

    await expect(createHostInspirationPersistence('http://h').save(emptyInspirationLibrary()))
      .rejects.toThrow('无法连接爪爪本地服务，请稍后重试')
  })
})
