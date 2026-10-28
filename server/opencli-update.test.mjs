// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RETAINED_SITE_KEYS } from '../src/shared/opencli-sites.mjs'
import { OpencliUpdateError, createOpencliUpdate, extensionWarning } from './opencli-update.mjs'
import { createOpencliRuntime, versionEntry } from './opencli-runtime.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

const VERSION = '2.0.2'
const NPMJS = 'https://registry.npmjs.org'
const MIRROR = 'https://registry.npmmirror.com'
const TARBALL_URL = `${MIRROR}/@jackwener/opencli/-/opencli-${VERSION}.tgz`
const CHUNKS = [Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cccc')]
const TARBALL = Buffer.concat(CHUNKS)
const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const OVERRIDES_DIR = resolve('opencli-overrides/xiaohongshu')
const OVERRIDE_FILES = readdirSync(OVERRIDES_DIR).filter((name) => name.endsWith('.js') && !name.includes('.test.'))
const REVIEWED_RETAINED = [...REVIEWED_RECORDS.keys()].filter((key) => RETAINED_SITE_KEYS.includes(key.split('/')[0]))

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// 在 dir 下造一个假的 OpenCLI 包:入口、package.json、cli-manifest.json 和 clis/<站点>/ 目录。
function writePackage(dir, { version = VERSION, extraSites = ['hupu', 'mercury'], omit = [] } = {}) {
  const root = join(dir, 'node_modules', '@jackwener', 'opencli')
  const keys = new Set([
    ...REVIEWED_RETAINED, 'xiaohongshu/user', 'eastmoney/quote', 'binance/price',
    ...extraSites.map((site) => `${site}/hot`),
  ])
  for (const key of omit) keys.delete(key)
  const manifest = [...keys].map((key) => {
    const [site, name] = key.split('/')
    return { site, name, description: key, access: 'read', args: [], modulePath: `${site}/${name}.js` }
  })
  mkdirSync(join(root, 'dist', 'src'), { recursive: true })
  writeFileSync(join(root, 'dist', 'src', 'main.js'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(root, 'cli-manifest.json'), JSON.stringify(manifest))
  for (const site of new Set(manifest.map((entry) => entry.site))) {
    mkdirSync(join(root, 'clis', site), { recursive: true })
    writeFileSync(join(root, 'clis', site, 'hot.js'), '')
  }
  // 上游包里小红书适配器目录本来就有与原生命令同名的文件,套补丁时要覆盖它们。
  for (const name of OVERRIDE_FILES) writeFileSync(join(root, 'clis', 'xiaohongshu', name), 'upstream content')
  mkdirSync(join(root, 'clis', '_shared'), { recursive: true })
  writeFileSync(join(root, 'clis', '_shared', 'util.js'), '')
  return root
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// body 按 chunk 逐个吐出;gates[i] 是第 i 个 chunk 之前要等的 Promise。
function chunkedBody(chunks, gates = []) {
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) { controller.close(); return }
      if (gates[index]) await gates[index]
      controller.enqueue(new Uint8Array(chunks[index]))
      index += 1
    },
  })
}

