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
  const values = new Map([['token', 'fixture-token']])
  const dispatchEvent = vi.fn()
  const context = vm.createContext({
    fetch, AbortController, DOMException, URL, Date, console,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    dispatchEvent,
    setTimeout, clearTimeout,
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    location: { origin: 'http://127.0.0.1:43202', href: 'http://127.0.0.1:43202/configs' },
  })
  context.window = context
  vm.runInContext(readFileSync(new URL('./wrss-auth.js', import.meta.url), 'utf8'), context)
  return { auth: context.__PUSSYCAT_WRSS_AUTH__, fetch, dispatchEvent, values }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('WeRSS authorization client', () => {
  it('starts with an unknown login state and publishes auth state changes', () => {
    const { auth, dispatchEvent } = harness(async () => response(null))
    expect(auth.getState().login).toBeNull()
    auth.bindStatus({ login: true, info: { name: 'fixture' } })
    expect(dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'pussycat-wechat-auth-change',
      detail: expect.objectContaining({ login: true, info: { name: 'fixture' } }),
    }))
  })

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
      if (url.endsWith('/image')) {
        imageCalls += 1
        if (imageCalls === 1) return pending.promise
        return response(true)
      }
      return response({ qr_code: imageCalls > 1, version: imageCalls > 1 ? 1 : 0, expires_at: 9999999999 })
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
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/wx/auth/qr/code',
      '/api/v1/wx/auth/qr/image',
      '/api/v1/wx/auth/qr/image',
      '/api/v1/wx/auth/qr/status',
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts the locked-login response without is_exists and uses image readiness', async () => {
    const { auth, fetch } = harness(async (url) => response(url.endsWith('/code')
      ? { code: 'static/wx_qrcode.png?t=2', msg: 'running' }
      : url.endsWith('/image')
        ? true
        : { qr_code: true, version: 1, expires_at: 9999999999 }))
    await expect(auth.qrCode()).resolves.toMatchObject({ code: '/static/wx_qrcode.png?t=2' })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/wx/auth/qr/code', '/api/v1/wx/auth/qr/image', '/api/v1/wx/auth/qr/status',
    ])
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
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/wx/auth/qr/over')
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

  it('publishes each scanned and QR version update while polling status', async () => {
    const updates = []
    let statusCalls = 0
    const { auth, dispatchEvent } = harness(async (url) => {
      if (url.endsWith('/code')) return response({ code: '/static/wx_qrcode.png?v=1', is_exists: true })
      statusCalls += 1
      return response(statusCalls === 1
        ? { login_status: false, qr_code: true, scanned: true, version: 2, code: '/static/wx_qrcode.png?v=2' }
        : { login_status: true, qr_code: true, scanned: false, version: 2 })
    })
    await auth.qrCode()
    const outcome = auth.checkStatus((next) => updates.push(next))
    await vi.advanceTimersByTimeAsync(1000)
    await outcome
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ scanned: true, version: 2, code: '/static/wx_qrcode.png?v=2' })
    expect(dispatchEvent.mock.calls.some(([event]) => event.type === 'pussycat-wechat-auth-change' && event.detail.scanned === true)).toBe(true)
  })

  it('logs out WeChat without clearing the administrator token and clears shared state', async () => {
    const { auth, fetch, dispatchEvent, values } = harness(async () => response({ login: false }))
    auth.bindStatus({ login: true, info: { name: 'fixture' } })
    await expect(auth.logout()).resolves.toEqual({ login: false })
    expect(fetch).toHaveBeenLastCalledWith('/api/v1/wx/auth/wechat/logout', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      headers: { Authorization: 'Bearer fixture-token' },
    }))
    expect(values.get('token')).toBe('fixture-token')
    expect(auth.getState()).toMatchObject({ login: false, info: null, qr: null, scanned: false })
    expect(dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'pussycat-wechat-auth-change', detail: expect.objectContaining({ login: false, info: null }),
    }))
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
