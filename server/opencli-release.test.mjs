// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { checkOpencliRelease } from './opencli-release.mjs'

const NPMJS = 'registry.npmjs.org'
const MIRROR = 'registry.npmmirror.com'
const urlOf = (host) => `https://${host}/@jackwener/opencli/latest`

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

// 按请求的 host 分派响应;每个值是返回 Promise<Response> 的函数。
function registries({ [NPMJS]: npmjs, [MIRROR]: mirror }) {
  const handlers = { [NPMJS]: npmjs, [MIRROR]: mirror }
  return vi.fn(async (url, init) => handlers[new URL(url).host](init))
}
const both = (respond) => registries({ [NPMJS]: respond, [MIRROR]: respond })
const reject = (error) => async () => { throw error }
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const refusedError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

describe('checkOpencliRelease', () => {
  it('上游有新版时返回完整结果', async () => {
    const result = await checkOpencliRelease({
      currentVersion: '1.8.6',
      fetchImpl: both(async () => json({ version: '1.8.8' })),
      now: () => 1234,
    })

    expect(result).toEqual({
      checkedAt: 1234,
      current: '1.8.6',
      latest: '1.8.8',
      updateAvailable: true,
      releaseUrl: 'https://github.com/jackwener/opencli/releases/tag/v1.8.8',
    })
  })

  it('两个源都被请求,且各带超时 signal', async () => {
    const fetchImpl = both(async () => json({ version: '1.8.8' }))
    await checkOpencliRelease({ currentVersion: '1.8.6', fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([urlOf(NPMJS), urlOf(MIRROR)])
    for (const [, init] of fetchImpl.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['相同版本', '1.8.6', '1.8.6', false],
    ['本地比上游新', '1.9.0', '1.8.8', false],
    ['按数值而不是字符串比较', '1.8.9', '1.8.10', true],
    ['主版本更大', '1.8.6', '2.0.0', true],
    ['上游是预发布版本', '1.8.6', '1.9.0-beta.1', false],
    ['本地是预发布版本', '1.9.0-beta.1', '1.9.0', false],
  ])('%s:%s → %s 时 updateAvailable 为 %s', async (_name, current, latest, expected) => {
    const result = await checkOpencliRelease({ currentVersion: current, fetchImpl: both(async () => json({ version: latest })) })
    expect(result.updateAvailable).toBe(expected)
    expect(result.latest).toBe(latest)
  })

  it('取先成功的那个源', async () => {
    let releaseNpmjs
    const slowNpmjs = () => new Promise((resolve) => { releaseNpmjs = () => resolve(json({ version: '1.8.9' })) })
    const fetchImpl = registries({ [NPMJS]: slowNpmjs, [MIRROR]: async () => json({ version: '1.8.8' }) })

    const result = await checkOpencliRelease({ currentVersion: '1.8.6', fetchImpl })
    releaseNpmjs()

    expect(result.latest).toBe('1.8.8')
  })

  describe('一个源失败,另一个成功', () => {
    const ok = async () => json({ version: '1.8.8' })

    it.each([
      ['连接被拒', reject(refusedError())],
      ['超时', reject(timeoutError())],
      ['HTTP 503', async () => json({}, 503)],
      ['响应没有版本号', async () => json({ name: '@jackwener/opencli' })],
    ])('npmjs %s,npmmirror 成功', async (_name, failing) => {
      const result = await checkOpencliRelease({
        currentVersion: '1.8.6',
        fetchImpl: registries({ [NPMJS]: failing, [MIRROR]: ok }),
      })
      expect(result.latest).toBe('1.8.8')
      expect(result.updateAvailable).toBe(true)
    })

    it('npmjs 成功,npmmirror 失败', async () => {
      const result = await checkOpencliRelease({
        currentVersion: '1.8.6',
        fetchImpl: registries({ [NPMJS]: ok, [MIRROR]: reject(refusedError()) }),
      })
      expect(result.latest).toBe('1.8.8')
    })

    it('npmjs 请求挂起到超时,npmmirror 照样先返回', async () => {
      const hang = (init) => new Promise((_resolve, rejectRequest) => {
        init.signal.addEventListener('abort', () => rejectRequest(init.signal.reason))
      })
      const result = await checkOpencliRelease({
        currentVersion: '1.8.6',
        fetchImpl: registries({ [NPMJS]: hang, [MIRROR]: ok }),
        timeoutMs: 20,
      })
      expect(result.latest).toBe('1.8.8')
    })
  })

  describe('两个源都失败', () => {
    const failure = (fetchImpl, options = {}) => checkOpencliRelease({ currentVersion: '1.8.6', fetchImpl, ...options })

    it('两个源的原因用「；」连在一起', async () => {
      await expect(failure(registries({
        [NPMJS]: reject(timeoutError()),
        [MIRROR]: reject(refusedError()),
      }))).rejects.toThrow(new Error(
        '连不上 registry.npmjs.org：请求超时（8 秒）；连不上 registry.npmmirror.com：fetch failed（ECONNREFUSED）',
      ))
    })

    it('fetch 的错误没有 cause.code 时只写 message', async () => {
      await expect(failure(both(reject(new Error('connect ETIMEDOUT')))))
        .rejects.toThrow(new Error('连不上 registry.npmjs.org：connect ETIMEDOUT；连不上 registry.npmmirror.com：connect ETIMEDOUT'))
    })

    it('fetch 抛出的不是 Error 时用 String 转成文字', async () => {
      await expect(failure(both(reject('boom'))))
        .rejects.toThrow(new Error('连不上 registry.npmjs.org：boom；连不上 registry.npmmirror.com：boom'))
    })

    it('按源报告非 2xx 与缺少版本号', async () => {
      await expect(failure(registries({
        [NPMJS]: async () => json({}, 503),
        [MIRROR]: async () => json({ name: '@jackwener/opencli' }),
      }))).rejects.toThrow(new Error('registry.npmjs.org 返回 HTTP 503；registry.npmmirror.com 的响应里没有版本号'))
    })

    it.each([
      ['version 不是字符串', JSON.stringify({ version: 188 })],
      ['响应体不是 JSON', '<html>not json</html>'],
    ])('%s时按源报告没有版本号', async (_name, body) => {
      await expect(failure(both(async () => new Response(body, { status: 200 }))))
        .rejects.toThrow(new Error('registry.npmjs.org 的响应里没有版本号；registry.npmmirror.com 的响应里没有版本号'))
    })

    it('两个源都超过 timeoutMs 时按请求超时处理', async () => {
      const hang = (init) => new Promise((_resolve, rejectRequest) => {
        init.signal.addEventListener('abort', () => rejectRequest(init.signal.reason))
      })
      await expect(failure(both(hang), { timeoutMs: 20 }))
        .rejects.toThrow(new Error('连不上 registry.npmjs.org：请求超时（0.02 秒）；连不上 registry.npmmirror.com：请求超时（0.02 秒）'))
    })
  })
})
