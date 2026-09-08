// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ensureWrssSourcePatches } from './wrss-patches.mjs'
import {
  wrssPinBundle,
  wrssPinPython,
  wrssPinQrcode,
  wrssPinSuccess,
  wrssPinWechatStatus,
} from '../test-fixtures/wrss-pin.mjs'

function fixture(python = wrssPinPython) {
  const root = mkdtempSync(join(tmpdir(), 'wrss-source-patch-'))
  mkdirSync(join(root, 'static', 'assets'), { recursive: true })
  mkdirSync(join(root, 'driver'), { recursive: true })
  mkdirSync(join(root, 'apis'), { recursive: true })
  const bundlePath = join(root, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(root, 'driver', 'wx.py')
  const successPath = join(root, 'driver', 'success.py')
  const wechatStatusPath = join(root, 'static', 'assets', 'WechatStatus.62cf3d3b.js')
  const authApiPath = join(root, 'apis', 'auth.py')
  writeFileSync(bundlePath, wrssPinBundle)
  writeFileSync(driverPath, python)
  writeFileSync(successPath, wrssPinSuccess)
  writeFileSync(wechatStatusPath, wrssPinWechatStatus)
  writeFileSync(authApiPath, 'router = object()\n')
  return { root, bundlePath, driverPath, successPath, wechatStatusPath, authApiPath }
}

function wxLoginProbe(driverPath, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'wrss-wx-login-probe-'))
  const script = join(root, 'probe.py')
  const image = join(root, 'qr.png')
  writeFileSync(script, String.raw`
import asyncio as real_asyncio, base64, json, os, sys, types

driver_path, scenario, image_path = sys.argv[1:]

class Clock:
    now = 0
    def time(self): return self.now
    def monotonic(self): return self.now
clock = Clock()

async def sleep(seconds):
    clock.now += 60
    if scenario == "scanned" and clock.now >= 120:
        subject._qr_cancelled = True

class Lock:
    def acquire(self): pass
    def release(self): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass

class Response:
    url = "https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?action=ask"
    async def json(self): return {"status": 1}

class Page:
    def __init__(self):
        self.url = "https://mp.weixin.qq.com/"
        self.gotos = 0
        self.images = []
        self.response_handler = None
    async def goto(self, *args, **kwargs): self.gotos += 1
    async def wait_for_function(self, *args, **kwargs): pass
    def locator(self, selector): return self
    async def evaluate(self, expression):
        pixels = ("image-%d" % self.gotos).encode()
        self.images.append(pixels.decode())
        if scenario == "scanned" and self.response_handler:
            await self.response_handler(Response())
        if scenario == "refresh" and self.gotos >= 2:
            subject._qr_cancelled = True
        return base64.b64encode(pixels).decode()
    def on(self, event, handler): self.response_handler = handler

class Driver:
    def __init__(self): self.page = Page()
    async def start_browser(self): pass

namespace = {
    "time": clock, "os": os, "PlaywrightController": Driver,
    "print_warning": lambda *args: None, "print_error": lambda *args: None,
    "print_info": lambda *args: None,
}
source = open(driver_path, encoding="utf-8").read()
exec(compile(source, driver_path, "exec"), namespace)
subject = namespace["WxLogin"]()
subject.WX_LOGIN = "https://mp.weixin.qq.com/login"
subject.WX_HOME = "https://mp.weixin.qq.com/home"
subject.wx_login_url = image_path
subject.Notice = None
subject.SESSION = None
subject._login_lock = Lock()
subject.check_lock = lambda: False
subject.set_lock = lambda: None
subject.cleanup_resources = lambda: None
subject.release_lock = lambda: None
subject.Clean = lambda: None
async def close(): pass
subject.Close = close

real_asyncio.sleep = sleep
real_asyncio.run(subject.wxLogin(NeedExit=False))
print(json.dumps({
    "gotos": subject.controller.page.gotos,
    "images": subject.controller.page.images,
    "saved": open(image_path, "rb").read().decode(),
    "scanned": subject._qr_scanned,
}))
`)
  const bundled = fileURLToPath(new URL('../artifacts/wrss-startup-probe/home/wrss/versions/py/Scripts/python.exe', import.meta.url))
  const executable = existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python.exe' : 'python3'
  const result = spawnSync(executable, [script, driverPath, scenario, image], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
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
    QRCode: () => client.qrCode(), checkQRCodeStatus: (onUpdate) => client.checkStatus(onUpdate),
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
    const { root, bundlePath, driverPath, successPath, wechatStatusPath } = fixture(wrssPinPython.replace(/\r?\n/g, '\r\n'))
    ensureWrssSourcePatches(root)
    const files = [bundlePath, driverPath, successPath, wechatStatusPath, join(root, 'static', 'pussycat-auth.js')]
    const first = files.map((file) => readFileSync(file))
    const bundle = first[0].toString()
    expect(bundle).toContain('return o({startAuth:g})')
    expect(bundle).toContain('已扫码，请在手机上点击确认')
    expect(bundle).toContain('pussycat-qr-countdown')
    expect(bundle).not.toContain('axios$1.head')
    const methods = { qrCode: vi.fn(() => 'qr'), checkStatus: vi.fn(() => 'status') }
    const authSource = bundle.slice(0, bundle.indexOf('refreshToken='))
    const result = vm.runInNewContext(`${authSource}unused=0;[QRCode(),checkQRCodeStatus()]`, { window: { __PUSSYCAT_WRSS_AUTH__: methods } })
    expect([...result]).toEqual(['qr', 'status'])
    ensureWrssSourcePatches(root)
    for (const [index, file] of files.entries()) {
      expect(readFileSync(file)).toEqual(first[index])
    }
    expect(first[1].toString().replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('restores only uninitialized login state from complete unexpired persisted credentials', () => {
    const { root, successPath } = fixture()
    ensureWrssSourcePatches(root)
    const python = readFileSync(successPath, 'utf8')
    expect(python).toContain('WX_LOGIN_ED = None')
    expect(python).toContain("token_data.get('cookie')")
    expect(python).toContain("expiry.get('expiry_timestamp')")
    expect(python).toContain('expiry_timestamp >= time.time()')
    expect(python).not.toContain("'remaining_seconds' in expiry")
    expect(python).toContain('if WX_LOGIN_ED is False:\n            return False')
    expect(python).toContain('def CanGetToken():')
    expect(python).toContain('if not getStatus():')
  })

  it('shares the App login state with WechatStatus and refreshes it after QR success', () => {
    const { root, bundlePath, wechatStatusPath } = fixture()
    ensureWrssSourcePatches(root)
    const bundle = readFileSync(bundlePath, 'utf8')
    const status = readFileSync(wechatStatusPath, 'utf8')
    expect(bundle).toContain('const w=ref({username:"",avatar:""}),_=ref(!1),')
    expect(bundle).toContain('g=async()=>{await P(),Message.success')
    expect(bundle).toContain('provide("pussycatWechatAuth",{login:_,info:y,refresh:P})')
    expect(status).toContain('const {login:m,info:o,refresh:y}=H("pussycatWechatAuth")')
    expect(status).not.toContain('m=h(!1),o=h(null)')
    expect(status).toContain('return J(()=>{y()})')
  })

  it('uses original QR pixels and refreshes only before scanning', () => {
    const { root, driverPath } = fixture()
    ensureWrssSourcePatches(root)
    const python = readFileSync(driverPath, 'utf8')
    expect(python).toContain('wait_until="domcontentloaded", timeout=20000')
    expect(python).toContain('timeout=15000')
    expect(python).toContain('canvas.width = img.naturalWidth')
    expect(python).toContain('time.time() + 60')
    expect(python).toContain('if not self._qr_scanned and time.time() >= self._qr_expires_at:')
    expect(python).toContain('await load_qr()')
    expect(python).toContain('await self.Call_Success()')
    expect(python).not.toContain('wait_for_event("framenavigated"')
    expect(python).not.toContain('networkidle')
    const predicate = python.match(/"(selector => \{[^\n]+\})"/)[1]
    const ready = (image) => vm.runInNewContext(`(${predicate})('qr')`, { document: { querySelector: () => image } })
    expect(ready(null)).toBeFalsy()
    expect(ready({ complete: false, naturalWidth: 180 })).toBe(false)
    expect(ready({ complete: true, naturalWidth: 0 })).toBe(false)
    expect(ready({ complete: true, naturalWidth: 180 })).toBe(true)
    expect(python).toContain('finally:')
    expect(python).toContain('await self.Close()')
  })

  it('navigates again after 60 seconds and replaces the QR image', () => {
    const { root, driverPath } = fixture()
    ensureWrssSourcePatches(root)
    const result = wxLoginProbe(driverPath, 'refresh')
    expect(result.gotos).toBe(2)
    expect(result.images).toEqual(['image-1', 'image-2'])
    expect(result.saved).toBe('image-2')
  })

  it('freezes the QR image after the scan response is observed', () => {
    const { root, driverPath } = fixture()
    ensureWrssSourcePatches(root)
    const result = wxLoginProbe(driverPath, 'scanned')
    expect(result.scanned).toBe(true)
    expect(result.gotos).toBe(1)
    expect(result.images).toEqual(['image-1'])
    expect(result.saved).toBe('image-1')
  })

  it('patches WeChat logout to clear persistent and shared login state', () => {
    const { root, authApiPath } = fixture()
    ensureWrssSourcePatches(root)
    const python = readFileSync(authApiPath, 'utf8')
    expect(python).toContain('@router.post("/wechat/logout"')
    expect(python).toContain('_save_to_local({})')
    expect(python).toContain('redis_client._client.delete(REDIS_TOKEN_PREFIX + "data")')
    expect(python).toContain('Store.save([])')
    expect(python).toContain('setStatus(False)')
    expect(python).toContain('WX_API._qr_login_complete = False')
    expect(python).toContain('WX_API.SESSION = None')
  })

  it('does not show sponsorship on the first visit but keeps the manual entry', () => {
    const { root, bundlePath } = fixture()
    ensureWrssSourcePatches(root)
    const values = new Map()
    const state = vm.runInNewContext(`(()=>{${setupSource(readFileSync(bundlePath, 'utf8'), 'App')};return {c,d}})()`, {
      ref: (value) => ({ value }), computed: () => ({}), provide() {}, onBeforeUnmount() {},
      useRouter: () => ({}), useRoute: () => ({}), console: { log() {} },
      window: { __PUSSYCAT_WRSS_AUTH__: { bindStatus() {} }, addEventListener() {} },
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
