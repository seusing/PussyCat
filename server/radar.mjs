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
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { deriveModels, derivePicks } from './radar-derive.mjs'

const ORIGIN = 'https://codexradar.com'
export const INSIGHTS_URL = `${ORIGIN}/api/radar-insights`
export const METRICS_URL = `${ORIGIN}/api/intelligence-efficiency-metrics`
export const MATRIX_URL = `${ORIGIN}/api/intelligence-efficiency`
/** 站方页面自己的刷新间隔(内联脚本里的 refreshMs = 10 * 60 * 1000)。 */
export const DEFAULT_TTL_SECONDS = 600

let radarProxyAgent
let radarProxyUrl

function defaultRadarFetch(url, init = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) return undiciFetch(url, init)
  if (!radarProxyAgent || radarProxyUrl !== proxy) {
    try {
      radarProxyAgent = new ProxyAgent(proxy)
      radarProxyUrl = proxy
    } catch {
      radarProxyAgent = undefined
      radarProxyUrl = undefined
    }
  }
  return undiciFetch(url, radarProxyAgent ? { ...init, dispatcher: radarProxyAgent } : init)
}

export function createRadarService({
  fetchImpl = defaultRadarFetch,
  now = () => Date.now(),
  urls = {},
  ttlSeconds = DEFAULT_TTL_SECONDS,
  timeoutMs = 20000,
} = {}) {
  const endpoints = {
    insights: urls.insights ?? INSIGHTS_URL,
    metrics: urls.metrics ?? METRICS_URL,
    matrix: urls.matrix ?? MATRIX_URL,
  }
  let cache = null   // { data, fetchedAt, expiresAt }

  async function getJson(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`codexradar 返回 ${response.status}`)
      return await response.json()
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
    return { ...data, ttlSeconds, fetchedAt, cached: false, stale: false }
  }

  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() < cache.expiresAt) {
        return { ...cache.data, ttlSeconds, fetchedAt: cache.fetchedAt, cached: true, stale: false }
      }
      try {
        return await fetchUpstream()
      } catch (error) {
        // 上游挂了但手里有旧数据 —— 给旧的并标 stale,比甩一张白纸强。
        if (!cache) throw error
        return {
          ...cache.data, ttlSeconds, fetchedAt: cache.fetchedAt,
          cached: true, stale: true, error: reasonOf(error),
        }
      }
    },
  }
}

export function reasonOf(error) {
  if (error?.name === 'AbortError') return '连接 codexradar 超时'
  const message = String(error?.message ?? error ?? '')
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) return '连不上 codexradar，检查网络或代理'
  return message || '读取 codexradar 失败'
}
