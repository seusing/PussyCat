import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

import { sha256File } from './vk-runtime-install.mjs'

export const WRSS_VERSION = '1.5.2'
export const WRSS_SOURCE_URL = 'https://codeload.github.com/rachelos/we-mp-rss/tar.gz/refs/tags/v1.5.2'
export const WRSS_SOURCE_FALLBACK_URL = 'https://github.com/rachelos/we-mp-rss/archive/refs/tags/v1.5.2.tar.gz'
export const WRSS_SOURCE_SHA256 = '6ad4256552ddb6fe910dcfab0bc87c962336d1b991649e35feffc004484b75c1'
export const WRSS_SIZE_LABEL = '约 356 MB（按需下载）'

const LOG_TAIL_LINES = 60
const LOOPBACK_HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 250
const TAR_BLOCK_SIZE = 512
const MAX_EXTRACTED_ARCHIVE_BYTES = 256 * 1024 * 1024

export class WrssRuntimeError extends Error {
  constructor(statusCode, reasonCode, message, detail) {
    super(message)
    this.name = 'WrssRuntimeError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
    if (detail) this.detail = detail
  }
}

function tarText(buffer, start, length) {
  const field = buffer.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function tarNumber(buffer, start, length) {
  const field = buffer.subarray(start, start + length)
  if ((field[0] & 0x80) !== 0) {
    throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包使用了不支持的数字格式')
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包数字字段无效')
  return Number.parseInt(text, 8)
}

function verifyTarHeader(header) {
  const expected = tarNumber(header, 148, 8)
  let actual = 0
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== expected) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包头校验失败')
}

function parsePax(buffer) {
  const fields = {}
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space < 0) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 元数据无效')
    const lengthText = buffer.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录长度无效')
    const recordEnd = offset + Number.parseInt(lengthText, 10)
    if (recordEnd > buffer.length || buffer[recordEnd - 1] !== 0x0a) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录越界')
    }
    const record = buffer.subarray(space + 1, recordEnd - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals <= 0) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS PAX 记录无效')
    fields[record.slice(0, equals)] = record.slice(equals + 1)
    offset = recordEnd
  }
  return fields
}

function safeArchivePath(destination, archivedPath) {
  const portable = String(archivedPath).replaceAll('\\', '/').replace(/\/+$/, '')
  if (!portable || portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:/.test(portable)) {
    throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含不安全路径')
  }
  const segments = portable.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含路径穿越')
  }
  const output = resolve(destination, ...segments)
  if (!isInside(destination, output)) throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包路径越界')
  return output
}

/** Extract a verified tar.gz without invoking the platform tar executable. */
export function extractTarGzipSecure(archivePath, destination) {
  let archive
  try {
    archive = gunzipSync(readFileSync(archivePath), { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES })
  } catch (error) {
    throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包解压失败', String(error?.message ?? error))
  }

  const entries = []
  const seen = new Set()
  let offset = 0
  let globalPax = {}
  let nextPax = {}
  let longPath = null
  let ended = false
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) {
      ended = true
      break
    }
    verifyTarHeader(header)
    const headerSize = tarNumber(header, 124, 12)
    const type = tarText(header, 156, 1) || '0'
    const dataStart = offset + TAR_BLOCK_SIZE
    const dataEnd = dataStart + headerSize
    if (!Number.isSafeInteger(headerSize) || dataEnd > archive.length) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包内容越界')
    }
    const data = archive.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(headerSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    if (type === 'x' || type === 'g') {
      const parsed = parsePax(data)
      if (type === 'g') globalPax = { ...globalPax, ...parsed }
      else nextPax = parsed
      continue
    }
    if (type === 'L' || type === 'K') {
      const value = data.subarray(0, data.indexOf(0) < 0 ? data.length : data.indexOf(0)).toString('utf8')
      if (type === 'L') longPath = value
      continue
    }

    const pax = { ...globalPax, ...nextPax }
    const prefix = tarText(header, 345, 155)
    const headerPath = [prefix, tarText(header, 0, 100)].filter(Boolean).join('/')
    const archivedPath = pax.path ?? longPath ?? headerPath
    nextPax = {}
    longPath = null
    if (type === '1' || type === '2') {
      throw new WrssRuntimeError(500, 'archive-security', 'WeRSS 压缩包包含不允许的链接', `type=${type}`)
    }
    if (type !== '0' && type !== '5') {
      throw new WrssRuntimeError(500, 'archive-security', `WeRSS 压缩包包含不允许的条目类型：${type}`)
    }
    const output = safeArchivePath(destination, archivedPath)
    const key = resolve(output)
    if (seen.has(key)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包包含重复路径')
    seen.add(key)
    const effectiveSize = pax.size === undefined ? headerSize : Number(pax.size)
    if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0 || effectiveSize !== headerSize) {
      throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包文件大小元数据不一致')
    }
    entries.push({ type, output, data })
  }
  if (!ended) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包缺少结束标记')

  // Do not write anything until every entry has passed validation.
  for (const entry of entries) {
    if (entry.type === '5') mkdirSync(entry.output, { recursive: true })
    else {
      mkdirSync(dirname(entry.output), { recursive: true })
      writeFileSync(entry.output, entry.data)
    }
  }
}

