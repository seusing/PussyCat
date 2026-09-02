// @vitest-environment node
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function response(data) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(fetchImpl) {
  const fetch = vi.fn(fetchImpl)
  const context = vm.createContext({
    fetch, AbortController, DOMException, URL, Date, console,
    setTimeout, clearTimeout,
    localStorage: { getItem: (key) => key === 'token' ? 'fixture-token' : null },
    location: { origin: 'http://127.0.0.1:43202', href: 'http://127.0.0.1:43202/configs' },
  })
  context.window = context
  vm.runInContext(readFileSync(new URL('./wrss-auth.js', import.meta.url), 'utf8'), context)
  return { auth: context.__PUSSYCAT_WRSS_AUTH__, fetch }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('WeRSS authorization client', () => {
  it('returns an existing QR image immediately with same-origin authorization', async () => {
    const { auth, fetch } = harness(async () => response({ code: 'static/wx_qrcode.png?t=1', is_exists: true }))
    const result = await auth.qrCode()
    expect(result.code).toBe('/static/wx_qrcode.png?t=1')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/v1/wx/auth/qr/code', expect.objectContaining({
      credentials: 'same-origin', cache: 'no-store',
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
      signal: expect.any(AbortSignal),
    }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks image readiness immediately and then every 250ms without overlapping requests', async () => {
    const pending = deferred()
    let imageCalls = 0
    const { auth, fetch } = harness(async (url) => {
      if (url.endsWith('/code')) return response({ code: '/static/wx_qrcode.png', is_exists: false })
      imageCalls += 1
      if (imageCalls === 1) return pending.promise
      return response(imageCalls > 2)
    })
    const ready = auth.qrCode()
    await vi.advanceTimersByTimeAsync(0)
    expect(imageCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(imageCalls).toBe(1)
    pending.resolve(response(false))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(249)
    expect(imageCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(imageCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(250)
    await expect(ready).resolves.toMatchObject({ code: '/static/wx_qrcode.png' })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts the locked-login response without is_exists and uses image readiness', async () => {
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: 'static/wx_qrcode.png?t=2', msg: 'running' } : true))
    await expect(auth.qrCode()).resolves.toMatchObject({ code: '/static/wx_qrcode.png?t=2' })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/wx/auth/qr/code', '/api/v1/wx/auth/qr/image'])
  })

  it('times out QR readiness after 45 seconds and stops all polling', async () => {
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: '/static/wx_qrcode.png', is_exists: false } : false))
    const outcome = auth.qrCode().catch((error) => error)
    await vi.advanceTimersByTimeAsync(45_000)
    expect((await outcome).message).toMatch(/超时/)
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a pending request on cancel and does not poll after a late response', async () => {
    const pending = deferred()
    const { auth, fetch } = harness(() => pending.promise)
    const outcome = auth.qrCode().catch((error) => error)
    const signal = fetch.mock.calls[0][1].signal
    auth.cancel()
    expect(signal.aborted).toBe(true)
    pending.resolve(response({ code: '/static/wx_qrcode.png', is_exists: false }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await outcome).name).toBe('AbortError')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a readiness delay and allows a fresh attempt', async () => {
    let ready = false
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: '/static/wx_qrcode.png', is_exists: ready } : false))
    const first = auth.qrCode().catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    auth.cancel()
    expect((await first).name).toBe('AbortError')
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(count)
    ready = true
    await expect(auth.qrCode()).resolves.toMatchObject({ code: '/static/wx_qrcode.png' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queries status immediately and waits one second between completed requests', async () => {
    const pending = deferred()
    let statusCalls = 0
    const { auth } = harness(async (url) => {
      if (url.endsWith('/code')) return response({ code: '/static/wx_qrcode.png', is_exists: true })
      statusCalls += 1
      return statusCalls === 1 ? pending.promise : response({ login_status: true, qr_code: true })
    })
    await auth.qrCode()
    const outcome = auth.checkStatus()
    expect(statusCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(statusCalls).toBe(1)
    pending.resolve(response({ login_status: false, qr_code: true }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(statusCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toMatchObject({ login_status: true })
    expect(statusCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels status polling when closed', async () => {
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: '/static/wx_qrcode.png', is_exists: true } : { login_status: false, qr_code: true }))
    await auth.qrCode()
    const outcome = auth.checkStatus().catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    auth.cancel()
    expect((await outcome).name).toBe('AbortError')
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out status after five minutes', async () => {
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: '/static/wx_qrcode.png', is_exists: true } : { login_status: false, qr_code: true }))
    await auth.qrCode()
    const outcome = auth.checkStatus().catch((error) => error)
    await vi.advanceTimersByTimeAsync(300_000)
    expect((await outcome).message).toMatch(/超时|过期/)
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates request errors and expired QR status without retrying silently', async () => {
    const offline = new Error('offline')
    const first = harness(async () => { throw offline })
    await expect(first.auth.qrCode()).rejects.toBe(offline)
    expect(vi.getTimerCount()).toBe(0)
    const second = harness(async (url) => response(url.endsWith('/code')
      ? { code: '/static/wx_qrcode.png', is_exists: true } : { login_status: false, qr_code: false }))
    await second.auth.qrCode()
    await expect(second.auth.checkStatus()).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
