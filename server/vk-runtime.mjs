// runtime 安装编排(v2 阶段3):首启检测 active.json,缺失时经 /vk/v1/runtime/*
// 提供 not-installed/installing/installed/failed 类型化状态与单飞安装。
// 进度=安装核心逐行透传的真实输出(已脱敏),不造百分比。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { installVkRuntime } from './vk-runtime-install.mjs'
import {
  listOwnedRuntimeReceipts,
  ownedRuntimeSizeBytesAsync,
  removeOwnedRuntimeReceipt,
  resolveActiveRuntime,
  writeActiveRuntime,
  writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'
import { discoverVkRuntimePaths, probeVkRuntime } from './vk-runtime-probe.mjs'
import {
  RUNTIME_EXTRA_ORDER, getCapabilityPack, inspectLocalAsrCache, mergeRuntimeExtras, normalizeRuntimeExtras, projectCapabilityPacks,
} from './vk-capability-packs.mjs'

const LOG_TAIL_LINES = 60

function pathKey(value) {
  return typeof value === 'string' ? resolve(value).toLowerCase() : null
}

export class VkRuntimeError extends Error {
  constructor(statusCode, reasonCode, message) {
    super(message)
    this.name = 'VkRuntimeError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
  }
}

export class VkRuntimeManager {
  #state = 'unknown'
  #reasonCode = null
  #summary = null
  #log = []
  #installing = null
  #installingExtras = []
  #adopting = false
  #sizeCache = new Map()
  #sizeFlights = new Map()

  constructor({
    home,
    bundleDir,
    installImpl = installVkRuntime,
    discoverImpl = discoverVkRuntimePaths,
    probeImpl = probeVkRuntime,
    env = process.env,
    now = () => new Date().toISOString(),
  } = {}) {
    this.home = home
    this.bundleDir = bundleDir
    this.installImpl = installImpl
    this.discoverImpl = discoverImpl
    this.probeImpl = probeImpl
    this.env = env
    this.allowExternalRuntime = env.OPENCLI_HOST_VK_ALLOW_EXTERNAL_RUNTIME === '1'
    this.now = now
    this.detected = new Map()
  }

  #failurePath() {
    return this.home ? join(resolve(this.home), 'runtime', 'last-install-failure.json') : null
  }

  #persistFailure() {
    const path = this.#failurePath()
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({
        reasonCode: this.#reasonCode,
        summary: this.#summary,
        at: this.now(),
        log: this.#log.slice(-LOG_TAIL_LINES),
      }, null, 2))
    } catch { /* 记不下来也不该让安装流程更糟 */ }
  }

  #clearFailure() {
    const path = this.#failurePath()
    if (!path) return
    try {
      rmSync(path, { force: true })
    } catch { /* 清不掉只是多留一条陈旧记录,不影响可用性 */ }
  }

  /** 上一次安装失败的原因;进程重启后仍读得到。 */
  lastInstallFailure() {
    if (this.#state === 'failed') {
      return { reasonCode: this.#reasonCode, summary: this.#summary ?? '安装失败' }
    }
    const path = this.#failurePath()
    if (!path || !existsSync(path)) return null
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      return { reasonCode: saved.reasonCode ?? 'install-failed', summary: String(saved.summary ?? '安装失败'), at: saved.at }
    } catch {
      return null
    }
  }

  activeRuntime() {
    const runtime = resolveActiveRuntime({ home: this.home, bundleDir: this.bundleDir })
    if (runtime?.source === 'external' && !this.allowExternalRuntime) return null
    return runtime
  }

  status() {
    const active = this.activeRuntime()
    if (this.#installing) {
      return {
        state: 'installing',
        version: active ? String(active.version ?? 'unknown') : null,
        source: active?.source ?? null,
        pythonPath: active?.pythonPath ?? null,
        capabilities: Array.isArray(active?.capabilities) ? active.capabilities : [],
        extras: Array.isArray(active?.extras) ? active.extras : [],
        current: active?.current === true,
        legacyUnreproducible: active?.legacyUnreproducible === true,
        installingExtras: [...this.#installingExtras],
        reasonCode: null,
        summary: '正在安装解析引擎(真实下载/初始化输出见 log)',
        log: this.#log.slice(-LOG_TAIL_LINES),
        checkedAt: this.now(),
      }
    }
    // A capability upgrade never invalidates the old active receipt. Keep the
    // application usable and expose the failed upgrade as secondary metadata.
    if (this.#state === 'failed' && active) {
      return {
        state: 'installed',
        version: String(active.version ?? 'unknown'),
        source: active.source,
        pythonPath: active.pythonPath,
        capabilities: Array.isArray(active.capabilities) ? active.capabilities : [],
        extras: Array.isArray(active.extras) ? active.extras : [],
        current: active.current === true,
        legacyUnreproducible: active.legacyUnreproducible === true,
        reasonCode: null,
        summary: `现有解析引擎仍可使用；新能力安装失败：${this.#summary ?? '安装失败'}`,
        lastInstallFailure: {
          reasonCode: this.#reasonCode,
          summary: this.#summary ?? '安装失败',
        },
        log: this.#log.slice(-LOG_TAIL_LINES),
        checkedAt: this.now(),
      }
    }
    if (active) {
      // 上次装失败、之后进程重启过:此时 #state 已经是初始值,但横幅仍会因为 current=false
      // 而继续显示。把落盘的原因带出来,免得用户面对一个不解释自己的「有更新」。
      const persisted = active.current === true ? null : this.lastInstallFailure()
      return {
        state: 'installed',
        version: String(active.version ?? 'unknown'),
        source: active.source,
        pythonPath: active.pythonPath,
        capabilities: Array.isArray(active.capabilities) ? active.capabilities : [],
        extras: Array.isArray(active.extras) ? active.extras : [],
        current: active.current === true,
        legacyUnreproducible: active.legacyUnreproducible === true,
        ...(persisted ? { lastInstallFailure: persisted } : {}),
        reasonCode: null,
        summary: active.current
          ? `解析引擎已就绪(${active.version ?? 'unknown'})`
          : `现有解析引擎可继续使用，当前安装包有待验证的新运行时(${active.version ?? 'unknown'})`,
        log: this.#log.slice(-LOG_TAIL_LINES),
        checkedAt: this.now(),
      }
    }
    if (this.#state === 'failed') {
      return {
        state: 'failed',
        version: null,
        reasonCode: this.#reasonCode,
        summary: this.#summary ?? '安装失败',
        log: this.#log.slice(-LOG_TAIL_LINES),
        checkedAt: this.now(),
      }
    }
    if (!this.home || !this.bundleDir || !existsSync(join(this.bundleDir, 'runtime-manifest.json'))) {
      return {
        state: 'not-available',
        version: null,
        reasonCode: 'bundle-missing',
        summary: '安装包内没有解析引擎捆绑件(开发形态或包损坏)',
        log: [],
        checkedAt: this.now(),
      }
    }
    return {
      state: 'not-installed',
      version: null,
      source: null,
      reasonCode: null,
      summary: '解析引擎待初始化；将创建专用环境，并复用本机 Python 3.12 与 uv 缓存',
      log: this.#log.slice(-LOG_TAIL_LINES),
      checkedAt: this.now(),
    }
  }

  capabilityPacks() {
    const status = this.status()
    const active = this.activeRuntime()
    const bundleAvailable = !!this.bundleDir
      && existsSync(join(this.bundleDir, 'runtime-manifest.json'))
    return projectCapabilityPacks({
      activeRuntime: active,
      bundleAvailable,
      installingExtras: this.#installingExtras,
      installing: status.state === 'installing',
      localModelCache: inspectLocalAsrCache({ bundleDir: this.bundleDir, home: this.home, env: this.env }),
      checkedAt: this.now(),
    })
  }

  #ownedSnapshot() {
    const active = this.activeRuntime()
    const activePath = pathKey(active?.receiptPath)
    const receipts = listOwnedRuntimeReceipts({ home: this.home, bundleDir: this.bundleDir })
    const rollback = receipts.find((receipt) => pathKey(receipt.receiptPath) !== activePath) ?? null
    return { active, activePath, receipts, rollbackPath: pathKey(rollback?.receiptPath) }
  }

  async #runtimeSize(receipt) {
    if (Number.isSafeInteger(receipt.runtimeSizeBytes) && receipt.runtimeSizeBytes >= 0) {
      return receipt.runtimeSizeBytes
    }
    const key = pathKey(receipt.receiptPath) ?? pathKey(receipt.pythonPath)
    if (key && this.#sizeCache.has(key)) return this.#sizeCache.get(key)
    if (!key) return ownedRuntimeSizeBytesAsync({ home: this.home, runtime: receipt })
    let flight = this.#sizeFlights.get(key)
    if (!flight) {
      flight = ownedRuntimeSizeBytesAsync({ home: this.home, runtime: receipt })
        .then((size) => {
          this.#sizeCache.set(key, size)
          return size
        })
        .finally(() => {
          if (this.#sizeFlights.get(key) === flight) this.#sizeFlights.delete(key)
        })
      this.#sizeFlights.set(key, flight)
    }
    return flight
  }

  async versions() {
    const snapshot = this.#ownedSnapshot()
    const versions = await Promise.all(snapshot.receipts.map(async (receipt) => {
      const receiptPath = pathKey(receipt.receiptPath)
      const active = receiptPath === snapshot.activePath
      const retainedForRollback = !active && receiptPath === snapshot.rollbackPath
      const sizeBytes = await this.#runtimeSize(receipt)
      return {
        version: String(receipt.version ?? 'unknown'),
        installedAt: receipt.installedAt ?? null,
        extras: Array.isArray(receipt.extras) ? receipt.extras : [],
        active,
        current: receipt.current === true,
        legacyUnreproducible: receipt.legacyUnreproducible === true,
        retainedForRollback,
        removable: !active && !retainedForRollback,
        sizeBytes,
      }
    }))
    return {
      versions,
      reclaimableBytes: versions
        .filter((runtime) => runtime.removable)
        .reduce((total, runtime) => total + runtime.sizeBytes, 0),
      checkedAt: this.now(),
    }
  }

  async rollback(version, { afterActivate = async () => {} } = {}) {
    if (this.#installing || this.#adopting) {
      throw new VkRuntimeError(409, 'runtime-busy', '解析环境正在变更，请完成后再回滚')
    }
    if (typeof version !== 'string' || !version.trim()) {
      throw new VkRuntimeError(400, 'invalid-runtime-version', 'version 必须是非空字符串')
    }
    const snapshot = this.#ownedSnapshot()
    const matches = snapshot.receipts.filter((receipt) => String(receipt.version) === version)
    if (matches.length !== 1) {
      throw new VkRuntimeError(
        matches.length ? 409 : 404,
        matches.length ? 'runtime-version-ambiguous' : 'runtime-version-not-found',
        matches.length ? 'runtime 版本标识不唯一' : 'runtime 版本不存在或已失效',
      )
    }
    const selected = matches[0]
    if (pathKey(selected.receiptPath) === snapshot.activePath) return this.status()
    writeActiveRuntime(this.home, selected)
    this.#clearFailure()
    this.#state = 'installed'
    this.#reasonCode = null
    this.#summary = null
    try {
      await afterActivate()
    } catch (error) {
      this.#log.push(`rollback-after-activate: ${String(error?.message ?? error)}`)
    }
    return this.status()
  }

  async cleanup() {
    if (this.#installing || this.#adopting) {
      throw new VkRuntimeError(409, 'runtime-busy', '解析环境正在变更，请完成后再清理')
    }
    const snapshot = this.#ownedSnapshot()
    const removed = []
    for (const receipt of snapshot.receipts) {
      const receiptPath = pathKey(receipt.receiptPath)
      if (receiptPath === snapshot.activePath || receiptPath === snapshot.rollbackPath) continue
      try {
        removed.push(removeOwnedRuntimeReceipt({ home: this.home, runtime: receipt }))
      } catch (error) {
        throw new VkRuntimeError(409, 'runtime-cleanup-failed', String(error?.message ?? error))
      }
    }
    const remaining = await this.versions()
    return {
      ...remaining,
      removed,
      reclaimedBytes: removed.reduce((total, runtime) => total + runtime.sizeBytes, 0),
    }
  }

  async detect() {
    const paths = this.discoverImpl({
      home: this.home,
      bundleDir: this.bundleDir,
      env: this.env,
      allowExternalRuntime: this.allowExternalRuntime,
    })
    const activePath = this.activeRuntime()?.pythonPath?.toLowerCase() ?? null
    const candidates = []
    this.detected.clear()
    for (const path of paths) {
      if (!this.allowExternalRuntime && path.source !== 'app-owned') continue
      const candidate = await this.probeImpl(path)
      candidates.push({ ...candidate, active: candidate.pythonPath.toLowerCase() === activePath })
      this.detected.set(String(candidate.pythonPath).toLowerCase(), path.source)
    }
    return { candidates, checkedAt: this.now() }
  }

  async adopt(pythonPath, beforeActivate = async () => {}) {
    if (this.#installing || this.#adopting) {
      throw new VkRuntimeError(409, 'runtime-busy', '解析环境正在安装，请完成后再接管')
    }
    if (typeof pythonPath !== 'string') {
      throw new VkRuntimeError(400, 'invalid-python-path', 'pythonPath 必须是字符串')
    }
    const known = this.detected.get(pythonPath.toLowerCase())
    if (!known) {
      throw new VkRuntimeError(400, 'candidate-not-detected', '请先执行受控发现，再选择候选环境')
    }
    if (known !== 'app-owned' && !this.allowExternalRuntime) {
      throw new VkRuntimeError(403, 'external-runtime-disabled', '生产模式不接管外部解析环境')
    }
    this.#adopting = true
    try {
      const candidate = await this.probeImpl({ pythonPath, source: known })
      if (!candidate.compatible) {
        throw new VkRuntimeError(409, candidate.reason ?? 'protocol-mismatch', '候选解析环境未通过兼容探针')
      }
      await beforeActivate()
      const ownedReceipt = known === 'app-owned'
        ? listOwnedRuntimeReceipts({ home: this.home, bundleDir: this.bundleDir })
          .find((item) => item.pythonPath.toLowerCase() === candidate.pythonPath.toLowerCase())
        : null
      const receipt = ownedReceipt ?? writeRuntimeReceipt(this.home, {
        schema: 'vk-runtime-receipt@1',
        source: 'external',
        version: candidate.version,
        pythonPath: candidate.pythonPath,
        apiVersion: candidate.apiVersion,
        schemaVersion: candidate.schemaVersion,
        capabilities: candidate.capabilities,
        adoptedAt: this.now(),
        discoveredAs: known,
      })
      writeActiveRuntime(this.home, receipt)
      this.#state = 'installed'
      this.#reasonCode = null
      this.#summary = null
      return this.status()
    } finally {
      this.#adopting = false
    }
  }

  /**
   * 安装(或重建)爪爪专用解析环境。
   *
   * `rebuild` 存在的理由:没有它时,已装状态下 install() 会**静默返回**,而界面上
   * 那个按钮恰恰只在已装时才叫「重建」—— 于是它在唯一被叫做重建的场景里保证空转,
   * 既没禁用也没变灰,点了就是没反应。底层其实完全支持重建
   * (vk-runtime-install.mjs 会先删掉旧版本目录再建),缺的只是这条通路。
   *
   * `beforeRebuild` 与 adopt 的 beforeActivate 同款,用来先停 sidecar:重建要删掉
   * 版本目录,而 Windows 上正在跑的 python.exe 会把目录锁住,不停就是 EBUSY。
   */
  async install({
    rebuild = false,
    beforeRebuild = async () => {},
    extras = [],
    afterActivate = async () => {},
  } = {}) {
    if (this.#adopting) {
      throw new VkRuntimeError(409, 'runtime-busy', '正在接管已有解析环境，请完成后再安装')
    }
    let requestedExtras
    try {
      requestedExtras = normalizeRuntimeExtras(extras)
    } catch (error) {
      throw new VkRuntimeError(400, error.reasonCode ?? 'invalid-runtime-extra', error.message)
    }
    const active = this.activeRuntime()
    const currentExtras = normalizeRuntimeExtras(
      Array.isArray(active?.extras)
        ? active.extras.filter((extra) => typeof extra === 'string' && RUNTIME_EXTRA_ORDER.includes(extra))
        : [],
    )
    const cumulativeExtras = mergeRuntimeExtras(currentExtras, requestedExtras)
    const capabilityInstall = requestedExtras.length > 0
    if (this.#installing) {
      // Preserve single-flight for duplicate calls, but do not return a
      // promise for a different package request.
      if (!cumulativeExtras.every((extra) => this.#installingExtras.includes(extra))) {
        throw new VkRuntimeError(409, 'runtime-busy', '能力包正在安装，请等待当前安装完成')
      }
      return this.#installing
    }
    const snapshot = this.status()
    if (capabilityInstall && requestedExtras.length > 0) {
      const missing = cumulativeExtras.filter((extra) => !currentExtras.includes(extra))
      if (!missing.length && snapshot.state === 'installed' && snapshot.current) return snapshot
    } else if (snapshot.state === 'installed') {
      if (!rebuild && snapshot.current) return snapshot
      if (rebuild && snapshot.current) await beforeRebuild()
    }
    if (snapshot.state === 'not-available') {
      const error = new Error(snapshot.summary)
      error.reasonCode = 'bundle-missing'
      error.statusCode = 503
      throw error
    }
    this.#log = []
    this.#state = 'installing'
    this.#installingExtras = cumulativeExtras
    this.#installing = this.installImpl({
      home: this.home,
      bundleDir: this.bundleDir,
      env: this.env,
      extras: cumulativeExtras,
      log: (line) => {
        this.#log.push(String(line))
        if (this.#log.length > 500) this.#log.shift()
      },
    }).then(async (result) => {
      this.#state = 'installed'
      this.#reasonCode = null
      this.#summary = null
      try {
        await afterActivate()
      } catch (error) {
        // active.json already points at the new verified runtime. A sidecar
        // stop failure must not turn that successful activation into a false
        // install failure; the next request can still retry stop/start.
        this.#log.push(`after-activate: ${String(error?.message ?? error)}`)
      }
      return result
    }).catch((error) => {
      this.#state = 'failed'
      this.#reasonCode = error?.reasonCode ?? 'install-failed'
      this.#summary = String(error?.message ?? '安装失败')
      if (error?.detail) this.#log.push(String(error.detail))
      // 失败原因原先只活在内存里,应用一重启就没了:用户看到的是一个「有更新」的横幅,
      // 点了、等了几分钟、横幅还在,而且没有任何说明——真机上连点两次都这样。
      // 落盘之后重启也能把上次为什么没装上讲清楚。
      this.#persistFailure()
      throw error
    }).finally(() => {
      this.#installing = null
      this.#installingExtras = []
    })
    return this.#installing
  }

  async installCapabilityPack(packId, { afterActivate = async () => {} } = {}) {
    const pack = getCapabilityPack(packId)
    const active = this.activeRuntime()
    const currentExtras = normalizeRuntimeExtras(
      Array.isArray(active?.extras)
        ? active.extras.filter((extra) => typeof extra === 'string' && RUNTIME_EXTRA_ORDER.includes(extra))
        : [],
    )
    const cumulativeExtras = mergeRuntimeExtras(currentExtras, pack.extras)
    const status = this.status()
    if (
      !cumulativeExtras.some((extra) => !currentExtras.includes(extra))
      && status.state === 'installed'
      && status.current
    ) {
      return status
    }
    return this.install({
      extras: pack.extras,
      afterActivate,
    }).then(() => this.status())
  }
}
