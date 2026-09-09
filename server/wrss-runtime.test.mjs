// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { wrssPinBundle, wrssPinPython, wrssPinSuccess, wrssPinWechatStatus } from '../test-fixtures/wrss-pin.mjs'
import {
  extractTarGzipSecure,
  ensureWrssStaticAssets,
  WrssRuntimeManager,
  WRSS_SOURCE_FALLBACK_URL,
  WRSS_SOURCE_SHA256,
  WRSS_SOURCE_URL,
  resolveWrssConfigTemplate,
} from './wrss-runtime.mjs'

const { proxyFetch, proxyAgents, FakeProxyAgent } = vi.hoisted(() => {
  const calls = vi.fn()
  const agents = []
  class Agent {
    constructor(url) { this.url = url; agents.push(this) }
    destroy() { this.destroyed = true }
  }
  return { proxyFetch: calls, proxyAgents: agents, FakeProxyAgent: Agent }
})
vi.mock('undici', () => ({ fetch: proxyFetch, ProxyAgent: FakeProxyAgent }))

const uvSha = 'uv-sha'

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`)
  bytes.copy(header, offset)
}

function writeTarOctal(header, offset, length, value) {
  writeTarText(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function tarEntry({ name, content = '', type = '0', linkname = '' }) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  writeTarText(header, 0, 100, name)
  writeTarOctal(header, 100, 8, type === '5' ? 0o755 : 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, body.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeTarText(header, 156, 1, type)
  writeTarText(header, 157, 100, linkname)
  writeTarText(header, 257, 6, 'ustar\0')
  writeTarText(header, 263, 2, '00')
  let checksum = 0
  for (const byte of header) checksum += byte
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  const padding = Buffer.alloc((512 - body.length % 512) % 512)
  return Buffer.concat([header, body, padding])
}

function tarGzip(entries) {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]))
}

function weRssArchive({ omit = [], configName = 'config.example.yaml' } = {}) {
  const root = 'we-mp-rss-1.5.2'
  const entries = [
    { name: `${root}/`, type: '5' },
    { name: `${root}/main.py`, content: 'host="0.0.0.0"\r\nhost="0.0.0.0"\r\nprint("环境变量:")\r\nfor k,v in os.environ.items():\r\n    print(k,v)\r\n' },
    { name: `${root}/requirements.txt`, content: '' },
    { name: `${root}/${configName}`, content: 'port: 8001\n' },
    { name: `${root}/static/`, type: '5' },
    { name: `${root}/static/index.html`, content: '<html><head></head><body></body></html>' },
    { name: `${root}/static/assets/`, type: '5' },
    { name: `${root}/static/assets/index.a75a6e55.js`, content: wrssPinBundle },
    { name: `${root}/static/assets/WechatStatus.62cf3d3b.js`, content: wrssPinWechatStatus },
    { name: `${root}/driver/`, type: '5' },
    { name: `${root}/driver/wx.py`, content: wrssPinPython },
    { name: `${root}/driver/success.py`, content: wrssPinSuccess },
    { name: `${root}/docs/`, type: '5' },
    { name: `${root}/docs/主界面.png`, content: Buffer.from([1, 2, 3]) },
    { name: `${root}/docs/赞赏码.jpg`, content: Buffer.from([4, 5, 6]) },
  ]
  return tarGzip(entries.filter(({ name }) => !omit.some((suffix) => name.endsWith(suffix))))
}

function writePinSource(sourceDir) {
  mkdirSync(join(sourceDir, 'static', 'assets'), { recursive: true })
  mkdirSync(join(sourceDir, 'driver'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), wrssPinBundle)
  writeFileSync(join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js'), wrssPinWechatStatus)
  writeFileSync(join(sourceDir, 'driver', 'wx.py'), wrssPinPython)
  writeFileSync(join(sourceDir, 'driver', 'success.py'), wrssPinSuccess)
}

function expectSourcePatched(sourceDir) {
  const bundle = readFileSync(join(sourceDir, 'static', 'assets', 'index.a75a6e55.js'), 'utf8')
  expect(bundle).toContain('window.__PUSSYCAT_WRSS_AUTH__.qrCode')
  expect(bundle).toContain('window.__PUSSYCAT_WRSS_AUTH__.checkStatus')
  expect(existsSync(join(sourceDir, 'static', 'pussycat-auth.js'))).toBe(true)
  expect(readFileSync(join(sourceDir, 'static', 'index.html'), 'utf8')).toContain('/static/pussycat-auth.js')
  const python = readFileSync(join(sourceDir, 'driver', 'wx.py'), 'utf8')
  expect(python).toContain('domcontentloaded')
  expect(python).not.toContain('networkidle')
}

function writeInstalled(root) {
  const wrss = join(root, 'wrss')
  const sourceDir = join(wrss, 'versions', 'v1.5.2-1', 'src')
  const venvDir = join(wrss, 'versions', 'v1.5.2-1', 'py')
  mkdirSync(join(sourceDir, 'static'), { recursive: true })
  mkdirSync(join(venvDir, 'Scripts'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head></html>')
  writePinSource(sourceDir)
  writeFileSync(join(venvDir, 'Scripts', 'python.exe'), 'python')
  writeFileSync(join(wrss, 'receipt.json'), JSON.stringify({
    schema: 'wrss-runtime-receipt@1', version: '1.5.2', sourceDir, venvDir,
  }))
  return { wrss, sourceDir, venvDir }
}

async function fixture() {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '/tmp', 'wrss-test-'))
  const bundle = join(root, 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'uv.exe'), 'uv')
  writeFileSync(join(bundle, 'runtime-manifest.json'), JSON.stringify({ uv: { name: 'uv.exe', sha256: uvSha } }))
  return { root, bundle }
}

function ok(value = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function occurrences(text, needle) {
  return text.split(needle).length - 1
}

afterEach(() => {
  proxyFetch.mockReset()
  proxyAgents.splice(0)
})

describe('extractTarGzipSecure', () => {
  it('extracts UTF-8 documentation filenames without the Windows tar executable', async () => {
    const { root } = await fixture()
    const archive = join(root, 'wrss.tar.gz')
    const destination = join(root, 'extract')
    writeFileSync(archive, weRssArchive())

    extractTarGzipSecure(archive, destination)

    expect(readFileSync(join(destination, 'we-mp-rss-1.5.2', 'docs', '主界面.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(readFileSync(join(destination, 'we-mp-rss-1.5.2', 'docs', '赞赏码.jpg'))).toEqual(Buffer.from([4, 5, 6]))
  })

  it.each([
    { name: '../escaped.txt', type: '0', linkname: '' },
    { name: '/absolute.txt', type: '0', linkname: '' },
    { name: 'C:\\absolute.txt', type: '0', linkname: '' },
    { name: 'safe-link', type: '2', linkname: '../../escaped.txt' },
    { name: 'safe-hardlink', type: '1', linkname: '../../escaped.txt' },
  ])('rejects an unsafe archive entry before writing: $name', async (unsafeEntry) => {
    const { root } = await fixture()
    const archive = join(root, 'unsafe.tar.gz')
    const destination = join(root, 'extract')
    writeFileSync(archive, tarGzip([
      { name: 'safe/file.txt', content: 'must-not-be-written' },
      unsafeEntry,
    ]))

    expect(() => extractTarGzipSecure(archive, destination)).toThrowError(expect.objectContaining({ reasonCode: 'archive-security' }))
    expect(existsSync(join(destination, 'safe', 'file.txt'))).toBe(false)
  })
})

describe('resolveWrssConfigTemplate', () => {
  it('accepts the node template name used by some WeRSS archives', async () => {
    const { root } = await fixture()
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'config-node.yaml'), 'port: 8001\n')

    expect(resolveWrssConfigTemplate(source)).toMatchObject({ name: 'config-node.yaml' })
  })
})

describe('WrssRuntimeManager', () => {
  it('rejects a source SHA mismatch without an activation receipt', async () => {
    const { root, bundle } = await fixture()
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => weRssArchive() }))
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      sha256FileImpl: () => uvSha,
      fetchImpl,
    })
    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'sha-mismatch' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(WRSS_SOURCE_URL, { redirect: 'follow' })
    expect(manager.status().state).toBe('failed')
    expect(existsSync(join(root, 'wrss', 'receipt.json'))).toBe(false)
  })

  it('rejects an otherwise valid archive when a required runtime file is missing', async () => {
    const { root, bundle } = await fixture()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => weRssArchive({ omit: ['config.example.yaml'] }),
    }))
    const runStepImpl = vi.fn()
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      sha256FileImpl: (path) => path.endsWith('uv.exe') ? uvSha : WRSS_SOURCE_SHA256,
      fetchImpl,
      runStepImpl,
    })

    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'archive-layout' })
    expect(runStepImpl).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'wrss', 'receipt.json'))).toBe(false)
  })

  it('maps download network failures to a readable typed error', async () => {
    const { root, bundle } = await fixture()
    const nested = Object.assign(new Error('connect failed at C:\\Users\\private\\proxy.txt'), { code: 'ECONNRESET' })
    const fetchImpl = vi.fn(async () => { throw new Error('fetch failed: https://user:pass@example.test', { cause: nested }) })
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      sha256FileImpl: () => uvSha,
      fetchImpl,
    })
    await expect(manager.enable()).rejects.toMatchObject({
      reasonCode: 'download-failed', message: '公众号组件下载失败，请检查网络后重试',
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([WRSS_SOURCE_URL, WRSS_SOURCE_FALLBACK_URL])
    const log = manager.status().progress_log.join('\n')
    expect(log).toContain('code=ECONNRESET')
    expect(log).not.toContain('user:pass')
    expect(log).not.toContain('C:\\Users\\private')
  })

  it('tries both trusted URLs after non-2xx responses and then fails', async () => {
    const { root, bundle } = await fixture()
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, body: { cancel: vi.fn() } }))
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      sha256FileImpl: () => uvSha,
      fetchImpl,
    })
    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'download-failed' })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([WRSS_SOURCE_URL, WRSS_SOURCE_FALLBACK_URL])
  })

  it('keeps enable single-flight and starts only on loopback', async () => {
    const { root, bundle } = await fixture()
    const children = []
    const steps = []
    const runStepImpl = async ({ step, argv, options }) => {
      steps.push({ step, argv, options })
      if (step === 'extract') {
        const extraction = argv.at(-1)
        const source = join(extraction, 'we-mp-rss-1.5.2')
        mkdirSync(join(source, 'static'), { recursive: true })
        writeFileSync(join(source, 'main.py'), 'host="0.0.0.0"\nhost="0.0.0.0"\nprint("环境变量:")\nfor k,v in os.environ.items():\n    print(k,v)\n')
        writeFileSync(join(source, 'requirements.txt'), '')
        writeFileSync(join(source, 'config.example.yaml'), 'port: 8001\n')
        writeFileSync(join(source, 'static', 'index.html'), '<html><head></head><body></body></html>')
        writePinSource(source)
      }
      if (step === 'venv') {
        const python = join(argv.at(-1), 'Scripts')
        mkdirSync(python, { recursive: true })
        writeFileSync(join(python, 'python.exe'), 'python')
      }
    }
    const fetchImpl = async (url, options = {}) => {
      if (url === WRSS_SOURCE_URL) {
        return { ok: true, status: 200, arrayBuffer: async () => weRssArchive() }
      }
      if (url.endsWith('/api/v1/wx/auth/login')) return ok({ data: { access_token: 'access-token' } })
      return ok()
    }
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      sha256FileImpl: (path) => path.endsWith('uv.exe') ? uvSha : WRSS_SOURCE_SHA256,
      fetchImpl,
      runStepImpl,
      getPortImpl: async () => 4321,
      spawnImpl: (command, argv, options) => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.emit('close', 0) }
        children.push({ command, argv, options, child })
        return child
      },
    })
    const first = manager.enable()
    expect(manager.enable()).toBe(first)
    await expect(first).resolves.toMatchObject({ state: 'running', ui_url: 'http://127.0.0.1:4321' })
    expect(children[0].argv).toContain('-config')
    expect(children[0].argv).toContain('-init')
    expect(children[0].argv[children[0].argv.indexOf('-init') + 1]).toBe('True')
    expect(children[0].options.env.HOST).toBe('127.0.0.1')
    expect(children[0].options.env.PASSWORD).not.toBeUndefined()
    expect(steps.find((step) => step.step === 'venv').options.env.UV_PYTHON_INSTALL_DIR).toContain('wrss')
    expect(steps.find((step) => step.step === 'venv').options.env.UV_CACHE_DIR).toContain('wrss-install-')
    expect(manager.status().progress_log.join('\n')).not.toContain('access-token')
    const receipt = JSON.parse(readFileSync(join(root, 'wrss', 'receipt.json'), 'utf8'))
    expectSourcePatched(receipt.sourceDir)
    const patchedMain = readFileSync(join(receipt.sourceDir, 'main.py'), 'utf8')
    const patchedIndex = readFileSync(join(receipt.sourceDir, 'static', 'index.html'), 'utf8')
    expect(patchedMain.match(/host="127\.0\.0\.1"/g)).toHaveLength(2)
    expect(patchedMain).not.toContain('host="0.0.0.0"')
    expect(patchedMain).not.toContain('os.environ.items()')
    expect(patchedIndex).toContain('/static/pussycat-theme.css')
    expect(patchedIndex).toContain('/static/pussycat-bootstrap.js')
    expect(patchedIndex).toContain('/static/pussycat-ui.js')
    expect(existsSync(join(receipt.sourceDir, 'static', 'pussycat-theme.css'))).toBe(true)
    expect(readFileSync(join(receipt.sourceDir, 'static', 'pussycat-bootstrap.js'), 'utf8')).toContain('localStorage.setItem')
    const uiScript = readFileSync(join(receipt.sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
    expect(uiScript).toContain('__PUSSYCAT_WRSS_UI__')
    expect(uiScript).toContain('订阅与文章')
    expect(uiScript).toContain('/access-keys')
    await manager.close()
  })

  it('normalizes an alternate config template into the installed source', async () => {
    const { root, bundle } = await fixture()
    const unicodeHome = join(root, '爪爪-data')
    const runStepImpl = vi.fn(async ({ step, argv }) => {
      if (step === 'venv') {
        const python = join(argv.at(-1), 'Scripts')
        mkdirSync(python, { recursive: true })
        writeFileSync(join(python, 'python.exe'), 'python')
      }
    })
    const manager = new WrssRuntimeManager({
      home: unicodeHome,
      bundleDir: bundle,
      sha256FileImpl: (path) => path.endsWith('uv.exe') ? uvSha : WRSS_SOURCE_SHA256,
      fetchImpl: async (url) => {
        if (url === WRSS_SOURCE_URL) return { ok: true, status: 200, arrayBuffer: async () => weRssArchive({ configName: 'config-node.yaml' }) }
        if (url.endsWith('/api/v1/wx/auth/login')) return ok({ data: { access_token: 'token' } })
        return ok()
      },
      runStepImpl,
      getPortImpl: async () => 4326,
      spawnImpl: () => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
        child.kill = () => child.emit('close', 0)
        return child
      },
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })

    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    expect(manager.status().progress_log).toContain('WeRSS 源码目录复制与必需文件复核通过')
    const version = readdirSync(join(unicodeHome, 'wrss', 'versions'))[0]
    expect(readFileSync(join(unicodeHome, 'wrss', 'versions', version, 'src', 'config.example.yaml'), 'utf8'))
      .toContain('port: 8001')
    expect(readFileSync(join(unicodeHome, 'wrss', 'versions', version, 'src', 'static', 'index.html'), 'utf8'))
      .toContain('pussycat-bootstrap.js')
    expect(readFileSync(join(unicodeHome, 'wrss', 'versions', version, 'src', 'static', 'index.html'), 'utf8'))
      .toContain('pussycat-theme.css')
    expect(readFileSync(join(unicodeHome, 'wrss', 'versions', version, 'src', 'static', 'index.html'), 'utf8'))
      .toContain('pussycat-ui.js')
    await manager.close()
  })

  it('does not reinstall a valid receipt when the Python probe passes', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    const probePythonImpl = vi.fn(() => true)
    const runStepImpl = vi.fn()
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', 0)
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      probePythonImpl,
      runStepImpl,
      getPortImpl: async () => 4327,
      fetchImpl: async (url) => url.endsWith('/api/v1/wx/auth/login')
        ? ok({ data: { access_token: 'token' } })
        : ok(),
      spawnImpl: () => child,
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })

    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    expect(probePythonImpl).toHaveBeenCalledTimes(1)
    expect(runStepImpl).not.toHaveBeenCalled()
    await manager.close()
  })

  it('patches an existing installed UI theme idempotently before each start', async () => {
    const { root, bundle } = await fixture()
    const installed = writeInstalled(root)
    const indexPath = join(installed.sourceDir, 'static', 'index.html')
    writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('</head>', '<script src="https://hm.baidu.com/hm.js?975de8724ac02eb7e6d2357bb95c067d"></script><script src="/business.js"></script></head>'))
    let starts = 0
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      probePythonImpl: () => true,
      getPortImpl: async () => 4330 + starts,
      fetchImpl: async (url) => url.endsWith('/api/v1/wx/auth/login')
        ? ok({ data: { access_token: `token-${starts}` } })
        : ok(),
      spawnImpl: () => {
        starts += 1
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
        child.kill = () => child.emit('close', 0)
        return child
      },
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })

    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    await manager.close()
    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    await manager.close()

    const index = readFileSync(join(installed.sourceDir, 'static', 'index.html'), 'utf8')
    expectSourcePatched(installed.sourceDir)
    expect(index).not.toContain('hm.baidu.com/hm.js')
    expect(index).toContain('<script src="/business.js"></script>')
    expect(occurrences(index, '/static/pussycat-theme.css')).toBe(1)
    expect(occurrences(index, '/static/pussycat-bootstrap.js')).toBe(1)
    expect(occurrences(index, '/static/pussycat-ui.js')).toBe(1)
    expect(existsSync(join(installed.sourceDir, 'static', 'pussycat-theme.css'))).toBe(true)
    const themeCss = readFileSync(join(installed.sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
    expect(themeCss).toContain('.arco-menu-overflow-wrap')
    expect(themeCss).toContain('.arco-menu-overflow-sub-menu-mirror')
    expect(themeCss).toContain('.arco-menu-item[data-pussycat-path="/sys-info"]')
    expect(themeCss).toContain('background: transparent !important;')
    expect(themeCss).toContain('overflow: visible !important;')
    expect(themeCss).toContain('min-width: max-content !important;')
    expect(themeCss).toContain('.pussycat-primary-nav.arco-menu-overflow-hidden-menu-item')
    expect(themeCss).toContain('.pussycat-brand')
    expect(themeCss).toContain('.pussycat-menu-scrim')
    expect(themeCss).toContain('transform: translateX(-105%);')
    expect(themeCss).toContain('width: min(320px, 88vw);')
    const uiScript = readFileSync(join(installed.sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
    expect(uiScript).toContain('aria-controls="pussycat-wrss-nav"')
    expect(uiScript).toContain('aria-current')
    expect(uiScript).toContain("host.setAttribute('role', 'banner')")
    expect(uiScript).not.toContain('pussycat-primary-shell')
    expect(uiScript).toContain("panel.id = 'pussycat-wrss-nav'")
    expect(uiScript).toContain('document.body.style.overflow')
    expect(uiScript).toContain('/filter-rules')
  })

  it('reinstalls when the Python probe fails and then starts the service', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    const probePythonImpl = vi.fn(() => false)
    const steps = []
    const runStepImpl = vi.fn(async ({ step, argv }) => {
      steps.push(step)
      if (step === 'venv') {
        const scripts = join(argv.at(-1), 'Scripts')
        mkdirSync(scripts, { recursive: true })
        writeFileSync(join(scripts, 'python.exe'), 'python')
      }
    })
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', 0)
    let downloads = 0
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      probePythonImpl,
      sha256FileImpl: (path) => path.endsWith('uv.exe') ? uvSha : WRSS_SOURCE_SHA256,
      fetchImpl: async (url) => {
        if (url === WRSS_SOURCE_URL) {
          downloads += 1
          return { ok: true, status: 200, arrayBuffer: async () => weRssArchive() }
        }
        if (url.endsWith('/api/v1/wx/auth/login')) return ok({ data: { access_token: 'token' } })
        return ok()
      },
      runStepImpl,
      getPortImpl: async () => 4328,
      spawnImpl: () => child,
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })

    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    expect(probePythonImpl).toHaveBeenCalledTimes(1)
    expect(downloads).toBe(1)
    expect(steps).toEqual(expect.arrayContaining(['venv', 'install', 'playwright']))
    expect(manager.status().progress_log.join('\n')).toContain('Python 启动器不可用')
    await manager.close()
  })

  it('returns the typed install failure when probe recovery cannot reinstall', async () => {
    const { root, bundle } = await fixture()
    const installed = writeInstalled(root)
    const receiptPath = join(root, 'wrss', 'receipt.json')
    const fetchImpl = vi.fn(async () => { throw new Error('network unavailable') })
    const manager = new WrssRuntimeManager({
      home: root,
      bundleDir: bundle,
      probePythonImpl: () => false,
      sha256FileImpl: () => uvSha,
      fetchImpl,
    })

    await expect(manager.enable()).rejects.toMatchObject({
      reasonCode: 'download-failed',
      message: '公众号组件下载失败，请检查网络后重试',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceDir).toBe(installed.sourceDir)
    expect(manager.status().progress_log.join('\n')).toContain('Python 启动器不可用')
  })

  it('retries a failed valid receipt by restarting without downloading or reinstalling', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    let starts = 0
    const argvSeen = []
    let installs = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, getPortImpl: async () => 4322,
      probePythonImpl: () => true,
      runStepImpl: async () => { installs += 1 },
      fetchImpl: async (url) => {
        if (starts === 1 && !url.endsWith('/api/v1/wx/auth/login')) throw new Error('not ready')
        return url.endsWith('/api/v1/wx/auth/login') ? ok({ data: { access_token: 'token' } }) : ok()
      },
      spawnImpl: (command, argv) => {
        starts += 1
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 1)
        argvSeen.push(argv)
        if (starts === 1) queueMicrotask(() => child.emit('exit', 1))
        return child
      },
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })
    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'process-exited' })
    expect(manager.status().state).toBe('failed')
    mkdirSync(join(root, 'wrss', 'data'), { recursive: true })
    writeFileSync(join(root, 'wrss', 'data', 'db.db'), 'db')
    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    expect(starts).toBe(2)
    expect(argvSeen[1][argvSeen[1].indexOf('-init') + 1]).toBe('False')
    // The second start reuses the receipt and an existing DB, so migrations are not re-initialized.
    expect(installs).toBe(0)
    await manager.close()
  })

  it('kills a child when it errors before readiness', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    let killed = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, getPortImpl: async () => 4323,
      probePythonImpl: () => true,
      fetchImpl: async () => { throw new Error('not ready') },
      spawnImpl: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed += 1; child.emit('close', 1) }
        queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        return child
      },
      readyTimeoutMs: 100,
      readyPollMs: 1,
    })
    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'process-start-failed' })
    expect(killed).toBeGreaterThan(0)
    expect(manager.status().state).toBe('failed')
  })

  it('kills a child on readiness timeout', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    let killed = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, getPortImpl: async () => 4324,
      probePythonImpl: () => true,
      fetchImpl: async () => { throw new Error('not ready') },
      spawnImpl: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed += 1; child.emit('close', 1) }
        return child
      },
      readyTimeoutMs: 5,
      readyPollMs: 1,
    })
    await expect(manager.enable()).rejects.toMatchObject({ reasonCode: 'ready-timeout' })
    expect(killed).toBe(1)
  })

  it('falls back after a transport failure and rebuilds the proxy agent', async () => {
    const { root, bundle } = await fixture()
    let downloads = 0
    proxyFetch.mockImplementation(async (url, options = {}) => {
      if (url === WRSS_SOURCE_URL || url === WRSS_SOURCE_FALLBACK_URL) {
        downloads += 1
        if (downloads === 1) throw new Error('proxy request failed')
        return { ok: true, status: 200, arrayBuffer: async () => weRssArchive() }
      }
      if (url.endsWith('/api/v1/wx/auth/login')) {
        expect(options.dispatcher).toBeUndefined()
        return ok({ data: { access_token: 'token' } })
      }
      expect(options.dispatcher).toBeUndefined()
      return ok()
    })
    const runStepImpl = async ({ step, argv }) => {
      if (step !== 'extract') return
      const source = join(argv.at(-1), 'we-mp-rss-1.5.2')
      mkdirSync(join(source, 'static'), { recursive: true })
      writeFileSync(join(source, 'main.py'), 'host="0.0.0.0"\nhost="0.0.0.0"\nprint("环境变量:")\nfor k,v in os.environ.items():\n    print(k,v)\n')
      writeFileSync(join(source, 'requirements.txt'), '')
      writeFileSync(join(source, 'config.example.yaml'), '')
      writeFileSync(join(source, 'static', 'index.html'), '<head></head>')
      writePinSource(source)
    }
    let starts = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, env: { HTTPS_PROXY: 'https://user:pass@proxy.test' },
      probePythonImpl: () => true,
      sha256FileImpl: (path) => path.endsWith('uv.exe') ? uvSha : WRSS_SOURCE_SHA256,
      runStepImpl: async (args) => {
        await runStepImpl(args)
        if (args.step === 'venv') {
          mkdirSync(join(args.argv.at(-1), 'Scripts'), { recursive: true })
          writeFileSync(join(args.argv.at(-1), 'Scripts', 'python.exe'), 'python')
        }
      },
      getPortImpl: async () => 4325,
      spawnImpl: () => {
        starts += 1
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 0)
        return child
      },
    })
    await expect(manager.enable()).resolves.toMatchObject({ state: 'running' })
    expect(downloads).toBe(2)
    expect(proxyAgents).toHaveLength(2)
    expect(proxyAgents[0].destroyed).toBe(true)
    expect(proxyFetch.mock.calls.some(([url, options]) => String(url).includes('127.0.0.1') && options?.dispatcher)).toBe(false)
    expect(manager.status().progress_log.join('\n')).not.toContain('user:pass')
    await manager.close()
  })
})


it('keeps injected navigation stable across observer frames and preserves drawer focus and original navigation', async () => {
  const { root } = await fixture()
  const { sourceDir } = writeInstalled(root)
  ensureWrssStaticAssets(sourceDir)
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const css = readFileSync(join(sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
  const dom = new JSDOM(`<style>${css}</style><div id="main">
    <header class="arco-layout-header"><div class="arco-menu arco-menu-horizontal">
      <button class="arco-menu-item arco-menu-overflow-hidden-menu-item" data-route="/" style="position:absolute;left:100%;transform:translateX(-999px);visibility:hidden;pointer-events:none">订阅管理</button>
      <button class="arco-menu-item" data-route="/export/records">导出记录</button>
      <button class="arco-menu-item" data-route="/configs">配置信息</button>
      <button class="arco-menu-item" data-route="/sys-info">系统信息</button>
    </div></header>
    <section class="arco-layout"><main class="arco-layout-content">文章内容</main></section>
  </div>`, { url: 'http://127.0.0.1:43202/', pretendToBeVisual: true, runScripts: 'outside-only' })
  const { window } = dom
  const { document } = window
  const header = document.querySelector('header')
  const menu = header.firstElementChild
  const navigate = vi.fn()
  const frame = () => new Promise((resolve) => window.requestAnimationFrame(resolve))
  try {
    expect(css).toMatch(/\.pussycat-primary-nav\.arco-menu-overflow-hidden-menu-item\s*\{[^}]*pointer-events: auto !important;/)
    menu.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => {
      navigate(button.dataset.route)
      window.history.pushState({}, '', button.dataset.route)
      document.querySelector('.arco-layout-content').textContent = button.dataset.route
    }))
    window.eval(script)
    await vi.waitFor(() => expect(document.querySelectorAll('.pussycat-more-button')).toHaveLength(1))
    await frame()
    const nodeCount = document.querySelectorAll('*').length
    for (let index = 0; index < 6; index += 1) {
      document.querySelector('.arco-layout-content').textContent = `文章内容 ${index}`
      await frame()
      await frame()
      expect(document.querySelectorAll('*')).toHaveLength(nodeCount)
    }
    expect(document.querySelectorAll('.pussycat-brand')).toHaveLength(1)
    expect(document.querySelectorAll('.pussycat-more-button')).toHaveLength(1)
    expect(document.querySelectorAll('.pussycat-more-menu')).toHaveLength(1)
    expect(document.querySelectorAll('.pussycat-primary-shell')).toHaveLength(0)
    expect(menu.parentElement).toBe(header)
    expect(header.hasAttribute('role')).toBe(false)
    expect(menu.getAttribute('role')).toBe('navigation')
    expect(menu.getAttribute('aria-label')).toBe('Main')

    menu.querySelector('[data-route="/export/records"]').click()
    await frame()
    expect(navigate).toHaveBeenLastCalledWith('/export/records')
    expect(menu.querySelector('[aria-current="page"]').dataset.route).toBe('/export/records')
    const trigger = document.querySelector('.pussycat-more-button')
    const drawer = document.getElementById(trigger.getAttribute('aria-controls'))
    const scrim = document.querySelector('.pussycat-menu-scrim')
    expect(drawer.parentElement).toBe(document.body)
    expect(scrim.parentElement).toBe(document.body)
    expect(drawer.hasAttribute('inert')).toBe(true)
    document.body.style.overflow = 'auto'
    trigger.click()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(drawer.hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(drawer.querySelector('.pussycat-more-item'))

    const focusable = [...drawer.querySelectorAll('button')]
    focusable.at(-1).focus()
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(focusable[0])
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(focusable.at(-1))
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(drawer.hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('auto')
    expect(document.activeElement).toBe(trigger)

    trigger.click()
    const settings = [...drawer.querySelectorAll('.pussycat-more-item')].find((button) => button.textContent === '设置与诊断')
    settings.click()
    await frame()
    expect(navigate).toHaveBeenLastCalledWith('/configs')
    expect(drawer.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(drawer.querySelector('[aria-current="page"]').textContent).toBe('设置与诊断')
    trigger.click()
    scrim.click()
    expect(document.activeElement).toBe(trigger)
    expect(drawer.hasAttribute('inert')).toBe(true)
    trigger.click()
    drawer.querySelector('.pussycat-drawer-close').click()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    window.__PUSSYCAT_WRSS_UI__.destroy()
    expect(document.querySelectorAll('.pussycat-brand, .pussycat-more-wrap, .pussycat-more-menu, .pussycat-menu-scrim')).toHaveLength(0)
    expect(menu.parentElement).toBe(header)
    menu.querySelector('[data-route="/"]').click()
    expect(navigate).toHaveBeenLastCalledWith('/')
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('preserves original article controls when moving the toolbar and restores it on teardown', async () => {
  const { root } = await fixture()
  const { sourceDir } = writeInstalled(root)
  ensureWrssStaticAssets(sourceDir)
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const dom = new JSDOM(`<div id="main"><header class="arco-layout-header"><div class="arco-menu"><button class="arco-menu-item">订阅管理</button></div></header>
    <section class="article-list"><aside class="arco-layout-sider"><div class="arco-list"><button class="arco-list-item active-mp">全部</button><button class="arco-list-item">新智元</button></div></aside>
      <div class="arco-page-header"><div class="arco-page-header-extra"><button id="export">导出</button><button id="delete" disabled>批量删除</button></div></div>
    </section></div>`, { url: 'http://127.0.0.1:43202/', pretendToBeVisual: true, runScripts: 'outside-only' })
  const { window } = dom
  const { document } = window
  const toolbar = document.querySelector('.arco-page-header-extra')
  const header = toolbar.parentElement
  const exportAction = vi.fn()
  toolbar.querySelector('#export').addEventListener('click', exportAction)
  try {
    window.eval(script)
    await vi.waitFor(() => expect(toolbar.parentElement.className).toBe('pussycat-article-actions'))
    expect(header.childNodes[0].nodeType).toBe(window.Node.COMMENT_NODE)
    expect(document.querySelector('.arco-list').getAttribute('aria-label')).toBe('公众号')
    const accounts = [...document.querySelectorAll('.arco-list-item')]
    accounts[0].classList.remove('active-mp')
    accounts[1].classList.add('active-mp')
    await vi.waitFor(() => expect(accounts[1].getAttribute('aria-current')).toBe('page'))
    expect(accounts[0].hasAttribute('aria-current')).toBe(false)

    const trigger = document.querySelector('.pussycat-more-button')
    trigger.click()
    toolbar.querySelector('#export').click()
    expect(exportAction).toHaveBeenCalledOnce()
    toolbar.querySelector('#delete').disabled = false
    expect(document.querySelector('.pussycat-article-actions #delete').disabled).toBe(false)
    const modal = document.createElement('div')
    modal.className = 'arco-modal-wrapper'
    modal.innerHTML = '<input aria-label="导出文件名">'
    document.body.append(modal)
    modal.querySelector('input').focus()
    modal.querySelector('input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(modal.querySelector('input'))
    expect(modal.closest('[inert]')).toBeNull()
    modal.remove()
    document.querySelector('.pussycat-drawer-close').click()
    expect(document.body.style.overflow).toBe('')

    window.history.pushState({}, '', '/export/records')
    window.dispatchEvent(new window.PopStateEvent('popstate'))
    await vi.waitFor(() => expect(toolbar.parentElement).toBe(header))
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new window.PopStateEvent('popstate'))
    await vi.waitFor(() => expect(toolbar.parentElement.className).toBe('pussycat-article-actions'))
    const article = document.querySelector('.article-list')
    const replacement = article.cloneNode(true)
    replacement.querySelector('.arco-page-header').innerHTML = '<div class="arco-page-header-extra"><button>新的导出</button></div>'
    article.replaceWith(replacement)
    await vi.waitFor(() => expect(document.querySelector('.pussycat-article-actions').textContent).toContain('新的导出'))
    expect(toolbar.isConnected).toBe(false)
    expect(document.querySelectorAll('.arco-page-header-extra')).toHaveLength(1)
    window.__PUSSYCAT_WRSS_UI__.destroy()
    expect(replacement.querySelector('.arco-page-header-extra')?.textContent).toBe('新的导出')
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('renders scoped empty states for missing公众号 and empty article results', async () => {
  const { root } = await fixture()
  const { sourceDir } = writeInstalled(root)
  ensureWrssStaticAssets(sourceDir)
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const dom = new JSDOM(`<div id="main"><header class="arco-layout-header"><div class="arco-menu"><button class="arco-menu-item">订阅管理</button></div></header>
    <section class="article-list"><aside class="arco-layout-sider"><div class="arco-list"><input placeholder="搜索公众号" value="不存在" /></div></aside>
      <div class="arco-layout-content"><div class="arco-page-header"><div class="arco-page-header-extra"><button>导出</button></div></div><div class="arco-list"></div></div>
    </section></div>`, { url: 'http://127.0.0.1:43202/', pretendToBeVisual: true, runScripts: 'outside-only' })
  const { window } = dom
  const { document } = window
  try {
    window.eval(script)
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    await vi.waitFor(() => expect(document.querySelector('[data-pussycat-empty="source-search"]')).not.toBeNull())
    expect(document.querySelector('[data-pussycat-empty="source-search"]')).toHaveAttribute('role', 'status')
    expect(document.querySelector('[data-pussycat-empty="source-search"]').textContent).toBe('没有匹配的公众号')
    expect(document.querySelector('[data-pussycat-empty="article-results"]')).toHaveAttribute('role', 'status')
    expect(document.querySelector('[data-pussycat-empty="article-results"]').textContent).toBe('暂无文章')
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})

it('renders settings tabs beside the published nested route layout and restores routes after logs', async () => {
  const { root } = await fixture()
  const { sourceDir } = writeInstalled(root)
  ensureWrssStaticAssets(sourceDir)
  const script = readFileSync(join(sourceDir, 'static', 'pussycat-ui.js'), 'utf8')
  const css = readFileSync(join(sourceDir, 'static', 'pussycat-theme.css'), 'utf8')
  const dom = new JSDOM(`<style>${css}</style><div id="main">
    <header class="arco-layout-header"><div class="arco-menu">
      <button class="arco-menu-item" data-route="/">订阅管理</button>
      <button class="arco-menu-item" data-route="/configs">配置信息</button>
      <button class="arco-menu-item" data-route="/sys-info">系统信息</button>
    </div></header>
    <section class="arco-layout"><main class="arco-layout-content">配置页面内容</main></section>
  </div>`, { url: 'http://127.0.0.1:43202/configs', pretendToBeVisual: true, runScripts: 'outside-only' })
  const window = dom.window
  const document = window.document
  try {
    document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => {
      window.history.pushState({}, '', button.dataset.route)
    }))
    window.eval(script)
    await vi.waitFor(() => expect(document.querySelectorAll('.pussycat-settings-tab')).toHaveLength(3))
    const panel = document.getElementById('pussycat-settings-panel')
    const route = document.querySelector('#main > section.arco-layout')
    expect(panel.nextElementSibling).toBe(route)
    expect([...panel.querySelectorAll('.pussycat-settings-tab')].map((tab) => tab.textContent))
      .toEqual(['配置信息', '系统信息', '运行日志'])

    panel.querySelector('[data-settings-tab="logs"]').click()
    await vi.waitFor(() => expect(window.getComputedStyle(route).display).toBe('none'))
    expect(window.getComputedStyle(panel).display).not.toBe('none')
    expect(panel.querySelector('.pussycat-diagnostics').hidden).toBe(false)

    panel.querySelector('[data-settings-tab="configs"]').click()
    await vi.waitFor(() => expect(window.getComputedStyle(route).display).not.toBe('none'))
    expect(window.getComputedStyle(panel).display).not.toBe('none')
    expect(panel.querySelector('.pussycat-diagnostics').hidden).toBe(true)
    expect(document.querySelector('.arco-layout-content').textContent).toBe('配置页面内容')

    document.querySelector('[data-route="/"]').click()
    document.querySelector('.arco-layout-content').textContent = '订阅页面内容'
    await vi.waitFor(() => expect(document.getElementById('pussycat-settings-panel')).toBeNull())
    expect(window.getComputedStyle(route).display).not.toBe('none')
    expect(document.querySelector('.arco-layout-content').textContent).toBe('订阅页面内容')
  } finally {
    window.__PUSSYCAT_WRSS_UI__?.destroy()
    window.close()
  }
})