function scrub(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([A-Z_]*(?:SECRET|TOKEN|PASSWORD|COOKIE|KEY)[A-Z_]*)\s*=\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(secret[_-]?key|token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:mnt|tmp|home|Users)\/)[^\s]+/g, '[path]')
}

function errorCauseDetail(error) {
  const details = []
  const seen = new Set()
  let cause = error
  for (let depth = 0; cause && depth < 4 && !seen.has(cause); depth += 1) {
    seen.add(cause)
    const code = typeof cause?.code === 'string' ? scrub(cause.code).slice(0, 80) : ''
    const message = cause?.message ? scrub(cause.message).slice(0, 240) : ''
    if (code || message) details.push(`cause[${depth}]${code ? ` code=${code}` : ''}${message ? ` message=${message}` : ''}`)
    cause = cause?.cause
  }
  return details.join(' <- ') || 'cause unavailable'
}

function isInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child))
  return childRelative === '' || (!isAbsolute(childRelative) && !childRelative.startsWith('..') && !childRelative.startsWith('/') && !childRelative.startsWith('\\'))
}

const WRSS_CONFIG_TEMPLATE_NAMES = Object.freeze([
  'config.example.yaml',
  'config.example.yml',
  'config-node.yaml',
  'config-node.yml',
])

function isRegularFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * Resolve the upstream configuration template without trusting a single
 * filename.  WeRSS releases have used both the example and node template
 * names; the installed copy is normalised to config.example.yaml below.
 */
export function resolveWrssConfigTemplate(sourceRoot) {
  for (const name of WRSS_CONFIG_TEMPLATE_NAMES) {
    const candidate = join(sourceRoot, name)
    if (isRegularFile(candidate)) return { path: candidate, name }
  }
  let entries = []
  try { entries = readdirSync(sourceRoot, { withFileTypes: true }) } catch { return null }
  const fallback = entries.find((entry) => (
    entry.isFile() && /^config(?:[.-](?:example|node))?\.ya?ml$/i.test(entry.name)
  ))
  return fallback
    ? { path: join(sourceRoot, fallback.name), name: fallback.name }
    : null
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
  renameSync(temporary, file)
}

function atomicText(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, value, 'utf8')
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode bits. */ }
  renameSync(temporary, file)
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function hasExpectedManifest(bundleDir) {
  if (!bundleDir) return false
  const manifestPath = join(bundleDir, 'runtime-manifest.json')
  const manifest = readJson(manifestPath)
  return !!manifest?.uv?.name && typeof manifest.uv.sha256 === 'string'
}

function defaultPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function responseOk(response) {
  return response && (response.ok === true || (Number.isInteger(response.status) && response.status >= 200 && response.status < 400))
}

export class WrssRuntimeManager {
  #state = null
  #reasonCode = null
  #summary = null
  #version = null
  #uiUrl = null
  #log = []
  #enableFlight = null
  #child = null
  #port = null
  #secret = null
  #proxyDispatcher = null
  #proxyUrl = null

