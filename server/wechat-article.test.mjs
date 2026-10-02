// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { undiciFetch, proxyAgents, FakeProxyAgent } = vi.hoisted(() => {
  const agents = []
  class Agent {
    constructor(url) {
      this.url = url
      agents.push(this)
    }
    destroy() { return Promise.resolve() }
  }
  return { undiciFetch: vi.fn(), proxyAgents: agents, FakeProxyAgent: Agent }
})
vi.mock('undici', () => ({ fetch: undiciFetch, ProxyAgent: FakeProxyAgent }))

const { WechatArticleError, fetchWechatArticle, requestArticleImage } = await import('./wechat-article.mjs')

const SHORT = 'https://mp.weixin.qq.com/s/5E7GNIA5qpgqPwqkxKR10w'
const LONG = 'https://mp.weixin.qq.com/s?__biz=MzA3&mid=1&idx=2&sn=f00'
const PAGE = '<html><body><div id="js_content" style="visibility: hidden"><p>正文</p></div></body></html>'
const MAX_BYTES = 10 * 1024 * 1024

const page = (body = PAGE, init = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } })

function stub(...responses) {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    return typeof next === 'function' ? next() : next
  })
}

async function failureOf(promise) {
  const error = await promise.then(() => null, (reason) => reason)
  expect(error).toBeInstanceOf(WechatArticleError)
  return error
}

afterEach(() => {
  vi.unstubAllEnvs()
  undiciFetch.mockReset()
  proxyAgents.splice(0)
})

