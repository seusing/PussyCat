// runtime 安装编排(v2 阶段3):首启检测 active.json,缺失时经 /vk/v1/runtime/*
// 提供 not-installed/installing/installed/failed 类型化状态与单飞安装。
// 进度=安装核心逐行透传的真实输出(已脱敏),不造百分比。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installVkRuntime } from './vk-runtime-install.mjs'
import {
  listOwnedRuntimeReceipts, resolveActiveRuntime, writeActiveRuntime, writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'
import { discoverVkRuntimePaths, probeVkRuntime } from './vk-runtime-probe.mjs'

const LOG_TAIL_LINES = 60

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
  #adopting = false

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
    this.now = now
    this.detected = new Map()
  }

  activeRuntime() {
    return resolveActiveRuntime({ home: this.home, bundleDir: this.bundleDir })
  }

  status() {
    const active = this.activeRuntime()
    if (this.#installing) {
      return {
        state: 'installing',
        version: null,
        reasonCode: null,
        summary: '正在安装解析引擎(真实下载/初始化输出见 log)',
        log: this.#log.slice(-LOG_TAIL_LINES),
        checkedAt: this.now(),
      }
    }
    if (active) {
      return {
        state: 'installed',
        version: String(active.version ?? 'unknown'),
        source: active.source,
        pythonPath: active.pythonPath,
        capabilities: Array.isArray(active.capabilities) ? active.capabilities : [],
        extras: Array.isArray(active.extras) ? active.extras : [],
        reasonCode: null,
        summary: `解析引擎已就绪(${active.version ?? 'unknown'})`,
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

  async detect() {
    const paths = this.discoverImpl({ home: this.home, bundleDir: this.bundleDir, env: this.env })
    const activePath = this.activeRuntime()?.pythonPath?.toLowerCase() ?? null
    const candidates = []
    this.detected.clear()
    for (const path of paths) {
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

  async install() {
    if (this.#adopting) {
      throw new VkRuntimeError(409, 'runtime-busy', '正在接管已有解析环境，请完成后再安装')
    }
    if (this.#installing) return this.#installing
    const snapshot = this.status()
    if (snapshot.state === 'installed') return snapshot
    if (snapshot.state === 'not-available') {
      const error = new Error(snapshot.summary)
      error.reasonCode = 'bundle-missing'
      error.statusCode = 503
      throw error
    }
    this.#log = []
    this.#state = 'installing'
    this.#installing = this.installImpl({
      home: this.home,
      bundleDir: this.bundleDir,
      log: (line) => {
        this.#log.push(String(line))
        if (this.#log.length > 500) this.#log.shift()
      },
    }).then((result) => {
      this.#state = 'installed'
      this.#reasonCode = null
      this.#summary = null
      return result
    }).catch((error) => {
      this.#state = 'failed'
      this.#reasonCode = error?.reasonCode ?? 'install-failed'
      this.#summary = String(error?.message ?? '安装失败')
      if (error?.detail) this.#log.push(String(error.detail))
      throw error
    }).finally(() => {
      this.#installing = null
    })
    return this.#installing
  }
}