function setup(options = {}) {
  const base = mkdtempSync(join(tmpdir(), '爪爪-update-'))
  dirs.push(base)
  const bundledRoot = writePackage(join(base, 'bundled'), { version: '1.8.8' })
  const runtime = createOpencliRuntime({ bundledEntry: join(bundledRoot, 'dist', 'src', 'main.js'), dataRoot: join(base, 'data') })
  const root = runtime.root
  const log = []
  const seen = {}              // 各 fake 被调用时任务所处的快照
  let updater

  const snap = (name) => { seen[name] ??= updater.current() }
  const packageOptions = options.package ?? {}
  const gates = options.gates ?? []
  const fetchImpl = vi.fn(async (url, init) => {
    log.push(`fetch ${url}`)
    if (url.endsWith(`/@jackwener/opencli/${VERSION}`)) {
      const host = new URL(url).origin
      snap('resolve')
      if (options.registries?.[host]) return options.registries[host](url, init)
      return json({ version: VERSION, dist: { tarball: TARBALL_URL, integrity: options.integrity ?? integrityOf(TARBALL), unpackedSize: 99 } })
    }
    if (url === TARBALL_URL) {
      snap('download')
      return new Response(chunkedBody(CHUNKS, gates), { headers: { 'content-length': String(TARBALL.length) } })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  const runNpm = options.runNpm ?? vi.fn(async ({ args, cwd }) => {
    log.push('npm')
    snap('install')
    writePackage(cwd, packageOptions)
    return { code: 0, stderr: '', args }
  })
  const runCli = options.runCli ?? vi.fn(async (entry, args, { env }) => {
    snap('verify')
    const packageRoot = join(dirname(entry), '..', '..')
    if (args[0] === '--version') return { code: 0, stdout: `${options.cliVersion ?? VERSION}\n`, stderr: '' }
    if (args[0] === 'list') {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
      const all = [
        { command: 'browser open', description: 'open', access: 'write' },
        ...manifest.map((entry2) => ({ command: `${entry2.site} ${entry2.name}`, description: entry2.description, access: 'read' })),
        ...(options.extraListed ?? []),
      ]
      if (options.listFails) return { code: 1, stdout: '', stderr: 'boom' }
      const at = args.indexOf('--offset')
      const offset = at >= 0 ? Number(args[at + 1]) : 0
      const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 10
      const commands = all.slice(offset, offset + limit)
      const next = offset + limit < all.length ? offset + limit : null
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { commands, total: all.length, nextOffset: next } }), stderr: '', env }
    }
    return options.helpBroken?.(args) ?? { code: 0, stdout: JSON.stringify({ site: args[0], name: args[1] }), stderr: '' }
  })
  const catalogService = options.catalogService ?? { refresh: vi.fn(async () => { log.push('catalog-refresh') }) }
  const restartDaemon = options.restartDaemon ?? vi.fn(async () => {
    log.push(`daemon-restart v${runtime.version()}`)
    snap('switch')
    seen.switchingDuringRestart = updater.isSwitching()
    return { failed: false }
  })
  const stopVideoEngine = options.stopVideoEngine ?? vi.fn(async () => { log.push('engine-stop') })
  const readExtensionVersion = options.readExtensionVersion ?? vi.fn(async () => undefined)
  const hasActiveRuns = vi.fn(() => options.activeRuns?.() ?? false)

  updater = createOpencliUpdate({
    runtime,
    catalogService,
    hasActiveRuns,
    restartDaemon,
    stopVideoEngine,
    readExtensionVersion,
    fetchImpl,
    runNpm,
    runCli,
    findNpmCli: options.findNpmCli ?? (() => 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'),
    overridesDir: OVERRIDES_DIR,
    drainTimeoutMs: options.drainTimeoutMs ?? 300,
    ...options.updateOptions,
  })
  return { base, root, runtime, updater, log, seen, fetchImpl, runNpm, runCli, catalogService, restartDaemon, stopVideoEngine, readExtensionVersion }
}

async function finished(updater) {
  await vi.waitFor(() => expect(updater.current().state).not.toBe('running'), { timeout: 5000, interval: 5 })
  return updater.current()
}

const run = async (ctx) => {
  ctx.updater.start(VERSION)
  return finished(ctx.updater)
}

const staged = (root) => readdirSync(root).filter((name) => name === 'staging' || name.endsWith('.staging'))
const installedRoot = (root) => join(root, 'versions', VERSION, 'node_modules', '@jackwener', 'opencli')

describe('更新成功', () => {
  it('各阶段依次推进,百分比由宿主算出', async () => {
    const ctx = setup()
    const started = ctx.updater.start(VERSION)
    expect(started).toMatchObject({ version: VERSION, state: 'running', stage: 'resolve', percent: 0, receivedBytes: 0, totalBytes: null, error: null, warnings: [], finishedAt: null })
    expect(started.id).toEqual(expect.any(String))
    const job = await finished(ctx.updater)

    expect(ctx.seen.resolve).toMatchObject({ stage: 'resolve', percent: 0 })
    expect(ctx.seen.download).toMatchObject({ stage: 'download', percent: 0 })
    expect(ctx.seen.install).toMatchObject({ stage: 'install', percent: 60, receivedBytes: 12, totalBytes: 12 })
    expect(ctx.seen.verify).toMatchObject({ stage: 'verify', percent: 88 })
    expect(ctx.seen.switch).toMatchObject({ stage: 'switch', percent: 95, state: 'running' })
    expect(job).toMatchObject({ state: 'succeeded', stage: 'done', percent: 100, error: null, warnings: [], receivedBytes: 12, totalBytes: 12 })
    expect(job.finishedAt).toEqual(expect.any(Number))
  })

  it('同时问两个 registry 的 @jackwener/opencli/<版本>', async () => {
    const ctx = setup()
    await run(ctx)
    const urls = ctx.fetchImpl.mock.calls.map(([url]) => url)
    expect(urls).toContain(`${NPMJS}/@jackwener/opencli/${VERSION}`)
    expect(urls).toContain(`${MIRROR}/@jackwener/opencli/${VERSION}`)
    expect(urls).toContain(TARBALL_URL)
  })

  it('npm 安装:本地 tgz、不跑脚本、走 npmmirror,工作目录是带最小 package.json 的 staging 目录', async () => {
    const ctx = setup()
    await run(ctx)
    const [call] = ctx.runNpm.mock.calls
    expect(call[0].npmCli).toBe('C:\\node\\node_modules\\npm\\bin\\npm-cli.js')
    expect(call[0].args).toEqual([
      'install', join(ctx.root, 'staging', `${VERSION}.tgz`),
      '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${MIRROR}`,
    ])
    expect(call[0].cwd).toBe(join(ctx.root, 'versions', `${VERSION}.staging`))
  })

  it('切换:入口、active.json、版本目录;daemon 重启在切换之后,随后刷新目录、停视频引擎', async () => {
    const ctx = setup()
    await run(ctx)
    const entry = versionEntry(ctx.root, VERSION)
    expect(existsSync(entry)).toBe(true)
    expect(ctx.runtime.entry()).toBe(entry)
    expect(ctx.runtime.version()).toBe(VERSION)
    expect(JSON.parse(readFileSync(join(ctx.root, 'active.json'), 'utf8'))).toEqual({ version: VERSION, entry, installedAt: expect.any(Number) })
    expect(staged(join(ctx.root, 'versions'))).toEqual([])
    expect(ctx.log.filter((line) => !line.startsWith('fetch'))).toEqual(['npm', `daemon-restart v${VERSION}`, 'catalog-refresh', 'engine-stop'])
    expect(ctx.seen.switchingDuringRestart).toBe(true)
    expect(ctx.updater.isSwitching()).toBe(false)
  })

  it('切换期间新的命令启动请求被拒:503 和中文原因', async () => {
    const ctx = setup()
    let thrown
    ctx.updater.assertNotSwitching()    // 平时放行
    ctx.restartDaemon.mockImplementation(async () => {
      try { ctx.updater.assertNotSwitching() } catch (error) { thrown = error }
      return { failed: false }
    })
    await run(ctx)
    expect(thrown).toBeInstanceOf(OpencliUpdateError)
    expect(thrown).toMatchObject({ statusCode: 503, message: '正在切换 OpenCLI，请稍候' })
    expect(() => ctx.updater.assertNotSwitching()).not.toThrow()
  })

  it('同版本目录已存在时先删掉再换', async () => {
    const ctx = setup()
    mkdirSync(join(ctx.root, 'versions', VERSION), { recursive: true })
    writeFileSync(join(ctx.root, 'versions', VERSION, 'stale.txt'), 'old')
    await run(ctx)
    expect(existsSync(join(ctx.root, 'versions', VERSION, 'stale.txt'))).toBe(false)
    expect(existsSync(versionEntry(ctx.root, VERSION))).toBe(true)
  })

  it('临时文件(tgz、校验用的空用户目录)都清掉', async () => {
    const ctx = setup()
    await run(ctx)
    expect(readdirSync(join(ctx.root, 'staging'))).toEqual([])
  })

  it('套上爪爪的原生命令', async () => {
    const ctx = setup()
    await run(ctx)
    const manifest = JSON.parse(readFileSync(join(installedRoot(ctx.root), 'cli-manifest.json'), 'utf8'))
    const xiaohongshu = manifest.filter((entry) => entry.site === 'xiaohongshu').map((entry) => entry.name)
    expect(xiaohongshu).toEqual(expect.arrayContaining(['collections', 'search', 'user-posts', 'note', 'comments', 'saved']))
    expect(manifest.find((entry) => entry.name === 'search').args.map((arg) => arg.name)).toEqual(['query', 'limit', 'sort', 'time', 'type'])
    for (const name of OVERRIDE_FILES) {
      expect(readFileSync(join(installedRoot(ctx.root), 'clis', 'xiaohongshu', name), 'utf8'), name).toBe(readFileSync(join(OVERRIDES_DIR, name), 'utf8'))
    }
  })

  it('只留保留清单里的站点:manifest 条目和 clis/<站点>/ 一起裁,_shared 之类非站点目录保留', async () => {
    const ctx = setup()
    await run(ctx)
    const packageRoot = installedRoot(ctx.root)
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8'))
    expect([...new Set(manifest.map((entry) => entry.site))].sort()).toEqual(
      ['bilibili', 'binance', 'eastmoney', 'twitter', 'xiaohongshu', 'youtube'],
    )
    const dirsLeft = readdirSync(join(packageRoot, 'clis')).sort()
    expect(dirsLeft).toEqual(['_shared', 'bilibili', 'binance', 'eastmoney', 'twitter', 'xiaohongshu', 'youtube'])
  })

  it('校验用的 OpenCLI 进程不碰用户目录:HOME/USERPROFILE 指向临时目录,CI=1', async () => {
    const ctx = setup()
    await run(ctx)
    const home = join(ctx.root, 'staging', `home-${VERSION}`)
    for (const [, , options] of ctx.runCli.mock.calls) {
      expect(options.env).toMatchObject({ HOME: home, USERPROFILE: home, CI: '1' })
    }
    const entries = ctx.runCli.mock.calls.map(([entry]) => entry)
    expect(new Set(entries)).toEqual(new Set([join(ctx.root, 'versions', `${VERSION}.staging`, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')]))
  })

  it('校验:--version、翻页读 list、原生命令 --help -f json', async () => {
    const ctx = setup()
    await run(ctx)
    const calls = ctx.runCli.mock.calls.map(([, args]) => args.join(' '))
    expect(calls[0]).toBe('--version')
    expect(calls.filter((call) => call.startsWith('list'))).toEqual(
      expect.arrayContaining(['list -f json', 'list -f json --limit 100 --offset 10']),
    )
    for (const name of ['collections', 'search', 'user-posts', 'note', 'comments', 'saved']) {
      expect(calls).toContain(`xiaohongshu ${name} --help -f json`)
    }
  })

  it('任务结束后 GET 仍能读到最后一次任务;返回的是副本', async () => {
    const ctx = setup()
    expect(ctx.updater.current()).toBeNull()
    await run(ctx)
    const job = ctx.updater.current()
    job.state = 'tampered'
    job.warnings.push({ code: 'x' })
    expect(ctx.updater.current()).toMatchObject({ state: 'succeeded', warnings: [] })
  })
})

describe('下载', () => {
  it('按字节更新 receivedBytes/totalBytes,百分比 0–60 线性', async () => {
    let release
    const gate = new Promise((done) => { release = done })
    const ctx = setup({ gates: [undefined, gate] })
    ctx.updater.start(VERSION)
    await vi.waitFor(() => expect(ctx.updater.current().receivedBytes).toBe(4), { interval: 5 })
    expect(ctx.updater.current()).toMatchObject({ stage: 'download', receivedBytes: 4, totalBytes: 12, percent: 20 })
    release()
    await finished(ctx.updater)
    expect(ctx.updater.current()).toMatchObject({ state: 'succeeded', receivedBytes: 12, percent: 100 })
  })

  it('没有 Content-Length:totalBytes 为 null,百分比停在 0 直到下载完成', async () => {
    let release
    const gate = new Promise((done) => { release = done })
    const ctx = setup({ gates: [undefined, gate] })
    ctx.fetchImpl.mockImplementation(async (url) => {
      if (url.endsWith(`/@jackwener/opencli/${VERSION}`)) return json({ dist: { tarball: TARBALL_URL, integrity: integrityOf(TARBALL) } })
      return new Response(chunkedBody(CHUNKS, [undefined, gate]))
    })
    ctx.updater.start(VERSION)
    await vi.waitFor(() => expect(ctx.updater.current().receivedBytes).toBe(4), { interval: 5 })
    expect(ctx.updater.current()).toMatchObject({ totalBytes: null, percent: 0 })
    release()
    await finished(ctx.updater)
    expect(ctx.updater.current().state).toBe('succeeded')
  })

  it('integrity 不符:失败,丢弃下载文件,不安装、不切换', async () => {
    const ctx = setup({ integrity: integrityOf(Buffer.from('something else')) })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'download' })
    expect(job.error.summary).toBe('下载的文件校验不通过，已丢弃')
    expect(ctx.runNpm).not.toHaveBeenCalled()
    expect(ctx.runtime.active()).toBeNull()
    expect(existsSync(join(ctx.root, 'staging', `${VERSION}.tgz`))).toBe(false)
  })

  it('下载地址 HTTP 错误:失败并说明', async () => {
    const ctx = setup()
    ctx.fetchImpl.mockImplementation(async (url) => (url.endsWith(`/${VERSION}`)
      ? json({ dist: { tarball: TARBALL_URL, integrity: integrityOf(TARBALL) } })
      : new Response('nope', { status: 502 })))
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'download', error: { summary: '下载失败', detail: 'registry.npmmirror.com 返回 HTTP 502' } })
  })

  it('取消:停止下载,状态 cancelled,清理临时文件,生效版本不变', async () => {
    const ctx = setup({ gates: [undefined, new Promise(() => {})] })
    ctx.updater.start(VERSION)
    await vi.waitFor(() => expect(ctx.updater.current().receivedBytes).toBe(4), { interval: 5 })
    const job = await ctx.updater.cancel()
    expect(job).toMatchObject({ state: 'cancelled', stage: 'download' })
    expect(job.finishedAt).toEqual(expect.any(Number))
    expect(existsSync(join(ctx.root, 'staging', `${VERSION}.tgz`))).toBe(false)
    expect(ctx.runtime.active()).toBeNull()
    expect(ctx.runNpm).not.toHaveBeenCalled()
  })
})

describe('查询版本', () => {
  it('一个 registry 失败,另一个成功就继续', async () => {
    const ctx = setup({ registries: { [NPMJS]: async () => json({}, 503) } })
    expect((await run(ctx)).state).toBe('succeeded')
  })

  it('两个都失败:失败并按源列出原因', async () => {
    const ctx = setup({ registries: { [NPMJS]: async () => json({}, 404), [MIRROR]: async () => json({}, 503) } })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'resolve' })
    expect(job.error.summary).toBe(`查不到 OpenCLI ${VERSION}`)
    expect(job.error.detail).toBe('registry.npmjs.org 返回 HTTP 404；registry.npmmirror.com 返回 HTTP 503')
  })

  it('响应没有下载地址也算这个源失败', async () => {
    const ctx = setup({ registries: { [NPMJS]: async () => json({ dist: {} }), [MIRROR]: async () => json({ dist: {} }) } })
    expect((await run(ctx)).error.detail).toContain('的响应里没有下载地址')
  })

  it('没有 sha512 完整性信息:不安装', async () => {
    const ctx = setup({ integrity: 'sha1-abc' })
    const job = await run(ctx)
    expect(job.error.summary).toBe('这个版本缺少完整性校验信息，不能安装')
    expect(ctx.runNpm).not.toHaveBeenCalled()
  })

  it.each(['abc', '2.0', '2.0.2-beta.1', '../2.0.2', '', undefined, 202])('版本号 %j 不合法:400', (version) => {
    const ctx = setup()
    expect(() => ctx.updater.start(version)).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(ctx.updater.current()).toBeNull()
  })
})

