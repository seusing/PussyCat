// codexradar 三张表的类型化客户端。**渲染进程不直连 codexradar.com** —— Node 侧
// 代取、算好、缓存(server/radar.mjs + radar-derive.mjs),这里只跟本机 Host 说话,
// 应用的 CSP 因此一字未动。
import { HostRequestError } from './errors'
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

export interface RadarPickItem {
  id: string
  /** 如 "Sol xhigh" */
  label: string
  color: string
  iq: number | null
  costUsd: number | null
  minutes: number | null
}

export interface RadarPick {
  key: string
  title: string
  /** 站方给的挑选规则原文,鼠标悬停时显示 —— 不解释清楚,推荐就成了黑箱。 */
  rule: string
  items: RadarPickItem[]
}

export interface RadarModel {
  id: string
  model: string
  effort: string
  /** 家族显示名:Sol / Terra / Luna / 5.5 / DeepSeek V4 Flash */
  family: string
  color: string
  label: string
  /** 通过任务数 / 总任务数 × 150。 */
  iq: number
  passed: number
  samples: number
  costUsd: number | null
  minutes: number | null
  /** 24 小时内的运行次数,是这格数字的分量所在。 */
  runs24: number
  /** 相对综合成本(最贵的记 100),图表 x 轴用它。 */
  cci: number | null
}

export interface RadarRatings {
  picks: RadarPick[]
  models: RadarModel[]
  /** 推荐这批数据的生成时刻(ISO)。 */
  updatedAt: string
  metricsUpdatedAt: string
  runs24hTotal: number
  taskCount: number
  cached: boolean
  /** 上游取不到、拿旧数据顶上 —— 界面必须说清楚。 */
  stale: boolean
  error?: string
  ttlSeconds: number
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
