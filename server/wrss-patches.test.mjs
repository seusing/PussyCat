// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ensureWrssSourcePatches } from './wrss-patches.mjs'
import { wrssPinBundle, wrssPinPython, wrssPinQrcode } from '../test-fixtures/wrss-pin.mjs'

function fixture(python = wrssPinPython) {
  const root = mkdtempSync(join(tmpdir(), 'wrss-source-patch-'))
  mkdirSync(join(root, 'static', 'assets'), { recursive: true })
  mkdirSync(join(root, 'driver'), { recursive: true })
  const bundlePath = join(root, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(root, 'driver', 'wx.py')
  writeFileSync(bundlePath, wrssPinBundle)
  writeFileSync(driverPath, python)
  return { root, bundlePath, driverPath }
}

function setupSource(bundle, name) {
  const file = ts.createSourceFile('pin.js', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let body
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'defineComponent') {
      const config = node.arguments[0]
      if (ts.isObjectLiteralExpression(config) && config.properties.some((prop) => prop.name?.getText(file) === '__name' && prop.initializer?.text === name)) {
        body = config.properties.find((prop) => prop.name?.getText(file) === 'setup').body
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!body) throw new Error(`Missing setup for ${name}`)
  const statements = [...body.statements]
  const returned = statements.pop()
  if (!ts.isReturnStatement(returned)) throw new Error(`Missing render return for ${name}`)
  return statements.map((statement) => statement.getText(file)).join('\n')
}

function component(bundle, client) {
  const emitted = vi.fn()
  const cleanup = []
  const context = {
    ref: (value) => ({ value }), s: emitted,
    QRCode: () => client.qrCode(), checkQRCodeStatus: () => client.checkStatus(),
    window: { __PUSSYCAT_WRSS_AUTH__: client }, onBeforeUnmount: (callback) => cleanup.push(callback),
  }
  const state = vm.runInNewContext(`(()=>{${setupSource(bundle, 'WechatAuthQrcode')};return {c,d,u,A,g,f}})()`, context)
  return { state, emitted, cleanup }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('WeRSS pinned source patches', () => {
  it('patches real pinned source idempotently and preserves the complete QR render function', () => {
    const { root, bundlePath, driverPath } = fixture(wrssPinPython.replace(/\r?\n/g, '\r\n'))
    ensureWrssSourcePatches(root)
    const first = [bundlePath, driverPath, join(root, 'static', 'pussycat-auth.js')].map((file) => readFileSync(file))
    const bundle = first[0].toString()
    const render = wrssPinQrcode.slice(wrssPinQrcode.indexOf('return o({startAuth:g})'))
    expect(bundle).toContain(render)
    expect(bundle).not.toContain('axios$1.head')
    const methods = { qrCode: vi.fn(() => 'qr'), checkStatus: vi.fn(() => 'status') }
    const authSource = bundle.slice(0, bundle.indexOf('refreshToken='))
    const result = vm.runInNewContext(`${authSource}unused=0;[QRCode(),checkQRCodeStatus()]`, { window: { __PUSSYCAT_WRSS_AUTH__: methods } })
    expect([...result]).toEqual(['qr', 'status'])
    ensureWrssSourcePatches(root)
    for (const [index, file] of [bundlePath, driverPath, join(root, 'static', 'pussycat-auth.js')].entries()) {
      expect(readFileSync(file)).toEqual(first[index])
    }
    expect(first[1].toString().replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('waits for a loaded QR image with bounded navigation and screenshot timeouts', () => {
    const { root, driverPath } = fixture()
    ensureWrssSourcePatches(root)
    const python = readFileSync(driverPath, 'utf8')
    expect(python).toContain('wait_until="domcontentloaded", timeout=20000')
    expect(python).toContain('timeout=15000')
    expect(python).toContain('qrcode.screenshot(path=self.wx_login_url, timeout=5000)')
    expect(python).not.toContain('networkidle')
    const predicate = python.match(/"(selector => \{[^\n]+\})"/)[1]
    const ready = (image) => vm.runInNewContext(`(${predicate})('qr')`, { document: { querySelector: () => image } })
    expect(ready(null)).toBeFalsy()
    expect(ready({ complete: false, naturalWidth: 180 })).toBe(false)
    expect(ready({ complete: true, naturalWidth: 0 })).toBe(false)
    expect(ready({ complete: true, naturalWidth: 180 })).toBe(true)
    const unchangedTail = wrssPinPython.slice(wrssPinPython.indexOf('            print("二维码已保存'))
    expect(python).toContain(unchangedTail)
  })

  it('does not show sponsorship on the first visit but keeps the manual entry', () => {
    const { root, bundlePath } = fixture()
    ensureWrssSourcePatches(root)
    const values = new Map()
    const state = vm.runInNewContext(`(()=>{${setupSource(readFileSync(bundlePath, 'utf8'), 'App')};return {c,d}})()`, {
      ref: (value) => ({ value }), computed: () => ({}), provide() {},
      useRouter: () => ({}), useRoute: () => ({}), console: { log() {} },
      localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    })
    expect(state.c.value).toBe(false)
    const event = { preventDefault: vi.fn() }
    state.d(event)
    expect(state.c.value).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('ignores a late preparation error after close and cancels on unmount', async () => {
    const { root, bundlePath } = fixture()
    ensureWrssSourcePatches(root)
    const pending = deferred()
    const client = { qrCode: vi.fn(() => pending.promise), checkStatus: vi.fn(), cancel: vi.fn() }
    const { state, emitted, cleanup } = component(readFileSync(bundlePath, 'utf8'), client)
    const running = state.g()
    expect(state.c.value).toBe(true)
    state.c.value = false
    state.f()
    pending.reject(new Error('late response'))
    await running
    expect(state.c.value).toBe(false)
    expect(state.A.value).toBe('')
    expect(emitted).not.toHaveBeenCalled()
    expect(client.checkStatus).not.toHaveBeenCalled()
    cleanup[0]()
    expect(client.cancel).toHaveBeenCalledTimes(2)
  })

  it('keeps the modal open on error and retries with a new QR result', async () => {
    const { root, bundlePath } = fixture()
    ensureWrssSourcePatches(root)
    const status = deferred()
    const client = {
      qrCode: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ code: '/fresh.png' }),
      checkStatus: vi.fn(() => status.promise), cancel: vi.fn(),
    }
    const { state, emitted } = component(readFileSync(bundlePath, 'utf8'), client)
    await state.g()
    expect(state.c.value).toBe(true)
    expect(state.d.value).toBe(false)
    expect(state.u.value).toBe('')
    expect(state.A.value).toBe('offline')
    const retry = state.g()
    await new Promise(setImmediate)
    expect(state.A.value).toBe('')
    expect(state.u.value).toBe('/fresh.png')
    status.resolve({ login_status: true })
    await retry
    expect(state.c.value).toBe(false)
    expect(emitted).toHaveBeenLastCalledWith('success', { login_status: true })
  })

  it('does not let a stale status response close a newer session', async () => {
    const { root, bundlePath } = fixture()
    ensureWrssSourcePatches(root)
    const oldStatus = deferred(), newStatus = deferred()
    const client = {
      qrCode: vi.fn().mockResolvedValueOnce({ code: '/old.png' }).mockResolvedValueOnce({ code: '/new.png' }),
      checkStatus: vi.fn().mockImplementationOnce(() => oldStatus.promise).mockImplementationOnce(() => newStatus.promise),
      cancel: vi.fn(),
    }
    const { state, emitted } = component(readFileSync(bundlePath, 'utf8'), client)
    const first = state.g()
    await new Promise(setImmediate)
    state.c.value = false
    state.f()
    const second = state.g()
    await new Promise(setImmediate)
    oldStatus.resolve({ login_status: true })
    await first
    expect(state.c.value).toBe(true)
    expect(state.u.value).toBe('/new.png')
    expect(emitted).not.toHaveBeenCalled()
    newStatus.reject(new Error('expired'))
    await second
    expect(state.c.value).toBe(true)
    expect(state.u.value).toBe('')
    expect(state.A.value).toBe('expired')
  })
})