describe('安装', () => {
  it('找不到 npm:失败并给中文提示,不动生效版本', async () => {
    const ctx = setup({ findNpmCli: () => null })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'install' })
    expect(job.error.summary).toBe('没找到 npm，需要随 Node.js 一起安装')
    expect(ctx.runtime.active()).toBeNull()
  })

  it('npm 退出码非 0:失败,stderr 尾部进 detail,staging 目录清掉', async () => {
    const ctx = setup({ runNpm: vi.fn(async () => ({ code: 1, stderr: 'npm ERR! network timeout' })) })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'install', error: { summary: '安装依赖失败', detail: 'npm ERR! network timeout' } })
    expect(existsSync(join(ctx.root, 'versions', `${VERSION}.staging`))).toBe(false)
  })

  it('取消:结束 npm 进程,清理 staging', async () => {
    let called
    const waiting = new Promise((done) => { called = done })
    const runNpm = vi.fn(({ signal }) => new Promise((resolvePromise) => {
      called()
      signal.addEventListener('abort', () => resolvePromise({ code: null, stderr: 'killed' }))
    }))
    const ctx = setup({ runNpm })
    ctx.updater.start(VERSION)
    await waiting
    const job = await ctx.updater.cancel()
    expect(job).toMatchObject({ state: 'cancelled', stage: 'install' })
    expect(existsSync(join(ctx.root, 'versions', `${VERSION}.staging`))).toBe(false)
    expect(ctx.runtime.active()).toBeNull()
  })

  it('任务结束后 cancel 不改变结果', async () => {
    const ctx = setup()
    await run(ctx)
    expect((await ctx.updater.cancel()).state).toBe('succeeded')
  })
})

