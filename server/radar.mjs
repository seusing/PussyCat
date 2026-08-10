// codexradar.com 的三张表。**由 Node 侧取,不让渲染进程直连第三方**:应用的 CSP
// 现在只放行 'self' 与 127.0.0.1,为了这几张表把 codexradar.com 加进 connect-src,
// 等于给渲染进程开了一条通往站外的口子 —— 不值。
//
// 同样不用 iframe:那会把第三方的 JS 拉进这个带 Tauri IPC 的窗口。这里只取 JSON、
// 只投影要显示的字段,自己渲染。
//
// 三个上游:
//   /api/radar-insights                     30KB  推荐卡(站方已算好)
//   /api/intelligence-efficiency-metrics      6KB  24 小时运行次数
//   /api/intelligence-efficiency            271KB(gzip) 原始矩阵,IQ/费用/耗时靠它现算
// 最后那个大,所以缓存按站方自己的节奏(页面是 10 分钟刷一次)。
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { deriveModels, derivePicks } from './radar-derive.mjs'

const ORIGIN = 'https://codexradar.com'
export const INSIGHTS_URL = `${ORIGIN}/api/radar-insights`
export const METRICS_URL = `${ORIGIN}/api/intelligence-efficiency-metrics`
export const MATRIX_URL = `${ORIGIN}/api/intelligence-efficiency`
/** 站方页面自己的刷新间隔(内联脚本里的 refreshMs = 10 * 60 * 1000)。 */
export const DEFAULT_TTL_SECONDS = 600
export const RADAR_STATE_FILE_NAME = 'radar-snapshot.json'
const RADAR_CACHE_SCHEMA = 'radar-snapshot@1'

let radarProxyAgent
let radarProxyUrl

function destroyRadarProxyAgent() {
  const agent = radarProxyAgent
  radarProxyAgent = undefined
  radarProxyUrl = undefined
  if (!agent) return
  try {
    const result = typeof agent.destroy === 'function'
      ? agent.destroy()
      : typeof agent.close === 'function' ? agent.close() : undefined
    result?.catch?.(() => {})
  } catch {
    // Dispatcher cleanup is best effort; a failed proxy must never poison the next refresh.
  }
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/@]+)@/gi, '$1[redacted]@')
    .replace(/(proxy(?:-authorization|_url|url)?\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]')
}

function safeEndpoint(endpoint) {
  if (endpoint == null) return null
  try {
    const parsed = new URL(String(endpoint))
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return redactSecrets(endpoint)
  }
}

function safeCause(cause, seen = new Set()) {
  if (cause == null || typeof cause !== 'object') return redactSecrets(cause)
  if (seen.has(cause)) return '[circular]'
  seen.add(cause)
  const result = {}
  for (const key of ['name', 'code', 'message']) {
    if (cause[key] != null) result[key] = redactSecrets(cause[key])
  }
  return Object.keys(result).length > 0 ? result : redactSecrets(cause)
}

function annotateError(error, endpoint) {
  const wrapped = new Error(redactSecrets(error?.message ?? error))
  wrapped.endpoint = endpoint
  if (error?.name) wrapped.name = error.name
  if (error?.code != null) wrapped.code = error.code
  if (error?.cause != null) wrapped.cause = error.cause
  return wrapped
}

export function diagnosticOf(error, endpoint = error?.endpoint) {
  const details = {
    name: redactSecrets(error?.name || 'Error'),
  }
  if (error?.code != null) details.code = redactSecrets(error.code)
  if (error?.cause != null) details.cause = safeCause(error.cause)
  return {
    endpoint: safeEndpoint(endpoint),
    error: details,
  }
}

function defaultRadarFetch(url, init = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) return undiciFetch(url, init)
  if (!radarProxyAgent || radarProxyUrl !== proxy) {
    if (radarProxyAgent && radarProxyUrl !== proxy) destroyRadarProxyAgent()
    try {
      radarProxyAgent = new ProxyAgent(proxy)
      radarProxyUrl = proxy
    } catch {
      radarProxyAgent = undefined
      radarProxyUrl = undefined
    }
  }
  const dispatcher = radarProxyAgent
  try {
    const request = undiciFetch(url, dispatcher ? { ...init, dispatcher } : init)
    if (!dispatcher || !request?.catch) return request
    return request.catch((error) => {
      if (radarProxyAgent === dispatcher) destroyRadarProxyAgent()
      throw error
    })
  } catch (error) {
    if (radarProxyAgent === dispatcher) destroyRadarProxyAgent()
    throw error
  }
}

