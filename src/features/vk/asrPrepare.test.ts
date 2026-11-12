const importFresh = async () => {
  vi.resetModules()
  return import('./asrPrepare')
}

describe('requestAsrPrepareOnce', () => {
  it('一个应用会话只发一次,发的是引擎的预加载路由', async () => {
    const fetchMock = vi.fn(async () => Response.json({ state: 'loading' }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const { requestAsrPrepareOnce } = await importFresh()

    requestAsrPrepareOnce('http://host')
    requestAsrPrepareOnce('http://host')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host/vk/v1/asr/prepare')
    expect(init.method).toBe('POST')
  })

  it('请求失败静默,也不会因此重发', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: '引擎没有响应' }, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { requestAsrPrepareOnce } = await importFresh()

    expect(() => requestAsrPrepareOnce('http://host')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    requestAsrPrepareOnce('http://host')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网络出错同样静默', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network'))))
    const { requestAsrPrepareOnce } = await importFresh()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    requestAsrPrepareOnce('http://host')
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
  })
})