describe('校验失败时不切换', () => {
  const untouched = (ctx) => {
    expect(ctx.runtime.active()).toBeNull()
    expect(ctx.runtime.version()).toBe('1.8.8')
    expect(ctx.restartDaemon).not.toHaveBeenCalled()
    expect(ctx.catalogService.refresh).not.toHaveBeenCalled()
    expect(ctx.stopVideoEngine).not.toHaveBeenCalled()
    expect(existsSync(join(ctx.root, 'versions', VERSION))).toBe(false)
    expect(existsSync(join(ctx.root, 'versions', `${VERSION}.staging`))).toBe(false)
  }

  it('--version 与目标版本不符', async () => {
    const ctx = setup({ cliVersion: '2.0.1' })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：新版本跑不起来或版本号不符' } })
    untouched(ctx)
  })

  it('list 读不出来', async () => {
    const ctx = setup({ listFails: true })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：读不出命令目录' } })
    untouched(ctx)
  })

  it('被裁掉的站点还出现在 list 里', async () => {
    const ctx = setup({ extraListed: [{ command: 'hupu detail', description: 'x', access: 'read' }] })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：被裁掉的站点还在命令目录里', detail: 'hupu' } })
    untouched(ctx)
  })

  it('保留站点的审定命令不在 manifest', async () => {
    const ctx = setup({ package: { omit: ['bilibili/hot'] } })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：新版本缺少必需的命令', detail: 'bilibili/hot' } })
    untouched(ctx)
  })

  it('原生命令在 manifest 里但 list 加载不了', async () => {
    const ctx = setup()
    // list 里没有 manifest 的命令(加载失败)
    ctx.runCli.mockImplementation(async (entry, args) => {
      if (args[0] === '--version') return { code: 0, stdout: VERSION, stderr: '' }
      if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, data: { commands: [{ command: 'browser open', access: 'write' }], total: 1, nextOffset: null } }), stderr: '' }
      return { code: 0, stdout: '{}', stderr: '' }
    })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：必需的命令加载不了' } })
    untouched(ctx)
  })

  it('原生命令的 --help -f json 解析不了', async () => {
    const ctx = setup({ helpBroken: (args) => (args[1] === 'saved' ? { code: 0, stdout: 'Usage: …', stderr: '' } : undefined) })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'verify', error: { summary: '校验失败：原生命令 xiaohongshu saved 不能用' } })
    untouched(ctx)
  })
})