  constructor({
    home,
    bundleDir,
    env = process.env,
    fetchImpl,
    spawnImpl = spawn,
    now = () => new Date().toISOString(),
    sha256FileImpl = sha256File,
    runStepImpl,
    getPortImpl = defaultPort,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    proxyAgentFactory = (url) => new ProxyAgent(url),
  } = {}) {
    this.env = env
    this.baseHome = home ?? env.OPENCLI_HOST_VK_HOME
    this.home = this.baseHome ? resolve(this.baseHome, 'wrss') : null
    this.bundleDir = bundleDir ?? env.OPENCLI_HOST_VK_BUNDLE_DIR
    this.proxyAgentFactory = proxyAgentFactory
    this.fetchImpl = fetchImpl ?? ((url, options = {}) => this.#fetchWithProxy(url, options))
    this.spawnImpl = spawnImpl
    this.now = now
    this.sha256FileImpl = sha256FileImpl
    this.runStepImpl = runStepImpl
    this.getPortImpl = getPortImpl
    this.readyTimeoutMs = readyTimeoutMs
    this.readyPollMs = readyPollMs
    this.#state = this.#initialState()
  }

  async #fetchWithProxy(url, options = {}) {
    try {
      const target = new URL(url)
      if (target.hostname === LOOPBACK_HOST || target.hostname === 'localhost' || target.hostname === '::1') {
        return undiciFetch(url, options)
      }
    } catch { /* let undici produce the typed request error */ }
    const proxyUrl = this.env.HTTPS_PROXY ?? this.env.https_proxy ?? this.env.HTTP_PROXY ?? this.env.http_proxy
    if (!proxyUrl) return undiciFetch(url, options)
    if (this.#proxyUrl !== proxyUrl || !this.#proxyDispatcher) {
      this.#proxyDispatcher?.destroy?.()
      this.#proxyDispatcher = null
      this.#proxyUrl = proxyUrl
      try {
        this.#proxyDispatcher = this.proxyAgentFactory(proxyUrl)
      } catch (error) {
        this.#proxyUrl = null
        throw new WrssRuntimeError(502, 'proxy-invalid', 'WeRSS 网络代理不可用', String(error?.message ?? error))
      }
    }
    try {
      return await undiciFetch(url, { ...options, dispatcher: this.#proxyDispatcher })
    } catch (error) {
      this.#resetProxyDispatcher()
      throw error
    }
  }

  #resetProxyDispatcher() {
    this.#proxyDispatcher?.destroy?.()
    this.#proxyDispatcher = null
    this.#proxyUrl = null
  }

  #initialState() {
    if (!this.home || !hasExpectedManifest(this.bundleDir)) return 'not-available'
    const receipt = readJson(this.receiptPath)
    if (receipt?.schema === 'wrss-runtime-receipt@1'
      && receipt.version === WRSS_VERSION
      && typeof receipt.sourceDir === 'string'
      && typeof receipt.venvDir === 'string'
      && existsSync(receipt.sourceDir)
      && existsSync(receipt.venvDir)) {
      this.#version = WRSS_VERSION
      return 'installed'
    }
    return 'not-installed'
  }

  get receiptPath() { return this.home ? join(this.home, 'receipt.json') : null }
  get statePath() { return this.home ? join(this.home, 'runtime-state.json') : null }

  #pushLog(line) {
    const cleaned = scrub(line)
    if (!cleaned.trim()) return
    this.#log.push(cleaned)
    if (this.#log.length > 300) this.#log.shift()
  }

