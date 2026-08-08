// video-knowledge Python sidecar 的独立管理器(vk-shell-v1 契约消费方)。
//
// 明确**不复用** RunManager 的一次性命令语义:那套 90 秒墙钟超时、单输出捕获、
// 进程即命令的模型描述的是 opencli 只读命令;sidecar 是常驻服务进程——
// 生命周期 = spawn → ready 握手(gui= 行,契约冻结含 flush)→ /api/meta 版本
// 兼容检查 → 服务中(按需 fetchApi)→ deliberate stop 或异常退出诊断。
//
// 安全边界(拍板 5):token 由本管理器随机生成、仅经子进程环境(VK_UI_TOKEN)
// 注入,不落日志、不进 health 投影、不回传前端;stderr 诊断先脱敏再保留。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export class VkSidecarError extends Error {
  constructor(statusCode, message, { reasonCode = 'sidecar-error', detail } = {}) {
    super(message)
    this.name = 'VkSidecarError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
    if (detail) this.detail = detail
  }
}

const CREDENTIAL_PARAM = /(xsec_token|token|cookie|api[_-]?key|authorization|sessdata)=([^\s&"']+)/gi
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s'"<>|?*]*/g
const UNIX_PATH = /(?<![\w:])\/(?:home|tmp|Users|var)\/[^\s'"<>|?*]*/g

function basenameOf(matched) {
  const parts = matched.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : '<path>'
}

// stderr/诊断文本脱敏:显式密钥 → 凭据参数 → 绝对路径折叠为 basename。
export function scrubSidecarText(text, secrets = []) {
  let scrubbed = String(text)
  for (const secret of secrets) {
    if (secret) scrubbed = scrubbed.split(secret).join('***')
  }
  scrubbed = scrubbed.replace(CREDENTIAL_PARAM, (_match, key) => `${key}=***`)
  scrubbed = scrubbed.replace(WINDOWS_PATH, basenameOf)
  scrubbed = scrubbed.replace(UNIX_PATH, basenameOf)
  return scrubbed
}

const READY_LINE = /^gui=http:\/\/127\.0\.0\.1:(\d+)$/
const DEFAULT_CHROME_CDP_URL = 'http://127.0.0.1:9224'

function lineSplitter(onLine) {
  let buffered = ''
  return (chunk) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split(/\r\n|[\r\n]/)
    buffered = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
}

function parseApiVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export class VkSidecarManager {
  #child = null
  #port = null
  #token = null
  #meta = null
  #state
  #diagnostic = null
  #starting = null
  #stopping = null
  #deliberateStop = false
  #stderrTail = []

  constructor({
    pythonPath,
    runtimeResolver,
    homeDir,
    rootDir,
    configDir,
    spawnImpl = spawn,
    fetchImpl = fetch,
    now = () => new Date().toISOString(),
    randomToken = () => randomBytes(32).toString('base64url'),
    readyTimeoutMs = 30_000,
    stopGraceMs = 2_000,
    healthTimeoutMs = 5_000,
    requiredApiMajor = 1,
    requiredApiMinor = 1,
    requiredSchemaMajor = 1,
    requiredSchemaMinor = 1,
    maxWorkers = 1,
    stderrTailLines = 40,
    baseEnv = process.env,
  } = {}) {
    this.pythonPath = pythonPath
    this.runtimeResolver = runtimeResolver
    this.homeDir = homeDir
    this.rootDir = rootDir
    this.configDir = configDir
    this.spawnImpl = spawnImpl
    this.fetchImpl = fetchImpl
    this.now = now
    this.randomToken = randomToken
    this.readyTimeoutMs = readyTimeoutMs
    this.stopGraceMs = stopGraceMs
    this.healthTimeoutMs = healthTimeoutMs
    this.requiredApiMajor = requiredApiMajor
    this.requiredApiMinor = requiredApiMinor
    this.requiredSchemaMajor = requiredSchemaMajor
    this.requiredSchemaMinor = requiredSchemaMinor
    this.maxWorkers = maxWorkers
    this.stderrTailLines = stderrTailLines
    this.baseEnv = baseEnv
    this.#state = (pythonPath || homeDir) ? 'stopped' : 'not-configured'
  }

  // spawn 时动态调用统一 resolver；adopt 先 stop，下一次请求即可读取新 active，
  // 首启安装完成后**无需重启 Node** 即可拉起 sidecar(v2 阶段3)。
  #resolvePython() {
    if (this.pythonPath) return this.pythonPath
    try {
      const runtime = this.runtimeResolver?.()
      if (runtime?.pythonPath) return runtime.pythonPath
    } catch {
      // 统一落到下方显式开发注入或 not-installed 诊断。
    }
    return null
  }

  // 环境级健康投影(浏览器桥同款纪律):正向枚举字段,pid/port/token/路径一律不出现。
  health() {
    const reasonCode = this.#state === 'ok'
      ? 'ok'
      : this.#diagnostic?.reasonCode ?? this.#state
    const summary = this.#state === 'ok'
      ? 'video-knowledge sidecar 就绪'
      : this.#diagnostic?.summary ?? this.#defaultSummary()
    return {
      status: this.#state,
      reasonCode,
      summary,
      ...(this.#diagnostic?.detail ? { detail: this.#diagnostic.detail } : {}),
      apiVersion: this.#meta?.api_version ?? null,
      schemaVersion: this.#meta?.processing_request_schema_version ?? null,
      packageVersion: this.#meta?.package_version ?? null,
      capabilities: this.#meta?.capabilities ?? [],
      checkedAt: this.now(),
      retryable: this.#state === 'failed' || this.#state === 'starting',
    }
  }

  #defaultSummary() {
    switch (this.#state) {
      case 'not-configured':
        return 'video-knowledge runtime 未配置(缺 OPENCLI_HOST_VK_PYTHON/OPENCLI_HOST_VK_ROOT)'
      case 'stopped':
        return 'sidecar 未启动(首个 /vk/v1 请求会按需拉起)'
      case 'starting':
        return 'sidecar 启动中'
      default:
        return 'sidecar 不可用'
    }
  }

  async ensureStarted() {
    if (this.#state === 'ok' && this.#child) {
      return { port: this.#port, token: this.#token }
    }
    const resolvedPython = this.#resolvePython()
    if (!resolvedPython || !this.rootDir) {
      this.#state = 'not-configured'
      throw new VkSidecarError(503, 'video-knowledge runtime 未安装或未配置', {
        reasonCode: this.homeDir ? 'not-installed' : 'not-configured',
        detail: this.homeDir
          ? '解析引擎尚未安装:走 /vk/v1/runtime/install 首启安装'
          : '设置 OPENCLI_HOST_VK_PYTHON 或 OPENCLI_HOST_VK_HOME 后重试',
      })
    }
    this.resolvedPythonPath = resolvedPython
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null
      })
    }
    return this.#starting
  }

  async #start() {
    this.#deliberateStop = false
    this.#diagnostic = null
    this.#meta = null
    this.#stderrTail = []
    this.#state = 'starting'
    const token = this.randomToken()
    this.#token = token

    const argv = ['-m', 'video_knowledge', 'gui', '--root', this.rootDir]
    if (this.configDir) argv.push('--config-dir', this.configDir)
    argv.push('--port', '0', '--no-browser', '--max-workers', String(this.maxWorkers))

    const child = this.spawnImpl(this.resolvedPythonPath ?? this.pythonPath, argv, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...this.baseEnv,
        VK_CHROME_CDP_URL: this.baseEnv.VK_CHROME_CDP_URL
          ?? this.baseEnv.vk_chrome_cdp_url
          ?? DEFAULT_CHROME_CDP_URL,
        VK_UI_TOKEN: token,
      },
    })
    this.#child = child

    child.stderr?.on('data', lineSplitter((line) => {
      this.#stderrTail.push(scrubSidecarText(line, [token]))
      if (this.#stderrTail.length > this.stderrTailLines) this.#stderrTail.shift()
    }))

    const port = await new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        this.#fail('spawn-timeout', `sidecar 未在 ${this.readyTimeoutMs}ms 内打出 ready 行`)
        child.kill('SIGKILL')
        settle(reject, this.#typedError())
      }, this.readyTimeoutMs)
      timer.unref?.()

      child.stdout?.on('data', lineSplitter((line) => {
        const match = READY_LINE.exec(line.trim())
        if (match) settle(resolve, Number(match[1]))
        // 非 ready 行(后续 console.log)按契约忽略,但继续排水防背压。
      }))
      child.once('error', (error) => {
        const missing = error && typeof error === 'object' && error.code === 'ENOENT'
        this.#fail(
          missing ? 'runtime-missing' : 'spawn-failed',
          missing ? 'video-knowledge runtime 不存在(python 可执行文件缺失)' : 'sidecar 进程启动失败',
          scrubSidecarText(String(error?.message ?? error), [token]),
        )
        settle(reject, this.#typedError())
      })
      child.once('close', (code, signal) => {
        this.#onChildClose(code, signal)
        settle(reject, this.#typedError())
      })
    })

    this.#port = port
    await this.#handshake(port, token, child)
    this.#state = 'ok'
    return { port, token }
  }

  async #handshake(port, token, child) {
    let meta = null
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/api/meta`, {
        method: 'GET',
        headers: { 'X-VK-Token': token },
        signal: AbortSignal.timeout?.(this.healthTimeoutMs),
      })
      if (!response.ok) {
        throw new Error(`meta HTTP ${response.status}`)
      }
      meta = await response.json()
    } catch (error) {
      this.#fail(
        'protocol-mismatch',
        'sidecar ready 但 /api/meta 握手失败',
        scrubSidecarText(String(error?.message ?? error), [token]),
      )
      child.kill('SIGKILL')
      throw this.#typedError()
    }
    // 握手三校验(v2 阶段4):service、api_version、processing_request_schema_version。
    // 任何一项不兼容都拒绝启动——请求形状与路由形状各有版本,只校验其一等于放过另一半。
    const version = parseApiVersion(meta?.api_version)
    const schema = parseApiVersion(meta?.processing_request_schema_version)
    const compatible = meta?.service === 'video-knowledge'
      && version !== null
      && version.major === this.requiredApiMajor
      && version.minor >= this.requiredApiMinor
      && schema !== null
      && schema.major === this.requiredSchemaMajor
      && schema.minor >= this.requiredSchemaMinor
    if (!compatible) {
      this.#fail(
        'protocol-mismatch',
        'sidecar 协议版本不兼容',
        `需要 service=video-knowledge api ${this.requiredApiMajor}.${this.requiredApiMinor}+ `
        + `processing_request_schema_version ${this.requiredSchemaMajor}.${this.requiredSchemaMinor}+;`
        + `拿到 service=${meta?.service ?? '?'} api_version=${meta?.api_version ?? '?'} `
        + `processing_request_schema_version=${meta?.processing_request_schema_version ?? '?'}`,
      )
      child.kill('SIGKILL')
      throw this.#typedError()
    }
    if (meta.shell_mode !== true) {
      this.#fail(
        'protocol-mismatch',
        'sidecar 未进入 shell_mode(token 未生效)',
        'meta.shell_mode 应为 true;VK_UI_TOKEN 注入疑似失败',
      )
      child.kill('SIGKILL')
      throw this.#typedError()
    }
    this.#meta = meta
  }

  #fail(reasonCode, summary, detail) {
    this.#state = 'failed'
    this.#diagnostic = {
      reasonCode,
      summary,
      ...(detail ? { detail } : {}),
    }
  }

  #typedError() {
    const diagnostic = this.#diagnostic ?? { reasonCode: 'sidecar-error', summary: 'sidecar 不可用' }
    return new VkSidecarError(503, diagnostic.summary, {
      reasonCode: diagnostic.reasonCode,
      detail: diagnostic.detail,
    })
  }

  #onChildClose(code, signal) {
    this.#child = null
    this.#port = null
    if (this.#deliberateStop) {
      this.#state = 'stopped'
      this.#diagnostic = null
      return
    }
    if (this.#state === 'failed' && this.#diagnostic) {
      // 首诊优先:spawn-timeout / protocol-mismatch 主动 SIGKILL 之后的 close
      // 不得把根因覆盖成泛化的 sidecar-exited。
      return
    }
    const tail = this.#stderrTail.join('\n').trim()
    this.#fail(
      'sidecar-exited',
      `sidecar 异常退出(exit=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`,
      tail || undefined,
    )
  }

  async fetchApi(path, init = {}) {
    const { port, token } = await this.ensureStarted()
    return this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'X-VK-Token': token },
    })
  }

  async stop() {
    if (!this.#child) {
      if (this.#state !== 'not-configured' && this.#state !== 'failed') this.#state = 'stopped'
      return
    }
    if (this.#stopping) return this.#stopping
    this.#deliberateStop = true
    const child = this.#child
    this.#stopping = new Promise((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), this.stopGraceMs)
      force.unref?.()
      child.once('close', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    }).finally(() => {
      this.#stopping = null
    })
    return this.#stopping
  }
}