describe('切换', () => {
  it('daemon 重启失败只记警告,不回滚', async () => {
    const ctx = setup({ restartDaemon: vi.fn(async () => ({ failed: true, detail: 'timeout' })) })
    const job = await run(ctx)
    expect(job.state).toBe('succeeded')
    expect(job.warnings).toEqual([expect.objectContaining({ code: 'daemon-restart-failed' })])
    expect(ctx.runtime.version()).toBe(VERSION)
    expect(ctx.catalogService.refresh).toHaveBeenCalledTimes(1)
  })

  it('daemon 重启抛异常也只是警告', async () => {
    const ctx = setup({ restartDaemon: vi.fn(async () => { throw new Error('spawn failed') }) })
    const job = await run(ctx)
    expect(job.state).toBe('succeeded')
    expect(job.warnings.map((warning) => warning.code)).toEqual(['daemon-restart-failed'])
  })

  it('停视频引擎失败只记警告', async () => {
    const ctx = setup({ stopVideoEngine: vi.fn(async () => { throw new Error('busy') }) })
    const job = await run(ctx)
    expect(job.state).toBe('succeeded')
    expect(job.warnings.map((warning) => warning.code)).toEqual(['engine-stop-failed'])
  })

  it('目录刷新失败:任务失败,退回内置版本', async () => {
    const catalogService = { refresh: vi.fn(async () => { throw new Error('list timed out') }) }
    const ctx = setup({ catalogService })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'switch', error: { summary: '切换后刷新命令目录失败，已退回原来的版本', detail: 'list timed out' } })
    expect(ctx.runtime.active()).toBeNull()
    expect(ctx.updater.isSwitching()).toBe(false)
  })

  it('目录刷新失败:原来用的是更新版本时,退回到那一个', async () => {
    const catalogService = { refresh: vi.fn(async () => { throw new Error('list timed out') }) }
    const ctx = setup({ catalogService })
    const previous = join(ctx.root, 'versions', '2.0.1', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    mkdirSync(dirname(previous), { recursive: true })
    writeFileSync(previous, '')
    ctx.runtime.activate('2.0.1', previous)
    await run(ctx)
    expect(ctx.runtime.active()).toEqual({ version: '2.0.1', entry: previous, installedAt: expect.any(Number) })
  })

  it('有命令在运行时,等它们结束再切换', async () => {
    let running = false
    const ctx = setup({ activeRuns: () => running })
    ctx.runCli.mockImplementationOnce(async () => {
      running = true                                    // 校验期间用户启动了命令
      setTimeout(() => { running = false }, 60)
      return { code: 0, stdout: VERSION, stderr: '' }
    })
    const job = await run(ctx)
    expect(job.state).toBe('succeeded')
    expect(ctx.runtime.version()).toBe(VERSION)
  })

  it('一直有命令在运行:超时后失败,生效版本不变', async () => {
    let running = false
    const ctx = setup({ activeRuns: () => running, drainTimeoutMs: 80 })
    ctx.runCli.mockImplementationOnce(async () => {
      running = true
      return { code: 0, stdout: VERSION, stderr: '' }
    })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'failed', stage: 'switch', error: { summary: '还有命令在运行，没法切换，等它们结束后再试' } })
    expect(ctx.runtime.active()).toBeNull()
    expect(ctx.restartDaemon).not.toHaveBeenCalled()
    expect(ctx.updater.isSwitching()).toBe(false)
  })
})

