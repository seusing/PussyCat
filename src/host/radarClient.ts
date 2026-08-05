// codexradar 公开评分的类型化客户端。**渲染进程不直连 codexradar.com** —— Node 侧
// 代取并缓存(server/radar.mjs),这里只跟本机 Host 说话,应用的 CSP 因此一字未动。
import { HostRequestError } from './errors'
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

export interface RadarModel {
  id: string
  label: string
  /** 模型家族,如 "GPT-5.6 Sol" —— 界面按它分组。 */
  group: string
  /** 0–10 的平均分;上游没给就是 null。 */
  average: number | null
  /** 样本量。9 票的 4.7 和 215 票的 8.8 不是一回事,必须一起看。 */
  count: number
}

export interface RadarRatings {
  day: string
  timezone: string
  /** 上游这批数据的生成时刻(ISO)。 */
  updatedAt: string
  window: string
  windowHours: number | null
  source: string
  models: RadarModel[]
  /** Node 侧这次是不是走了缓存。 */
  cached: boolean
  /** 上游取不到、拿旧数据顶上 —— 界面必须说清楚。 */
  stale: boolean
  /** stale 时的原因。 */
  error?: string
  ttlSeconds: number
  /** Node 侧真正取到这批数据的时刻(epoch ms)。 */
  fetchedAt: number
}

export async function fetchRadarRatings(
  { force = false, baseUrl = DEFAULT_BASE_URL }: { force?: boolean; baseUrl?: string } = {},
): Promise<RadarRatings> {
  const response = await fetch(
    `${baseUrl}/radar/v1/model-ratings${force ? '?force=1' : ''}`,
    { headers: { Accept: 'application/json' } },
  )
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; reasonCode?: unknown }
    throw new HostRequestError(
      typeof record.error === 'string' ? record.error : '读取 codexradar 失败',
      undefined,
      response.status,
      typeof record.reasonCode === 'string' ? record.reasonCode : undefined,
    )
  }
  return body as RadarRatings
}