export function createRadarService({
  fetchImpl = defaultRadarFetch,
  now = () => Date.now(),
  urls = {},
  ttlSeconds = DEFAULT_TTL_SECONDS,
  timeoutMs = 20000,
  stateFile,
  stateDir,
} = {}) {
  const endpoints = {
    insights: urls.insights ?? INSIGHTS_URL,
    metrics: urls.metrics ?? METRICS_URL,
    matrix: urls.matrix ?? MATRIX_URL,
  }
  const snapshotFile = stateFile ?? (stateDir ? resolve(stateDir, RADAR_STATE_FILE_NAME) : undefined)

  function isSnapshotData(data) {
    return !!data
      && Array.isArray(data.picks)
      && Array.isArray(data.models)
      && typeof data.updatedAt === 'string'
      && typeof data.metricsUpdatedAt === 'string'
      && Number.isFinite(Number(data.runs24hTotal))
      && Number.isFinite(Number(data.taskCount))
  }

  function loadSnapshot() {
    if (!snapshotFile) return null
    try {
      const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8'))
      const data = parsed?.data
      const fetchedAt = Number(parsed?.fetchedAt)
      if (parsed?.schema !== RADAR_CACHE_SCHEMA || !isSnapshotData(data) || !Number.isFinite(fetchedAt)) return null
      return { data, fetchedAt, expiresAt: fetchedAt + ttlSeconds * 1000 }
    } catch {
      return null // A corrupt optional snapshot must never prevent Host startup.
    }
  }

  function persistSnapshot(snapshot) {
    if (!snapshotFile) return
    let temporary
    try {
      mkdirSync(dirname(snapshotFile), { recursive: true })
      temporary = `${snapshotFile}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(temporary, `${JSON.stringify({
        schema: RADAR_CACHE_SCHEMA,
        fetchedAt: snapshot.fetchedAt,
        data: snapshot.data,
      })}\n`, 'utf8')
      renameSync(temporary, snapshotFile)
    } catch {
      // Radar is an optional surface; disk-full/lock errors should not break refreshes.
      if (temporary) {
        try { unlinkSync(temporary) } catch { /* best effort */ }
      }
    }
  }

  let cache = loadSnapshot()   // { data, fetchedAt, expiresAt }
  // A persisted snapshot is a fallback for this process, not proof of a live upstream.
  // Force one refresh so a cold start that cannot reach codexradar is explicitly stale.
  let startupSnapshotPending = !!cache

  async function getJson(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        const error = new Error(`codexradar 返回 ${response.status}`)
        error.code = `HTTP_${response.status}`
        throw error
      }
      return await response.json()
    } catch (error) {
      throw annotateError(error, url)
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchUpstream() {
    const [insights, metrics, matrix] = await Promise.all([
      getJson(endpoints.insights), getJson(endpoints.metrics), getJson(endpoints.matrix),
    ])
    const models = deriveModels(matrix, metrics)
    if (models.length === 0) throw new Error('codexradar 没有返回任何模型')
    const data = {
      picks: derivePicks(insights),
      models,
      updatedAt: String(insights?.source_updated_at ?? ''),
      metricsUpdatedAt: String(metrics?.source_updated_at ?? ''),
      runs24hTotal: Number(metrics?.runs_24h_total) || 0,
      taskCount: Array.isArray(matrix?.tasks) ? matrix.tasks.length : 0,
    }
    const fetchedAt = now()
    cache = { data, fetchedAt, expiresAt: fetchedAt + ttlSeconds * 1000 }
    startupSnapshotPending = false
    persistSnapshot(cache)
    return { ...data, ttlSeconds, fetchedAt, cached: false, stale: false }
  }

  return {
    async get({ force = false } = {}) {
      if (!force && cache && !startupSnapshotPending && now() < cache.expiresAt) {
        return { ...cache.data, ttlSeconds, fetchedAt: cache.fetchedAt, cached: true, stale: false }
      }
      try {
        return await fetchUpstream()
      } catch (error) {
        // 上游挂了但手里有旧数据 —— 给旧的并标 stale,比甩一张白纸强。
        startupSnapshotPending = false
        if (!cache) throw error
        // Keep retrying an unavailable upstream rather than presenting a disk snapshot as fresh.
        cache.expiresAt = 0
        return {
          ...cache.data, ttlSeconds, fetchedAt: cache.fetchedAt,
          cached: true, stale: true, error: reasonOf(error), diagnostic: diagnosticOf(error),
        }
      }
    },
  }
}

export function reasonOf(error) {
  if (error?.name === 'AbortError') return '连接 codexradar 超时'
  const message = redactSecrets(error?.message ?? error ?? '')
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) return '连不上 codexradar，检查网络或代理'
  return message || '读取 codexradar 失败'
}