describe('并发与前置条件', () => {
  it('已有任务时再开始:409,原任务不受影响', async () => {
    const ctx = setup({ gates: [new Promise(() => {})] })
    const first = ctx.updater.start(VERSION)
    expect(() => ctx.updater.start(VERSION)).toThrow(expect.objectContaining({ statusCode: 409, message: '已有更新任务在进行' }))
    expect(ctx.updater.current().id).toBe(first.id)
    await ctx.updater.cancel()
  })

  it('任务结束后可以再开始新任务', async () => {
    const ctx = setup()
    const first = await run(ctx)
    const second = ctx.updater.start(VERSION)
    expect(second.id).not.toBe(first.id)
    await finished(ctx.updater)
  })

  it('有命令在运行时拒绝开始:409,中文原因,不发任何请求', () => {
    const ctx = setup({ activeRuns: () => true })
    expect(() => ctx.updater.start(VERSION)).toThrow(expect.objectContaining({ statusCode: 409, message: '有命令正在运行，等它们结束后再更新' }))
    expect(ctx.fetchImpl).not.toHaveBeenCalled()
    expect(ctx.updater.current()).toBeNull()
  })
})

describe('回退到内置版本', () => {
  it('删掉 active.json,做切换的后半段', async () => {
    const ctx = setup()
    await run(ctx)
    ctx.log.length = 0
    ctx.restartDaemon.mockClear()
    await expect(ctx.updater.rollback()).resolves.toEqual({ active: null })
    expect(ctx.runtime.active()).toBeNull()
    expect(existsSync(join(ctx.root, 'active.json'))).toBe(false)
    expect(ctx.runtime.version()).toBe('1.8.8')
    expect(ctx.log).toEqual(['daemon-restart v1.8.8', 'catalog-refresh', 'engine-stop'])
    expect(ctx.restartDaemon).toHaveBeenCalledTimes(1)
    expect(existsSync(versionEntry(ctx.root, VERSION))).toBe(true)      // 已装的版本目录保留
  })

  it('本来就在用内置版本:不重启任何东西', async () => {
    const ctx = setup()
    await expect(ctx.updater.rollback()).resolves.toEqual({ active: null })
    expect(ctx.restartDaemon).not.toHaveBeenCalled()
    expect(ctx.catalogService.refresh).not.toHaveBeenCalled()
  })

  it('更新任务进行中不能回退:409', async () => {
    const ctx = setup({ gates: [new Promise(() => {})] })
    ctx.updater.start(VERSION)
    await expect(ctx.updater.rollback()).rejects.toMatchObject({ statusCode: 409 })
    await ctx.updater.cancel()
  })

  it('有命令一直在运行:回退被拒,生效版本不变', async () => {
    let running = false
    const ctx = setup({ activeRuns: () => running, drainTimeoutMs: 60 })
    await run(ctx)
    running = true
    await expect(ctx.updater.rollback()).rejects.toMatchObject({ statusCode: 409 })
    expect(ctx.runtime.version()).toBe(VERSION)
  })
})