describe('fetchWechatArticle', () => {
  it.each([SHORT, LONG])('fetches %s with browser headers and returns the page', async (url) => {
    const fetchImpl = stub(page())
    const result = await fetchWechatArticle(url, { fetchImpl })

    expect(result).toEqual({ finalUrl: url, html: PAGE })
    const [requested, init] = fetchImpl.mock.calls[0]
    expect(requested).toBe(url)
    expect(init.headers['User-Agent']).toMatch(/Chrome\/\d+/)
    expect(init.headers.Accept).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    expect(init.headers['Accept-Language']).toBe('zh-CN,zh;q=0.9')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    '',
    'not a url',
    'http://mp.weixin.qq.com/s/abc',
    'https://example.com/s/abc',
    'https://mp.weixin.qq.com.evil.example/s/abc',
    'https://user@mp.weixin.qq.com/s/abc',
    'https://mp.weixin.qq.com:8443/s/abc',
    'https://mp.weixin.qq.com/other/abc',
    'https://mp.weixin.qq.com/s/',
    'https://mp.weixin.qq.com/s?__biz=MzA3&mid=1',
  ])('rejects %j without requesting anything', async (url) => {
    const fetchImpl = stub()
    const error = await failureOf(fetchWechatArticle(url, { fetchImpl }))
    expect(error).toMatchObject({ reasonCode: 'invalid-url', statusCode: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('follows redirects inside mp.weixin.qq.com and reports the final address', async () => {
    const fetchImpl = stub(redirect('/s?__biz=MzA3&mid=1&idx=2&sn=f00'), page())
    const result = await fetchWechatArticle(SHORT, { fetchImpl })

    expect(result.finalUrl).toBe(LONG)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([SHORT, LONG])
  })

  it('reports verification-required when redirected to the captcha page without requesting it', async () => {
    const fetchImpl = stub(redirect('/mp/wappoc_appmsgcaptcha?poc_token=abc'), page('<html>验证</html>'))
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl }))

    expect(error).toMatchObject({ reasonCode: 'verification-required', statusCode: 429 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['环境异常', '<div class="weui-msg__title warn">环境异常</div><a id="js_verify">去验证</a>'],
    ['去验证', '<a id="js_verify">去验证</a>'],
  ])('reports verification-required for a page asking for %s', async (_name, body) => {
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(page(`<html><body>${body}</body></html>`)) }))
    expect(error.reasonCode).toBe('verification-required')
  })

  it('reports unavailable for pages without the article body', async () => {
    const deleted = '<html><body><div class="weui-msg__title">该内容已被发布者删除</div></body></html>'
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(page(deleted)) }))
    expect(error).toMatchObject({ reasonCode: 'unavailable', statusCode: 404 })
  })

  it.each([
    ['another host', 'https://example.com/s/abc'],
    ['a lookalike host', 'https://mp.weixin.qq.com.evil.example/s/abc'],
    ['plain http', 'http://mp.weixin.qq.com/s/abc'],
  ])('refuses a redirect to %s', async (_name, location) => {
    const fetchImpl = stub(redirect(location), page())
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl }))

    expect(error.reasonCode).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('allows at most three redirects', async () => {
    const hop = (n) => redirect(`/s/hop${n}`)
    const allowed = stub(hop(1), hop(2), hop(3), page())
    await expect(fetchWechatArticle(SHORT, { fetchImpl: allowed })).resolves.toMatchObject({ finalUrl: 'https://mp.weixin.qq.com/s/hop3' })

    const tooMany = stub(hop(1), hop(2), hop(3), hop(4), page())
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: tooMany }))
    expect(error.reasonCode).toBe('unavailable')
    expect(tooMany).toHaveBeenCalledTimes(4)
  })

  it('rejects a response that declares more than 10MB without reading it', async () => {
    const body = vi.fn()
    const oversized = new Response(new ReadableStream({ pull: body }, { highWaterMark: 0 }), { status: 200, headers: { 'content-length': String(MAX_BYTES + 1) } })
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(oversized) }))

    expect(error.reasonCode).toBe('unavailable')
    expect(body).not.toHaveBeenCalled()
  })

  it('stops reading a streamed body once it passes 10MB', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const stream = new ReadableStream({
      pull(controller) {
        sent += 1
        controller.enqueue(chunk)
      },
    })
    const error = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(new Response(stream, { status: 200 })) }))

    expect(error.reasonCode).toBe('unavailable')
    expect(sent).toBeLessThan(20)
  })

  it('accepts a page exactly at the limit', async () => {
    const filler = 'a'.repeat(MAX_BYTES - Buffer.byteLength(PAGE))
    const result = await fetchWechatArticle(SHORT, { fetchImpl: stub(page(PAGE + filler)) })
    expect(result.html).toHaveLength(PAGE.length + filler.length)
  })

  it('maps HTTP and transport failures', async () => {
    const notFound = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(new Response('', { status: 404 })) }))
    expect(notFound.reasonCode).toBe('unavailable')

    const serverError = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(new Response('', { status: 503 })) }))
    expect(serverError).toMatchObject({ reasonCode: 'network', statusCode: 502 })

    const refused = await failureOf(fetchWechatArticle(SHORT, { fetchImpl: stub(() => { throw new TypeError('fetch failed') }) }))
    expect(refused.reasonCode).toBe('network')
  })

  it('sends the request through HTTPS_PROXY when one is configured', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    undiciFetch.mockImplementation(async () => page())

    await fetchWechatArticle(SHORT)
    await fetchWechatArticle(SHORT)

    expect(undiciFetch.mock.calls[0][1].dispatcher).toBeInstanceOf(FakeProxyAgent)
    expect(proxyAgents).toHaveLength(1)
    expect(proxyAgents[0].url).toBe('http://127.0.0.1:7890')
    expect(undiciFetch.mock.calls[1][1].dispatcher).toBe(proxyAgents[0])
  })

  it('connects directly when no proxy is configured', async () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(name, '')
    undiciFetch.mockImplementation(async () => page())

    await fetchWechatArticle(SHORT)

    expect(undiciFetch.mock.calls[0][1].dispatcher).toBeUndefined()
  })
})

describe('requestArticleImage', () => {
  it.each(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mmecoa.qpic.cn'])('fetches images from %s without following redirects', async (host) => {
    const upstream = new Response('png')
    const fetchImpl = stub(upstream)

    await expect(requestArticleImage(`https://${host}/a/640?wx_fmt=png`, { fetchImpl })).resolves.toBe(upstream)
    expect(fetchImpl).toHaveBeenCalledWith(`https://${host}/a/640?wx_fmt=png`, { redirect: 'manual' })
  })

  it.each([
    '',
    'not a url',
    'https://example.com/a.png',
    'https://mmbiz.qpic.cn.evil.example/a.png',
    'https://res.wx.qq.com/a.png',
    'ftp://mmbiz.qpic.cn/a.png',
    'file:///C:/a.png',
  ])('rejects %j', async (value) => {
    const fetchImpl = stub()
    const error = await failureOf(requestArticleImage(value, { fetchImpl }))

    expect(error).toMatchObject({ statusCode: 400, reasonCode: 'article-image-url-invalid' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
