// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractTarGzipSecure,
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
    { name: `${root}/docs/`, type: '5' },
    { name: `${root}/docs/主界面.png`, content: Buffer.from([1, 2, 3]) },
    { name: `${root}/docs/赞赏码.jpg`, content: Buffer.from([4, 5, 6]) },
  ]
  return tarGzip(entries.filter(({ name }) => !omit.some((suffix) => name.endsWith(suffix))))
}

function writeInstalled(root) {
  const wrss = join(root, 'wrss')
  const sourceDir = join(wrss, 'versions', 'v1.5.2-1', 'src')
  const venvDir = join(wrss, 'versions', 'v1.5.2-1', 'py')
  mkdirSync(join(sourceDir, 'static'), { recursive: true })
  mkdirSync(join(venvDir, 'Scripts'), { recursive: true })
  writeFileSync(join(sourceDir, 'static', 'index.html'), '<html><head></head></html>')
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
    const patchedMain = readFileSync(join(receipt.sourceDir, 'main.py'), 'utf8')
    expect(patchedMain.match(/host="127\.0\.0\.1"/g)).toHaveLength(2)
    expect(patchedMain).not.toContain('host="0.0.0.0"')
    expect(patchedMain).not.toContain('os.environ.items()')
    expect(readFileSync(join(receipt.sourceDir, 'static', 'pussycat-bootstrap.js'), 'utf8')).toContain('localStorage.setItem')
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
    await manager.close()
  })

  it('retries a failed valid receipt by restarting without downloading or reinstalling', async () => {
    const { root, bundle } = await fixture()
    writeInstalled(root)
    let starts = 0
    const argvSeen = []
    let installs = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, getPortImpl: async () => 4322,
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
    }
    let starts = 0
    const manager = new WrssRuntimeManager({
      home: root, bundleDir: bundle, env: { HTTPS_PROXY: 'https://user:pass@proxy.test' },
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
