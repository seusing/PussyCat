// runtime 安装编排(v2 阶段3):首启检测 active.json,缺失时经 /vk/v1/runtime/*
// 提供 not-installed/installing/installed/failed 类型化状态与单飞安装。
// 进度=安装核心逐行透传的真实输出(已脱敏),不造百分比。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installVkRuntime } from './vk-runtime-install.mjs'

const LOG_TAIL_LINES = 60

export class VkRuntimeManager {
  #state = 'unknown'
  #reasonCode = null
  #summary = null
  #log = []
  #installing = null

  constructor({ home, bundleDir, installImpl = installVkRuntime, now = () => new Date().toISOString() } = {}) {
    this.home = home
    this.bundleDir = bundleDir
    this.installImpl = installImpl
    this.now = now
  }

  #activePointer() {
    if (!this.home) return null
    const pointer = join(this.home, 'runtime', 'active.json')
    if (!existsSync(pointer)) return null
    try {
      const parsed = JSON.parse(readFileSync(pointer, 'utf8'))
      return typeof parsed.pythonPath === 'string' && existsSync(parsed.pythonPath) ? parsed : null
    } catch {
      return null
    }
  }

  status() {
    const active = this.#activePointer()
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
      reasonCode: null,
      summary: '解析引擎未安装;点击安装开始(需要网络下载独立 Python)',
      log: this.#log.slice(-LOG_TAIL_LINES),
      checkedAt: this.now(),
    }
  }

  async install() {
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
