// 应用内更新 OpenCLI:查询 → 下载 → 安装 → 套原生命令 → 裁站点 → 校验 → 切换。
// 一次只有一个任务,每个阶段结束推进百分比(由宿主算,界面只展示);任何阶段失败或取消,
// 清掉临时目录,生效版本不变。只有最后的切换会改变 active.json。
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { RETAINED_SITE_KEYS } from '../src/shared/opencli-sites.mjs'
import { readListOutput, stripBom } from '../src/shared/normalize.mjs'
import { applyOpencliOverrides } from './opencli-overrides.mjs'
import { REGISTRIES, describeNetworkError, fetchPackageMetadata } from './opencli-release.mjs'
import { versionEntry } from './opencli-runtime.mjs'
import { REVIEWED_RECORDS } from './policy-metadata.mjs'

export class OpencliUpdateError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'OpencliUpdateError'
    this.statusCode = statusCode
  }
}

// 任务内部的失败:summary 给人看(中文),detail 留原始信息。
class StageError extends Error {
  constructor(summary, detail) {
    super(summary)
    this.summary = summary
    this.detail = detail
  }
}

const SEMVER = /^\d+\.\d+\.\d+$/
const INSTALL_REGISTRY = 'https://registry.npmmirror.com'
const SWITCHING_MESSAGE = '正在切换 OpenCLI，请稍候'
// 这些命令是爪爪自己的原生命令(opencli-overrides),新包里必须在。
const NATIVE_COMMANDS = ['collections', 'search', 'user-posts', 'note', 'comments', 'saved']
const RETAINED_SITES = new Set(RETAINED_SITE_KEYS)
// 扩展版本下限:OpenCLI 2.0.0 要 1.0.25,2.0.1 起要 1.0.26。
const EXTENSION_MINIMUMS = [['2.0.1', '1.0.26'], ['2.0.0', '1.0.25']]

const parseVersion = (text) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return match ? match.slice(1).map(Number) : undefined
}

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return Number.NaN
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

/** 目标版本需要更新的扩展而已连接的扩展太旧时给出提醒;读不到扩展版本就不提醒。 */
export function extensionWarning(targetVersion, extensionVersion) {
  const required = EXTENSION_MINIMUMS.find(([opencli]) => compareVersions(targetVersion, opencli) >= 0)?.[1]
  if (!required || !(compareVersions(extensionVersion, required) < 0)) return undefined
  return {
    code: 'extension-outdated',
    message: `浏览器扩展 v${String(extensionVersion).replace(/^v/, '')} 低于 OpenCLI ${targetVersion} 需要的 ${required}，部分页面操作可能失败`,
  }
}

const tail = (text, limit = 2000) => String(text ?? '').trim().slice(-limit)

/** 起子进程收集输出;abort 或超时就杀掉。永不 reject。 */
function collectProcess(command, args, { cwd, env, signal, timeoutMs, maxStdoutBytes = 8 * 1024 * 1024 }) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
      return
    }
    const stdout = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const kill = () => child.kill('SIGKILL')
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      resolvePromise(result)
    }
    const timer = setTimeout(() => { kill(); finish({ code: null, stdout: '', stderr: `timeout after ${timeoutMs}ms` }) }, timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maxStdoutBytes) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
    child.once('error', (error) => finish({ code: null, stdout: '', stderr: error.message }))
    child.once('close', (code) => finish({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr }))
  })
}

const defaultRunNpm = ({ npmCli, args, cwd, signal, timeoutMs }) =>
  collectProcess(process.execPath, [npmCli, ...args], { cwd, env: process.env, signal, timeoutMs })

const defaultRunCli = (entry, args, { env, signal, timeoutMs }) =>
  collectProcess(process.execPath, [entry, ...args], { env, signal, timeoutMs })

// npm 随 Node.js 一起装在可执行文件旁边;找不到就没法装依赖。
const defaultFindNpmCli = () => {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(npmCli) ? npmCli : null
}

