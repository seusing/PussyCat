// codexradar.com 的公开评分。**由 Node 侧取,不让渲染进程直连第三方**:
// 应用的 CSP 现在只放行 'self' 与 127.0.0.1,为了一张表把 codexradar.com 加进
// connect-src,等于给渲染进程开了一条通往站外的口子 —— 这张表不值那个代价。
//
// 同样不用 iframe:那会把第三方的 JS 拉进应用窗口。这里只取 JSON,自己渲染,
// 并且**只投影出要显示的那几个字段** —— 上游哪天多塞点什么进来,也进不了界面。

export const RADAR_URL = 'https://codexradar.com/api/model-ratings'
export const DEFAULT_TTL_SECONDS = 300
/** 上游给的 refresh_seconds 再小,也不至于把人家打爆。 */
export const MIN_TTL_SECONDS = 30

/** 只留要渲染的字段,顺带把 my_scores 这类跟"某个登录用户"绑定的东西挡在外面。 */
export function projectRatings(raw) {
  const models = Array.isArray(raw?.models) ? raw.models : []
  return {
    day: str(raw?.day),
    timezone: str(raw?.timezone),
    updatedAt: str(raw?.updated_at),
    window: str(raw?.window),
    windowHours: Number.isFinite(raw?.window_hours) ? raw.window_hours : null,
    source: str(raw?.source),
    models: models
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        label: str(m.label) || m.id,
        group: str(m.group) || '其他',
        average: Number.isFinite(m.average) ? m.average : null,
        count: Number.isFinite(m.count) ? m.count : 0,
      })),
  }
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

export function ttlFrom(raw) {
  const seconds = Number(raw?.refresh_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TTL_SECONDS
  return Math.max(MIN_TTL_SECONDS, Math.floor(seconds))
}

/**
 * 取一次评分,带缓存。
 *
 * · 自动路径(打开标签页)走缓存,TTL 用上游自己报的 refresh_seconds —— 它每 5 分钟
 *   才更新一批,更勤地问只会拿到同样的字节。
 * · 手动路径(用户点刷新)直取上游。人点几下不算滥用,而且不这么做按钮就是个摆设。
 * · 上游挂了但手里有旧数据 —— 给旧的并标 stale,比甩一张白纸强。
 */
export function createRadarService({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  url = RADAR_URL,
  timeoutMs = 8000,
} = {}) {
  let cache = null   // { data, ttlSeconds, fetchedAt, expiresAt }

  async function fetchUpstream() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`codexradar 返回 ${response.status}`)
      const raw = await response.json()
      const data = projectRatings(raw)
      if (data.models.length === 0) throw new Error('codexradar 没有返回任何模型')
      const ttlSeconds = ttlFrom(raw)
      const fetchedAt = now()
      cache = { data, ttlSeconds, fetchedAt, expiresAt: fetchedAt + ttlSeconds * 1000 }
      return { ...data, ttlSeconds, fetchedAt, cached: false, stale: false }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() < cache.expiresAt) {
        return { ...cache.data, ttlSeconds: cache.ttlSeconds, fetchedAt: cache.fetchedAt, cached: true, stale: false }
      }
      try {
        return await fetchUpstream()
      } catch (error) {
        if (!cache) throw error
        return {
          ...cache.data,
          ttlSeconds: cache.ttlSeconds,
          fetchedAt: cache.fetchedAt,
          cached: true,
          stale: true,
          error: reasonOf(error),
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
