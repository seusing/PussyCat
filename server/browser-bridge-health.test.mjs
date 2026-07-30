// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkBrowserBridgeHealth } from './browser-bridge-health.mjs'

const V = '1.8.6'
const at = () => 1234

/** daemon 的 /status 真实形状(dist/src/daemon.js:222-236),字段名逐字照抄。 */
function daemonStatus(over = {}) {
  return {
    ok: true,
    pid: 4242,
    uptime: 91.5,
    daemonVersion: '1.8.6',
    extensionConnected: true,
    extensionVersion: '0.9.1',
    extensionCompatRange: '>=0.9.0',
    contextId: 'ctx-abc123',
    profileRequired: false,
    profileDisconnected: false,
    profiles: [{ contextId: 'ctx-abc123', extensionConnected: true, extensionVersion: '0.9.1', pending: 0, lastSeenAt: 1700000000000 }],
    pending: 0,
    commandResultUnknown: 0,
    memoryMB: 61.3,
    port: 19825,
    ...over,
  }
}

const okFetch = (body, { status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const check = (fetchImpl) => checkBrowserBridgeHealth({ fetchImpl, opencliVersion: V, now: at })

describe('BrowserBridge 健康诊断', () => {
  it('一切就绪 → daemon running / extension connected / profile ready / 不必重试', async () => {
    const health = await check(okFetch(daemonStatus()))
    expect(health.daemon).toBe('running')
    expect(health.extension).toBe('connected')
    expect(health.profile).toBe('ready')
    expect(health.reasonCode).toBe('ok')
    expect(health.retryable).toBe(false)
    expect(health.daemonVersion).toBe('1.8.6')
    expect(health.extensionVersion).toBe('0.9.1')
    expect(health.opencliVersion).toBe(V)
    expect(health.profileCount).toBe(1)
    expect(health.checkedAt).toBe(1234)
  })

  it('扩展未连上 → extension-disconnected,可重试(去点一下扩展就好)', async () => {
    const health = await check(okFetch(daemonStatus({ extensionConnected: false, extensionVersion: undefined })))
    expect(health.daemon).toBe('running')
    expect(health.extension).toBe('disconnected')
    expect(health.profile).toBe('unknown')
    expect(health.reasonCode).toBe('extension-disconnected')
    expect(health.retryable).toBe(true)
  })

  it('多 profile 需指定 → profile-required', async () => {
    const health = await check(okFetch(daemonStatus({ profileRequired: true })))
    expect(health.profile).toBe('required')
    expect(health.reasonCode).toBe('profile-required')
    expect(health.retryable).toBe(true)
  })

  it('指定 profile 掉线 → profile-disconnected', async () => {
    const health = await check(okFetch(daemonStatus({ profileDisconnected: true })))
    expect(health.profile).toBe('disconnected')
    expect(health.reasonCode).toBe('profile-disconnected')
  })

  it('连不上(ECONNREFUSED) → daemon-stopped,不抛异常', async () => {
    const health = await check(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }) })
    expect(health.daemon).toBe('stopped')
    expect(health.reasonCode).toBe('daemon-stopped')
    expect(health.retryable).toBe(true)
    expect(health.extension).toBe('unknown')
  })

  it('超时与连不上必须分开 —— 前者是 daemon 在但没响应,下一步动作不同', async () => {
    const health = await check(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) })
    expect(health.daemon).toBe('unreachable')
    expect(health.reasonCode).toBe('daemon-unreachable')
  })

  it('非 200 → daemon-error', async () => {
    const health = await check(okFetch({}, { status: 503 }))
    expect(health.daemon).toBe('error')
    expect(health.reasonCode).toBe('daemon-error')
    expect(health.summary).toContain('503')
  })

  it('响应不是合法 JSON → daemon-error,不抛', async () => {
    const health = await check(async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') },
    }))
    expect(health.reasonCode).toBe('daemon-error')
  })

  it('响应是数组/标量等异常形状 → daemon-error', async () => {
    expect((await check(okFetch([1, 2]))).reasonCode).toBe('daemon-error')
    expect((await check(okFetch(null))).reasonCode).toBe('daemon-error')
  })

  // ——— 这一组是本模块存在的安全理由,不是附加 ———————————————————————
  it('**不泄露本机标识与浏览器 profile 标识** —— pid/port/memoryMB/contextId/profiles 一律不出现', async () => {
    const health = await check(okFetch(daemonStatus()))
    const serialized = JSON.stringify(health)
    // 逐个 key 单独断言:塞进一个循环的话第一条失败就看不见后面哪些也漏了。
    expect(Object.keys(health)).not.toContain('pid')
    expect(Object.keys(health)).not.toContain('port')
    expect(Object.keys(health)).not.toContain('memoryMB')
    expect(Object.keys(health)).not.toContain('contextId')
    expect(Object.keys(health)).not.toContain('profiles')
    expect(Object.keys(health)).not.toContain('uptime')
    // 值也不许以任何形式漏出(比如被塞进 summary 或嵌套结构)
    expect(serialized).not.toContain('ctx-abc123')
    expect(serialized).not.toContain('4242')
    expect(serialized).not.toContain('19825')
    expect(serialized).not.toContain('1700000000000')
  })

  it('**投影而非透传** —— daemon 将来新增的字段(含假想的凭据字段)一律流不到前端', async () => {
    // 这条钉的是实现手法:一旦有人把 projectStatus 改成 `...status` 展开,它立刻红。
    // daemon 今天的 /status 不含 cookie/token(已核 daemon.js:207-237),但白名单必须是
    // **正向枚举**,不能依赖「上游现在恰好没有敏感字段」这个会过期的事实。
    const health = await check(okFetch(daemonStatus({
      cookies: [{ name: 'SESSDATA', value: 'super-secret' }],
      authToken: 'tok_live_zzz',
      accountName: '张三',
      futureField: 'whatever',
    })))
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('tok_live_zzz')
    expect(serialized).not.toContain('张三')
    expect(serialized).not.toContain('futureField')
    expect(Object.keys(health)).not.toContain('cookies')
    expect(Object.keys(health)).not.toContain('authToken')
    // 正向控制:该出现的仍然出现,证明上面几条不是在一个空对象上平凡成立。
    expect(health.reasonCode).toBe('ok')
    expect(health.daemonVersion).toBe('1.8.6')
  })

  it('请求带 X-OpenCLI 头且打 daemon 的 /status —— 不带头 daemon 直接 403', async () => {
    let seen
    await checkBrowserBridgeHealth({
      opencliVersion: V,
      fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => daemonStatus() } },
    })
    expect(seen.url).toBe('http://127.0.0.1:19825/status')
    expect(seen.init.headers['X-OpenCLI']).toBe('1')
    expect(seen.init.signal).toBeDefined()
  })
})
