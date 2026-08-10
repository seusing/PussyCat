import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class WrssIntegrationError extends Error {
  constructor(statusCode, reasonCode, message) {
    super(message)
    this.name = 'WrssIntegrationError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WrssIntegrationError(400, 'invalid-url', 'WeRSS 地址格式无效')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new WrssIntegrationError(400, 'invalid-url', 'WeRSS 地址格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.hash || url.search
    || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new WrssIntegrationError(
      400,
      'invalid-url',
      '当前阶段只允许连接本机 WeRSS（127.0.0.1、localhost 或 ::1）',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function readSaved(stateFile) {
  if (!stateFile) return null
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    return { baseUrl: normalizeBaseUrl(parsed?.baseUrl) }
  } catch {
    return null
  }
}

function writeSaved(stateFile, value) {
  if (!stateFile) return
  mkdirSync(dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, stateFile)
}

export function createWrssIntegration({
  stateFile,
  fetchImpl = fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = () => new Date().toISOString(),
  defaultBaseUrl = DEFAULT_BASE_URL,
} = {}) {
  const saved = readSaved(stateFile)
  let baseUrl = saved?.baseUrl ?? normalizeBaseUrl(defaultBaseUrl)
  let configured = saved !== null
  let lastCheck = null

  const status = () => ({
    configured,
    base_url: baseUrl,
    state: lastCheck?.state ?? (configured ? 'saved' : 'not-configured'),
    message: lastCheck?.message ?? (configured
      ? '已保存，尚未测试连接'
      : '尚未连接 WeRSS；可使用本机 8001 服务'),
    status_code: lastCheck?.statusCode ?? null,
    protocol_verified: false,
    checked_at: lastCheck?.checkedAt ?? null,
  })

  return {
    status,
    save(value) {
      baseUrl = normalizeBaseUrl(value)
      configured = true
      lastCheck = null
      writeSaved(stateFile, { schema: 'wrss-integration@1', baseUrl })
      return status()
    },
    async test() {
      if (!configured) {
        throw new WrssIntegrationError(409, 'not-configured', '请先保存 WeRSS 地址')
      }
      try {
        const response = await fetchImpl(baseUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: timeoutSignal(10_000),
          headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.1' },
        })
        await response.body?.cancel?.()
        const authRequired = response.status === 401 || response.status === 403
        lastCheck = {
          state: 'reachable',
          message: authRequired
            ? 'WeRSS 服务可达，但需要在其 Web 界面完成鉴权'
            : 'WeRSS 服务可达；文章接口协议尚未接入',
          statusCode: response.status,
          checkedAt: now(),
        }
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        lastCheck = {
          state: timeout ? 'timeout' : 'unreachable',
          message: timeout ? '连接 WeRSS 超时' : '无法连接 WeRSS 本机服务',
          statusCode: null,
          checkedAt: now(),
        }
      }
      return status()
    },
  }
}

export { DEFAULT_BASE_URL as DEFAULT_WRSS_BASE_URL, normalizeBaseUrl }