// 宿主根目录(仓库或 dist-host)下的原生命令源文件。
const defaultOverridesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'opencli-overrides', 'xiaohongshu')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function createOpencliUpdate({
  runtime,
  catalogService,
  hasActiveRuns = () => false,
  restartDaemon = async () => ({ failed: false }),
  stopVideoEngine = async () => {},
  readExtensionVersion = async () => undefined,
  fetchImpl = (url, init) => fetch(url, init),
  runNpm = defaultRunNpm,
  runCli = defaultRunCli,
  findNpmCli = defaultFindNpmCli,
  overridesDir = defaultOverridesDir,
  now = Date.now,
  resolveTimeoutMs = 15_000,
  installTimeoutMs = 300_000,
  verifyTimeoutMs = 60_000,
  drainTimeoutMs = 15_000,
}) {
  const root = runtime.root
  let job = null          // 最近一次任务(含已结束的)
  let running = null      // { controller, promise },仅任务进行中
  let switching = false

  const view = () => job && {
    ...job,
    error: job.error && { ...job.error },
    warnings: job.warnings.map((warning) => ({ ...warning })),
  }

  // ---- 切换:等在跑的命令结束 → 换 active.json → 重启 daemon / 刷新目录 / 停视频引擎 ----

  async function enterSwitching() {
    switching = true
    const deadline = Date.now() + drainTimeoutMs
    while (hasActiveRuns()) {
      if (Date.now() >= deadline) {
        switching = false
        throw new StageError('还有命令在运行，没法切换，等它们结束后再试', `drain timeout ${drainTimeoutMs}ms`)
      }
      await sleep(50)
    }
  }

  // 切换后半段:更新和回退共用。daemon 重启失败只记警告,目录刷新失败要抛出。
  async function afterSwitch(warnings) {
    const restarted = await Promise.resolve().then(restartDaemon).catch((error) => ({ failed: true, detail: error?.message }))
    if (restarted?.failed) {
      warnings.push({ code: 'daemon-restart-failed', message: 'OpenCLI 后台服务没能自动重启，浏览器命令首次运行时会再试一次' })
    }
    await catalogService?.refresh()
    try {
      await stopVideoEngine()
    } catch {
      warnings.push({ code: 'engine-stop-failed', message: '视频引擎没能自动停止，重启爪爪后会用新的 OpenCLI' })
    }
  }

  // ---- 阶段 ----

  async function resolveRelease(version, signal) {
    let metadata
    try {
      metadata = await Promise.any(REGISTRIES.map(async (registry) => {
        const body = await fetchPackageMetadata(registry, version, { fetchImpl, timeoutMs: resolveTimeoutMs, signal })
        if (typeof body?.dist?.tarball !== 'string') throw new Error(`${new URL(registry).host} 的响应里没有下载地址`)
        return body
      }))
    } catch (error) {
      if (signal.aborted) throw error
      throw new StageError(`查不到 OpenCLI ${version}`, error.errors.map((reason) => reason.message).join('；'))
    }
    const integrity = String(metadata.dist.integrity ?? '').split(/\s+/).find((token) => token.startsWith('sha512-'))
    if (!integrity) throw new StageError('这个版本缺少完整性校验信息，不能安装', JSON.stringify(metadata.dist))
    return { tarball: metadata.dist.tarball, integrity }
  }

  async function download({ tarball, integrity }, file, signal, j) {
    mkdirSync(dirname(file), { recursive: true })
    const { host } = new URL(tarball)
    let response
    try {
      response = await fetchImpl(tarball, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new StageError('下载失败', `连不上 ${host}：${describeNetworkError(error, resolveTimeoutMs)}`)
    }
    if (!response.ok || !response.body) throw new StageError('下载失败', `${host} 返回 HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length'))
    j.totalBytes = Number.isFinite(length) && length > 0 ? length : null
    const hash = createHash('sha512')
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk)
        j.receivedBytes += chunk.length
        if (j.totalBytes) j.percent = Math.min(60, Math.floor((j.receivedBytes / j.totalBytes) * 60))
        done(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file), { signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new StageError('下载中断', describeNetworkError(error, resolveTimeoutMs))
    }
    if (`sha512-${hash.digest('base64')}` !== integrity) {
      throw new StageError('下载的文件校验不通过，已丢弃', `expected ${integrity}`)
    }
  }

  async function install(tarball, stagingDir, signal) {
    const npmCli = findNpmCli()
    if (!npmCli) throw new StageError('没找到 npm，需要随 Node.js 一起安装', join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true })
    writeFileSync(join(stagingDir, 'package.json'), `${JSON.stringify({ name: 'opencli-runtime', private: true, version: '0.0.0' }, null, 2)}\n`)
    const result = await runNpm({
      npmCli,
      cwd: stagingDir,
      signal,
      timeoutMs: installTimeoutMs,
      args: ['install', tarball, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${INSTALL_REGISTRY}`],
    })
    if (signal.aborted) throw new Error('aborted')
    if (result.code !== 0) throw new StageError('安装依赖失败', tail(result.stderr))
  }

  const packageRootOf = (dir) => join(dir, 'node_modules', '@jackwener', 'opencli')
  const readManifest = (packageRoot) => JSON.parse(stripBom(readFileSync(join(packageRoot, 'cli-manifest.json'), 'utf8')))

  // 只留保留清单里的站点:manifest 条目与 clis/<站点>/ 目录一起删,_shared 之类非站点目录不动。
  function prune(packageRoot) {
    const manifest = readManifest(packageRoot)
    const removed = [...new Set(manifest.map((entry) => entry.site))].filter((site) => !RETAINED_SITES.has(site))
    writeFileSync(join(packageRoot, 'cli-manifest.json'), `${JSON.stringify(manifest.filter((entry) => RETAINED_SITES.has(entry.site)), null, 2)}\n`)
    for (const site of removed) rmSync(join(packageRoot, 'clis', site), { recursive: true, force: true })
    return removed
  }

  async function verify(version, packageRoot, removedSites, signal) {
    const entry = join(packageRoot, 'dist', 'src', 'main.js')
    // 用空的用户目录跑,免得用户自己装的适配器(~/.opencli/clis)混进目录判断。
    const home = join(root, 'staging', `home-${version}`)
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, CI: '1', HOME: home, USERPROFILE: home }
    const run = (args) => runCli(entry, args, { env, signal, timeoutMs: verifyTimeoutMs })

    const versionResult = await run(['--version'])
    if (versionResult.code !== 0 || versionResult.stdout.trim() !== version) {
      throw new StageError('校验失败：新版本跑不起来或版本号不符', `${tail(versionResult.stdout)} ${tail(versionResult.stderr)}`)
    }

    let listOutput
    try {
      listOutput = await readListOutput(async (extraArgs) => {
        const result = await run(['list', '-f', 'json', ...extraArgs])
        if (result.code !== 0) throw new Error(`opencli list exited with code ${result.code}: ${tail(result.stderr)}`)
        return stripBom(result.stdout)
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new StageError('校验失败：读不出命令目录', error instanceof Error ? error.message : String(error))
    }
    const listedKeys = new Set(listOutput.list.map((item) => String(item.command).replace(' ', '/')))
    const listedSites = new Set(listOutput.list.map((item) => item.site ?? String(item.command).split(/[ /]/)[0]))
    const leftover = removedSites.filter((site) => listedSites.has(site))
    if (leftover.length) throw new StageError('校验失败：被裁掉的站点还在命令目录里', leftover.join(', '))

    const manifestKeys = new Set(readManifest(packageRoot).map((item) => `${item.site}/${item.name}`))
    const reviewed = [...REVIEWED_RECORDS.keys()].filter((key) => RETAINED_SITES.has(key.split('/')[0]))
    const required = [...reviewed, ...NATIVE_COMMANDS.map((name) => `xiaohongshu/${name}`)]
    const notInManifest = required.filter((key) => !manifestKeys.has(key))
    if (notInManifest.length) throw new StageError('校验失败：新版本缺少必需的命令', notInManifest.join(', '))
    const notLoadable = required.filter((key) => !listedKeys.has(key))
    if (notLoadable.length) throw new StageError('校验失败：必需的命令加载不了', notLoadable.join(', '))

    for (const name of NATIVE_COMMANDS) {
      const help = await run(['xiaohongshu', name, '--help', '-f', 'json'])
      let parsed
      try {
        parsed = JSON.parse(stripBom(help.stdout))
      } catch {
        parsed = undefined
      }
      if (help.code !== 0 || !parsed || typeof parsed !== 'object') {
        throw new StageError(`校验失败：原生命令 xiaohongshu ${name} 不能用`, tail(help.stderr))
      }
    }
  }

  // 返回切换时读到的扩展版本(可能为空)。
  async function switchOver(version, stagingDir, j) {
    await enterSwitching()
    const previous = runtime.active()
    try {
      const finalDir = join(root, 'versions', version)
      rmSync(finalDir, { recursive: true, force: true })
      renameSync(stagingDir, finalDir)
      let extensionVersion = await Promise.resolve().then(() => readExtensionVersion(version)).catch(() => undefined)
      runtime.activate(version, versionEntry(root, version))
      try {
        await afterSwitch(j.warnings)
      } catch (error) {
        // 目录刷新失败:退回切换前的版本,免得入口和策略对不上。
        if (previous) runtime.activate(previous.version, previous.entry)
        else runtime.rollback()
        await Promise.resolve().then(restartDaemon).catch(() => {})
        await catalogService?.refresh().catch(() => {})
        throw new StageError('切换后刷新命令目录失败，已退回原来的版本', error instanceof Error ? error.message : String(error))
      }
      extensionVersion ??= await Promise.resolve().then(() => readExtensionVersion(version)).catch(() => undefined)
      return extensionVersion
    } finally {
      switching = false
    }
  }

  // ---- 任务编排 ----

  async function execute(j, signal) {
    const { version } = j
    const stagingTgz = join(root, 'staging', `${version}.tgz`)
    const stagingDir = join(root, 'versions', `${version}.staging`)
    const packageRoot = packageRootOf(stagingDir)
    const begin = (stage) => { signal.throwIfAborted(); j.stage = stage }
    const done = (percent) => { j.percent = percent }
    try {
      begin('resolve')
      const release = await resolveRelease(version, signal)
      done(0)

      begin('download')
      await download(release, stagingTgz, signal, j)
      done(60)

      begin('install')
      await install(stagingTgz, stagingDir, signal)
      done(70)

      begin('native')
      try {
        applyOpencliOverrides({ packageRoot, sourceDir: overridesDir })
      } catch (error) {
        throw new StageError('套用爪爪的原生命令失败', error instanceof Error ? error.message : String(error))
      }
      done(80)

      begin('prune')
      let removedSites
      try {
        removedSites = prune(packageRoot)
      } catch (error) {
        throw new StageError('裁剪站点失败', error instanceof Error ? error.message : String(error))
      }
      done(88)

      begin('verify')
      await verify(version, packageRoot, removedSites, signal)
      done(95)

      begin('switch')
      const extensionVersion = await switchOver(version, stagingDir, j)
      const warning = extensionWarning(version, extensionVersion)
      if (warning) j.warnings.push(warning)
      j.stage = 'done'
      done(100)
      j.state = 'succeeded'
    } catch (error) {
      if (signal.aborted) {
        j.state = 'cancelled'
      } else {
        j.state = 'failed'
        j.error = error instanceof StageError
          ? { summary: error.summary, detail: error.detail ?? '' }
          : { summary: `更新失败：${error instanceof Error ? error.message : String(error)}`, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) }
      }
    } finally {
      rmSync(stagingTgz, { force: true })
      rmSync(stagingDir, { recursive: true, force: true })
      rmSync(join(root, 'staging', `home-${version}`), { recursive: true, force: true })
      j.finishedAt = now()
    }
  }

  return {
    current: view,
    isSwitching: () => switching,
    assertNotSwitching() {
      if (switching) throw new OpencliUpdateError(503, SWITCHING_MESSAGE)
    },
    start(version) {
      if (typeof version !== 'string' || !SEMVER.test(version)) {
        throw new OpencliUpdateError(400, 'version must look like 2.0.2')
      }
      if (running) throw new OpencliUpdateError(409, '已有更新任务在进行')
      if (switching) throw new OpencliUpdateError(409, SWITCHING_MESSAGE)
      if (hasActiveRuns()) throw new OpencliUpdateError(409, '有命令正在运行，等它们结束后再更新')
      const controller = new AbortController()
      const j = {
        id: randomUUID(),
        version,
        state: 'running',
        stage: 'resolve',
        receivedBytes: 0,
        totalBytes: null,
        percent: 0,
        error: null,
        warnings: [],
        startedAt: now(),
        finishedAt: null,
      }
      job = j
      const promise = execute(j, controller.signal)
      running = { controller, promise }
      void promise.finally(() => { if (running?.promise === promise) running = null })
      return view()
    },
    /** 取消进行中的任务并等它收尾;已进入切换阶段就不能取消了。 */
    async cancel() {
      if (running && job.stage !== 'switch') {
        running.controller.abort()
        await running.promise
      }
      return view()
    },
    /** 退回内置版本,并做和更新一样的切换后半段。 */
    async rollback() {
      if (running) throw new OpencliUpdateError(409, '更新任务进行中，不能回退')
      const warnings = []
      try {
        await enterSwitching()
        try {
          const hadActive = runtime.active()
          runtime.rollback()
          if (hadActive) await afterSwitch(warnings)
        } finally {
          switching = false
        }
      } catch (error) {
        if (error instanceof StageError) throw new OpencliUpdateError(409, error.summary)
        throw new OpencliUpdateError(502, `回退后刷新命令目录失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { active: null }
    },
    close() {
      running?.controller.abort()
    },
  }
}