describe('扩展版本提醒', () => {
  it.each([
    ['2.0.2', '1.0.24', '1.0.26'],
    ['2.0.2', '1.0.25', '1.0.26'],
    ['2.0.1', '1.0.25', '1.0.26'],
    ['2.0.0', '1.0.24', '1.0.25'],
    ['2.1.0', '1.0.9', '1.0.26'],
  ])('目标 %s、扩展 %s:提醒需要 %s', (target, extension, required) => {
    expect(extensionWarning(target, extension)).toEqual({
      code: 'extension-outdated',
      message: `浏览器扩展 v${extension} 低于 OpenCLI ${target} 需要的 ${required}，部分页面操作可能失败`,
    })
    expect(extensionWarning(target, extension)).not.toHaveProperty('url')
  })

  it.each([
    ['2.0.2', '1.0.26'],
    ['2.0.2', '1.1.0'],
    ['2.0.0', '1.0.25'],
    ['2.0.1', '1.0.26'],
    ['1.9.9', '1.0.1'],
    ['2.0.2', undefined],
    ['2.0.2', 'garbage'],
  ])('目标 %s、扩展 %s:不提醒', (target, extension) => {
    expect(extensionWarning(target, extension)).toBeUndefined()
  })

  it('扩展版本带 v 前缀也认', () => {
    expect(extensionWarning('2.0.2', 'v1.0.24').message).toBe('浏览器扩展 v1.0.24 低于 OpenCLI 2.0.2 需要的 1.0.26，部分页面操作可能失败')
  })

  it('成功后进 job.warnings;信息与示例一致', async () => {
    const ctx = setup({ readExtensionVersion: vi.fn(async () => '1.0.24') })
    const job = await run(ctx)
    expect(job.state).toBe('succeeded')
    expect(job.warnings).toEqual([{
      code: 'extension-outdated',
      message: '浏览器扩展 v1.0.24 低于 OpenCLI 2.0.2 需要的 1.0.26，部分页面操作可能失败',
    }])
    expect(job.warnings[0]).not.toHaveProperty('url')
  })

  it('读不到扩展版本就不加', async () => {
    const ctx = setup({ readExtensionVersion: vi.fn(async () => { throw new Error('daemon down') }) })
    const job = await run(ctx)
    expect(job).toMatchObject({ state: 'succeeded', warnings: [] })
  })

  it('daemon 重启前读不到、重启后读到,也能提醒', async () => {
    const readExtensionVersion = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('1.0.24')
    const ctx = setup({ readExtensionVersion })
    const job = await run(ctx)
    expect(job.warnings.map((warning) => warning.code)).toEqual(['extension-outdated'])
  })

  it('扩展够新:没有提醒', async () => {
    const ctx = setup({ readExtensionVersion: vi.fn(async () => '1.0.26') })
    expect((await run(ctx)).warnings).toEqual([])
  })
})
