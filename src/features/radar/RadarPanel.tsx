import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchRadarRatings, type RadarModel, type RadarRatings } from '../../host/radarClient'

/** 样本量低于这个数的档位另眼看待:9 票的 4.7 说明不了什么。 */
const THIN_SAMPLE = 20

function scoreColor(average: number | null): string {
  if (average == null) return 'var(--color-fg-dim)'
  if (average >= 8) return 'var(--color-success)'
  if (average >= 6) return 'var(--color-accent)'
  if (average >= 4) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  return hr < 24 ? `${hr} 小时前` : `${Math.floor(hr / 24)} 天前`
}

/** 档位后缀去掉家族前缀,只留 ultra/max/xhigh/… —— 分组标题已经说了是哪家。 */
function tierOf(model: RadarModel): string {
  const label = model.label.startsWith(model.group)
    ? model.label.slice(model.group.length).trim()
    : model.label
  return label || model.label
}

function groupModels(models: RadarModel[]): { group: string; items: RadarModel[]; votes: number }[] {
  const map = new Map<string, RadarModel[]>()
  for (const model of models) {
    const list = map.get(model.group)
    if (list) list.push(model)
    else map.set(model.group, [model])
  }
  return [...map.entries()]
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => (b.average ?? -1) - (a.average ?? -1)),
      votes: items.reduce((sum, m) => sum + m.count, 0),
    }))
    // 样本多的家族排前面 —— 那才是有话可说的那些。
    .sort((a, b) => b.votes - a.votes)
}

/**
 * Codex Bar:codexradar 的 24 小时滚动评分。
 *
 * 不用 iframe —— 那会把第三方的 JS 拉进应用窗口。Node 侧取 JSON(server/radar.mjs)
 * 自己渲染,顺带能按上游报的 refresh_seconds 做缓存,不必反复去问同一批字节。
 *
 * 评分永远和样本量一起看:sol-low 的 4.7 只有 9 票,luna-max 的 8.8 有 215 票,
 * 两个数字的分量差着数量级。所以低样本的档位在这里是压暗的,并且标出票数。
 */
export function RadarPanel({ baseUrl }: { baseUrl?: string }) {
  const [data, setData] = useState<RadarRatings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setData(await fetchRadarRatings({ force, baseUrl }))
      setNow(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 codexradar 失败')
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => { void load(false) }, [load])

  const groups = useMemo(() => groupModels(data?.models ?? []), [data])
  const best = useMemo(
    () => (data?.models ?? [])
      .filter((m) => m.average != null && m.count >= THIN_SAMPLE)
      .sort((a, b) => (b.average ?? 0) - (a.average ?? 0))[0] ?? null,
    [data],
  )

  return (
    <div data-testid="radar-panel" className="h-full overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">Codex Bar</h2>
        <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          codexradar.com · {data?.windowHours ? `滚动 ${data.windowHours} 小时` : '滚动窗口'}用户评分
        </span>
        <button
          type="button"
          data-testid="radar-refresh"
          disabled={loading}
          onClick={() => void load(true)}
          className="ml-auto rounded-lg px-2 py-1 text-xs disabled:opacity-50"
          style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        >
          {loading ? '读取中…' : '刷新'}
        </button>
      </div>

      {data && (
        <div className="mb-3 text-xs" data-testid="radar-meta" style={{ color: 'var(--color-fg-dim)' }}>
          数据生成于 {relativeTime(data.updatedAt, now)}
          {data.cached && !data.stale && ` · 本机缓存，上游每 ${Math.round(data.ttlSeconds / 60)} 分钟才更新一批`}
        </div>
      )}

      {/* 拿旧数据顶上时必须说清楚,否则用户会以为看到的是最新的。 */}
      {data?.stale && (
        <div data-testid="radar-stale" className="mb-3 rounded-lg p-2 text-xs"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
          没能连上 codexradar（{data.error}），下面是 {relativeTime(new Date(data.fetchedAt).toISOString(), now)}取到的那批。
        </div>
      )}

      {error && !data && (
        <div data-testid="radar-error" className="rounded-lg p-3 text-xs"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)', color: 'var(--color-danger)' }}>
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>读取中…</div>
      )}

      {best && (
        <div className="mb-3 text-xs" data-testid="radar-best" style={{ color: 'var(--color-fg-dim)' }}>
          样本足够（≥{THIN_SAMPLE} 票）里评分最高的是
          <span style={{ color: 'var(--color-fg)' }}> {best.label} </span>
          {best.average?.toFixed(1)} 分 · {best.count} 票
        </div>
      )}

      <div className="space-y-3">
        {groups.map(({ group, items, votes }) => (
          <div key={group} data-testid={`radar-group-${group}`} className="rounded-lg p-2"
            style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-sm">{group}</span>
              <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{votes} 票</span>
            </div>
            <div className="space-y-1">
              {items.map((model) => {
                const thin = model.count < THIN_SAMPLE
                return (
                  <div key={model.id} data-testid={`radar-model-${model.id}`}
                    className="flex items-center gap-2 text-xs" style={{ opacity: thin ? 0.55 : 1 }}>
                    <span className="w-16 shrink-0" style={{ color: 'var(--color-fg-dim)' }}>{tierOf(model)}</span>
                    <span className="w-8 shrink-0 text-right tabular-nums"
                      style={{ color: scoreColor(model.average) }}>
                      {model.average == null ? '—' : model.average.toFixed(1)}
                    </span>
                    <span className="h-1.5 min-w-0 flex-1 rounded-full" style={{ background: 'var(--color-hover)' }}>
                      <span className="block h-full rounded-full"
                        style={{
                          width: `${Math.max(0, Math.min(100, (model.average ?? 0) * 10))}%`,
                          background: scoreColor(model.average),
                        }} />
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums" style={{ color: 'var(--color-fg-dim)' }}>
                      {model.count} 票{thin ? '（少）' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