  #setFailed(error, fallback = 'WeRSS 安装或启动失败') {
    this.#state = 'failed'
    this.#reasonCode = error?.reasonCode ?? 'runtime-failed'
    this.#summary = String(error?.message ?? fallback)
    if (error?.detail) this.#pushLog(error.detail)
  }

  status() {
    const status = {
      state: this.#state ?? 'not-available',
      summary: this.#summary ?? ({
        'not-available': '公众号运行环境不可用',
        'not-installed': '公众号运行环境尚未启用',
        installing: '正在安装公众号运行环境',
        installed: '公众号运行环境已安装，等待启动',
        starting: '正在启动公众号界面',
        running: '公众号界面已就绪',
        failed: '公众号运行环境失败',
      }[this.#state] ?? '公众号运行环境不可用'),
      reason_code: this.#reasonCode,
      progress_log: this.#log.slice(-LOG_TAIL_LINES),
      version: this.#version,
      size_label: WRSS_SIZE_LABEL,
      checked_at: this.now(),
    }
    if (this.#state === 'running' && this.#uiUrl) status.ui_url = this.#uiUrl
    return status
  }

  async #runStep(step, command, argv, options = {}) {
    if (this.runStepImpl) {
      const result = await this.runStepImpl({
        step, command, argv, options,
        log: (line) => this.#pushLog(line),
      })
      return result
    }
    return new Promise((resolveStep, rejectStep) => {
      this.#pushLog(`${step}: ${String(command).split(/[\\/]/).pop()} ${argv.join(' ')}`)
      const child = this.spawnImpl(command, argv, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        output += text
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.#pushLog(line.trim())
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', (error) => rejectStep(new WrssRuntimeError(500, 'process-start-failed', `${step} 无法启动`, error.message)))
      child.once('close', (code) => code === 0
        ? resolveStep(output)
        : rejectStep(new WrssRuntimeError(500, 'install-failed', `${step} 失败`, scrub(output.slice(-800)))))
    })
  }

  async #downloadArchive(staging) {
    this.#pushLog('下载 WeRSS 固定版本 v1.5.2')
    const archivePath = join(staging, 'wrss.tar.gz')
    const urls = [WRSS_SOURCE_URL, WRSS_SOURCE_FALLBACK_URL]
    const failures = []
    for (let index = 0; index < urls.length; index += 1) {
      let response
      let bytes
      try {
        response = await this.fetchImpl(urls[index], { redirect: 'follow' })
        const downloadOk = Number.isInteger(response?.status)
          ? response.status >= 200 && response.status < 300
          : response?.ok === true
        if (!downloadOk) {
          await response?.body?.cancel?.()
          const detail = `attempt=${index + 1} HTTP ${response?.status ?? 'unknown'}`
          failures.push(detail)
          this.#pushLog(`WeRSS 下载线路 ${index + 1} 失败：${detail}`)
          this.#resetProxyDispatcher()
          continue
        }
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        const detail = `attempt=${index + 1} ${errorCauseDetail(error)}`
        failures.push(detail)
        this.#pushLog(`WeRSS 下载线路 ${index + 1} 传输失败：${detail}`)
        this.#resetProxyDispatcher()
        continue
      }
      writeFileSync(archivePath, bytes)
      const actual = this.sha256FileImpl(archivePath)
      if (actual !== WRSS_SOURCE_SHA256) {
        this.#resetProxyDispatcher()
        throw new WrssRuntimeError(502, 'sha-mismatch', 'WeRSS 下载包校验失败', `expected=${WRSS_SOURCE_SHA256} actual=${actual}`)
      }
      this.#pushLog(`下载包 SHA-256 校验通过（${actual.slice(0, 12)}…）`)
      return archivePath
    }
    throw new WrssRuntimeError(502, 'download-failed', '公众号组件下载失败，请检查网络后重试', failures.join(' | '))
  }

  async #install() {
    if (!this.home || !hasExpectedManifest(this.bundleDir)) {
      throw new WrssRuntimeError(503, 'bundle-missing', '公众号运行环境依赖的 uv 捆绑包不可用')
    }
    mkdirSync(this.home, { recursive: true })
    const manifestPath = join(this.bundleDir, 'runtime-manifest.json')
    const manifest = readJson(manifestPath)
    const uvPath = resolve(this.bundleDir, manifest.uv.name)
    if (!isInside(this.bundleDir, uvPath) || !existsSync(uvPath)) {
      throw new WrssRuntimeError(503, 'bundle-missing', '捆绑 uv 不存在')
    }
    const uvDigest = this.sha256FileImpl(uvPath)
    if (uvDigest !== manifest.uv.sha256) {
      throw new WrssRuntimeError(503, 'sha-mismatch', '捆绑 uv 校验失败', `expected=${manifest.uv.sha256} actual=${uvDigest}`)
    }
    this.#pushLog(`uv manifest 校验通过（${uvDigest.slice(0, 12)}…）`)

    const staging = mkdtempSync(join(tmpdir(), 'wrss-install-'))
    let versionDir = null
    let activated = false
    const extraction = join(staging, 'extract')
    mkdirSync(extraction, { recursive: true })
    try {
      const archivePath = await this.#downloadArchive(staging)
      extractTarGzipSecure(archivePath, extraction)
      this.#pushLog('WeRSS 压缩包安全解压完成')
      const roots = []
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === `we-mp-rss-${WRSS_VERSION}`) roots.push(path)
            visit(path)
          }
        }
      }
      visit(extraction)
      if (roots.length !== 1) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包目录结构不符合预期')
      const sourceRoot = roots[0]
      const configTemplate = resolveWrssConfigTemplate(sourceRoot)
      const requiredPaths = [
        'main.py',
        'requirements.txt',
        join('static', 'index.html'),
      ]
      if (requiredPaths.some((path) => !isRegularFile(join(sourceRoot, path))) || !configTemplate) {
        throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 压缩包缺少必需文件')
      }
      this.#pushLog(`已识别 WeRSS 配置模板：${configTemplate.name}`)
      const source = readFileSync(join(sourceRoot, 'main.py'), 'utf8')
      const hostMatches = source.match(/host="0\.0\.0\.0"/g) ?? []
      if (hostMatches.length !== 2) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 主程序安全补丁目标不符合预期')
      let patched = source.replace(/host="0\.0\.0\.0"/g, 'host="127.0.0.1"')
      // v1.5.2 prints every environment variable during startup. Require the
      // known loop and remove it instead of silently accepting a changed shape.
      const envOccurrences = patched.match(/os\.environ\.items\(\)/g) ?? []
      if (envOccurrences.length !== 1) throw new WrssRuntimeError(500, 'security-patch-mismatch', '环境变量启动块数量不符合预期')
      const envBlock = /(^|\r?\n)([ \t]*)print\([^\r\n]*\)[ \t]*\r?\n\2[ \t]*for[ \t]+(?:key|k)[ \t]*,[ \t]*(?:value|v)[ \t]*in[ \t]+os\.environ\.items\(\)[ \t]*:[ \t]*\r?\n\2[ \t]+print\([^\r\n]*\)[ \t]*(?=\r?\n|$)/m
      if (!envBlock.test(patched)) throw new WrssRuntimeError(500, 'security-patch-mismatch', '未找到预期的环境变量打印启动块')
      patched = patched.replace(envBlock, '\n')
      if (/os\.environ\.items\(\)/.test(patched)) throw new WrssRuntimeError(500, 'security-patch-mismatch', '环境变量启动块未完全移除')
      writeFileSync(join(sourceRoot, 'main.py'), patched, 'utf8')
      const indexPath = join(sourceRoot, 'static', 'index.html')
      if (!existsSync(indexPath)) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不存在')
      const indexHtml = readFileSync(indexPath, 'utf8')
      const headMatches = indexHtml.match(/<\/head>/gi) ?? []
      if (headMatches.length !== 1) throw new WrssRuntimeError(500, 'security-patch-mismatch', 'WeRSS 页面模板不符合预期')
      writeFileSync(indexPath, indexHtml.replace(/<\/head>/i, '<script src="/static/pussycat-bootstrap.js"></script>\n</head>'), 'utf8')
      this.#pushLog('主程序 loopback 与环境变量日志安全补丁已应用')

      versionDir = join(this.home, 'versions', `v${WRSS_VERSION}-${Date.now()}`)
      mkdirSync(versionDir, { recursive: true })
      const finalSource = join(versionDir, 'src')
      // Copying into a versioned directory leaves an already installed version
      // untouched if any later step fails. This does not invoke a shell.
      cpSync(sourceRoot, finalSource, { recursive: true })
      const venvDir = join(versionDir, 'py')
      const pythonExe = join(venvDir, 'Scripts', 'python.exe')
      const copiedTemplate = join(finalSource, configTemplate.name)
      const configExample = join(finalSource, 'config.example.yaml')
      if (!isRegularFile(copiedTemplate)) {
        throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 配置模板复制失败')
      }
      if (configTemplate.name !== 'config.example.yaml') cpSync(copiedTemplate, configExample)
      if (!isRegularFile(configExample)) throw new WrssRuntimeError(500, 'archive-layout', 'WeRSS 配置模板不存在')
      const configPath = join(this.home, 'config.yaml')
      if (!existsSync(configPath)) cpSync(configExample, configPath)
      const uvEnv = {
        ...this.env,
        UV_PYTHON_INSTALL_DIR: join(this.home, 'python'),
        UV_CACHE_DIR: join(staging, 'uv-cache'),
      }
      await this.#runStep('venv', uvPath, ['venv', '--python', '3.13', venvDir], { env: uvEnv })
      await this.#runStep('install', uvPath, ['pip', 'install', '--python', pythonExe, '-r', join(finalSource, 'requirements.txt')], { cwd: finalSource, env: uvEnv })
      await this.#runStep('playwright', pythonExe, ['-m', 'playwright', 'install', 'webkit'], {
        cwd: finalSource,
        env: { ...uvEnv, PLAYWRIGHT_BROWSERS_PATH: join(this.home, 'browsers') },
      })
      atomicJson(this.receiptPath, {
        schema: 'wrss-runtime-receipt@1', version: WRSS_VERSION,
        sourceDir: finalSource, venvDir, installedAt: this.now(),
      })
      activated = true
      this.#version = WRSS_VERSION
      this.#state = 'installed'
      this.#reasonCode = null
      this.#summary = null
      this.#pushLog('WeRSS 安装完成')
      return this.status()
    } finally {
      rmSync(staging, { recursive: true, force: true })
      if (!activated && versionDir) rmSync(versionDir, { recursive: true, force: true })
    }
  }

  #loadReceipt() {
    const receipt = readJson(this.receiptPath)
    if (!receipt || receipt.schema !== 'wrss-runtime-receipt@1') throw new WrssRuntimeError(500, 'receipt-missing', 'WeRSS 安装回执不存在')
    return receipt
  }

  #hasValidReceipt() {
    try {
      const receipt = this.#loadReceipt()
      return receipt.version === WRSS_VERSION
        && typeof receipt.sourceDir === 'string'
        && typeof receipt.venvDir === 'string'
        && isInside(this.home, receipt.sourceDir)
        && isInside(this.home, receipt.venvDir)
        && existsSync(receipt.sourceDir)
        && existsSync(join(receipt.venvDir, 'Scripts', 'python.exe'))
    } catch {
      return false
    }
  }

  async #terminateChild(child) {
    if (!child || this.#child !== child) return
    await new Promise((resolveClose) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolveClose() } }
      child.once('close', finish)
      try { child.kill('SIGTERM') } catch { finish() }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finish()
      }, 2_000).unref?.()
    })
    if (this.#child === child) this.#child = null
  }

  async #bootstrapLogin(uiUrl, sourceDir, secret) {
    const response = await this.fetchImpl(`${uiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'pussycat', password: secret }).toString(),
      redirect: 'manual',
    })
    let payload = null
    try { payload = await response.json() } catch { /* handled below */ }
    const token = payload?.data?.access_token
    if (!responseOk(response) || typeof token !== 'string' || token.length < 1) {
      throw new WrssRuntimeError(502, 'auth-failed', '公众号登录初始化失败')
    }
    const bootstrapPath = join(sourceDir, 'static', 'pussycat-bootstrap.js')
    atomicText(bootstrapPath, `localStorage.setItem("token", ${JSON.stringify(token)})\n`)
  }

  async #start() {
    const receipt = this.#loadReceipt()
    const sourceDir = resolve(receipt.sourceDir)
    const pythonExe = join(resolve(receipt.venvDir), 'Scripts', 'python.exe')
    if (!isInside(this.home, sourceDir) || !isInside(this.home, pythonExe) || !existsSync(sourceDir) || !existsSync(pythonExe)) {
      throw new WrssRuntimeError(500, 'receipt-invalid', 'WeRSS 安装回执无效')
    }
    this.#state = 'starting'
    this.#reasonCode = null
    this.#summary = null
    this.#uiUrl = null
    this.#port = await this.getPortImpl()
    const savedState = readJson(this.statePath)
    const savedSecret = savedState?.schema === 'wrss-runtime-state@1'
      && typeof savedState.secret_key === 'string'
      && /^[a-f0-9]{64}$/i.test(savedState.secret_key)
      ? savedState.secret_key
      : null
    const secret = this.#secret ?? savedSecret ?? randomBytes(32).toString('hex')
    this.#secret = secret
    atomicJson(this.statePath, { schema: 'wrss-runtime-state@1', secret_key: secret, created_at: this.now() })
    const dbPath = join(this.home, 'data', 'db.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const uiUrl = `http://${LOOPBACK_HOST}:${this.#port}`
    const childEnv = {
      ...this.env,
      PORT: String(this.#port),
      DB: `sqlite:///${dbPath.replace(/\\/g, '/')}`,
      SECRET_KEY: secret,
      USERNAME: 'pussycat',
      PASSWORD: secret,
      TOKEN_EXPIRE_MINUTES: '5256000',
      PLAYWRIGHT_BROWSERS_PATH: join(this.home, 'browsers'),
      BROWSER_TYPE: 'webkit', REDIS_SERVER_ENABLED: 'False', REDIS_URL: '',
      AUTO_RELOAD: 'False', THREADS: '1', HOST: LOOPBACK_HOST,
    }
    this.#pushLog('启动公众号界面（loopback）')
    const initFlag = existsSync(dbPath) ? 'False' : 'True'
    const child = this.spawnImpl(pythonExe, ['main.py', '-config', join(this.home, 'config.yaml'), '-job', 'True', '-init', initFlag], {
      cwd: sourceDir, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child
    const onOutput = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.#pushLog(line.trim())
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    let processFailureReject
    const processFailure = new Promise((_, reject) => { processFailureReject = reject })
    processFailure.catch(() => {})
    const onProcessError = (error) => {
      processFailureReject(new WrssRuntimeError(500, 'process-start-failed', 'WeRSS 进程无法启动', String(error?.message ?? error)))
    }
    child.once('error', onProcessError)
    const onExit = (code) => {
      if (this.#child !== child) return
      this.#child = null
      this.#uiUrl = null
      if (this.#state === 'starting' || this.#state === 'running') {
        this.#setFailed(new WrssRuntimeError(500, 'process-exited', `WeRSS 进程已退出（${code ?? 'unknown'}）`))
      }
    }
    child.once('exit', (code) => {
      const error = new WrssRuntimeError(500, 'process-exited', `WeRSS process exited (${code ?? 'unknown'})`)
      processFailureReject(error)
      onExit(code)
    })
    const ready = (async () => {
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      let response = null
      try {
        response = await this.fetchImpl(uiUrl, { redirect: 'manual' })
      } catch { /* Process may need a few seconds to boot. */ }
      if (response && responseOk(response)) {
          await response.body?.cancel?.()
          await this.#bootstrapLogin(uiUrl, sourceDir, secret)
          this.#uiUrl = uiUrl
          this.#state = 'running'
          this.#version = WRSS_VERSION
          this.#pushLog('公众号界面已就绪')
          return this.status()
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.readyPollMs))
    }
    throw new WrssRuntimeError(504, 'ready-timeout', '公众号界面启动超时')
    })()
    try {
      return await Promise.race([ready, processFailure])
    } catch (error) {
      await this.#terminateChild(child)
      throw error
    }
  }

  enable() {
    if (this.#enableFlight) return this.#enableFlight
    this.#enableFlight = (async () => {
      if (this.#state === 'not-available') throw new WrssRuntimeError(503, 'bundle-missing', this.status().summary)
      if (this.#state === 'running') return this.status()
      try {
        if (this.#state === 'not-installed' || (this.#state === 'failed' && !this.#hasValidReceipt())) {
          this.#state = 'installing'
          this.#reasonCode = null
          this.#summary = null
          this.#log = []
          await this.#install()
        }
        if (this.#state === 'failed' && this.#hasValidReceipt()) {
          this.#state = 'installed'
          this.#reasonCode = null
          this.#summary = null
        }
        if (this.#state === 'installed') await this.#start()
        return this.status()
      } catch (error) {
        this.#setFailed(error)
        throw error
      } finally {
        this.#enableFlight = null
      }
    })()
    return this.#enableFlight
  }

  async close() {
    const child = this.#child
    this.#child = null
    this.#uiUrl = null
    if (child && (this.#state === 'running' || this.#state === 'starting')) this.#state = 'installed'
    if (child) {
      await new Promise((resolveClose) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolveClose() } }
        child.once('close', finish)
        try { child.kill('SIGTERM') } catch { finish() }
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
          finish()
        }, 2_000).unref?.()
      })
    }
    this.#resetProxyDispatcher()
  }
}
