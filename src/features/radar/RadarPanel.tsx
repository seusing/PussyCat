import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchRadarRatings, type RadarModel, type RadarRatings } from '../../host/radarClient'

/** 档位从高到低 —— 界面按它对齐成列,同一档位在同一竖排上才好横向比。 */
const TIERS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low']

function money(usd: number | null): string {
  if (usd == null) return '—'
  return usd >= 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(2)}`
}

function minutes(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}m`
}

function clock(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function RefreshButton({ onClick, busy, testId }: { onClick: () => void; busy: boolean; testId: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      onClick={onClick}
      title="重新读取 codexradar"
      aria-label="刷新"
      className="rounded px-1.5 py-0.5 text-xs disabled:opacity-40"
      style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)' }}
    >
      ↻
    </button>
  )
}

/** 一格模型:左边名字+IQ,右边费用/耗时,右上角是 24 小时运行次数。 */
function ModelCard({ model }: { model: RadarModel }) {
  return (
    <div data-testid={`radar-model-${model.id}`} className="flex overflow-hidden rounded-lg"
      style={{ border: `1px solid ${model.color}55`, background: `${model.color}0f` }}>
      <div className="min-w-0 flex-1 px-2 py-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-xs" style={{ color: 'var(--color-fg)' }}>{model.label}</span>
          <span className="ml-auto shrink-0 rounded px-1 text-[10px] tabular-nums"
            style={{ border: `1px solid ${model.color}66`, color: model.color }}
            title={`24 小时内 ${model.runs24} 次运行`}>
            {model.runs24}
          </span>
        </div>
        <div className="text-2xl leading-tight tabular-nums" style={{ color: model.color }}>
          {model.iq.toFixed(1)}
        </div>
      </div>
      <div className="flex w-20 shrink-0 flex-col text-xs tabular-nums"
        style={{ borderLeft: `1px solid ${model.color}33` }}>
        <span className="flex-1 px-2 py-0.5 text-right" style={{ color: model.color }}>{money(model.costUsd)}</span>
        <span className="flex-1 px-2 py-0.5 text-right"
          style={{ borderTop: `1px solid ${model.color}33`, color: 'var(--color-fg-dim)' }}>
          {minutes(model.minutes)}
        </span>
      </div>
    </div>
  )
}

/**
 * 综合成本 × IQ。x 轴是**相对**综合成本(最贵的记 100),对数刻度;左上角更划算。
 * 自己画 SVG,不引图表库 —— 与本应用不引图标库同理。
 */
function CostIqChart({ models }: { models: RadarModel[] }) {
  const points = models.filter((m) => m.cci != null && m.cci > 0)
  if (points.length < 2) return null

  const W = 720; const H = 320
  const PAD = { l: 34, r: 16, t: 12, b: 28 }
  const xs = points.map((p) => Math.log10(p.cci as number))
  const minX = Math.floor(Math.min(...xs)); const maxX = Math.ceil(Math.max(...xs))
  const maxY = Math.max(120, Math.ceil(Math.max(...points.map((p) => p.iq)) / 20) * 20)
  const px = (v: number) => PAD.l + ((v - minX) / (maxX - minX || 1)) * (W - PAD.l - PAD.r)
  const py = (v: number) => H - PAD.b - (v / maxY) * (H - PAD.t - PAD.b)

  const families = [...new Set(points.map((p) => p.family))].map((family) => ({
    family,
    color: points.find((p) => p.family === family)!.color,
    // 按成本从低到高连线 —— 折线读的是"多花钱换到多少 IQ"。
    items: points.filter((p) => p.family === family).sort((a, b) => (a.cci as number) - (b.cci as number)),
  }))
  const xTicks = Array.from({ length: maxX - minX + 1 }, (_, i) => minX + i)

  return (
    <div data-testid="radar-chart" className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }} role="img"
        aria-label="综合成本与 IQ 的关系图，左上角更划算">
        {[0, 20, 40, 60, 80, 100, 120].filter((v) => v <= maxY).map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)} stroke="var(--color-line)" strokeDasharray="2 4" />
            <text x={PAD.l - 6} y={py(v) + 3} textAnchor="end" fontSize="9" fill="var(--color-fg-dim)">{v}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={px(t)} y={H - PAD.b + 14} textAnchor="middle" fontSize="9" fill="var(--color-fg-dim)">
            {10 ** t >= 1 ? String(10 ** t) : (10 ** t).toFixed(Math.min(4, -t))}
          </text>
        ))}
        {families.map(({ family, color, items }) => (
          <g key={family}>
            <polyline fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.7"
              points={items.map((p) => `${px(Math.log10(p.cci as number))},${py(p.iq)}`).join(' ')} />
            {items.map((p) => (
              <g key={p.id}>
                <circle cx={px(Math.log10(p.cci as number))} cy={py(p.iq)} r="4"
                  fill="var(--color-canvas)" stroke={color} strokeWidth="1.5">
                  <title>{`${p.label} · IQ ${p.iq.toFixed(1)} · ${money(p.costUsd)} · ${minutes(p.minutes)}`}</title>
                </circle>
                <text x={px(Math.log10(p.cci as number))} y={py(p.iq) - 8} textAnchor="middle"
                  fontSize="8" fill="var(--color-fg-dim)">{p.effort}</text>
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  )
}

/**
 * Codex Bar:codexradar 的三张表 —— 推荐、模型格子、成本×IQ 图。
 *
 * 不用 iframe。内嵌会把第三方的 JS 拉进这个带 Tauri IPC 的窗口;这里由 Node 侧取
 * JSON、按站方的算法算好(server/radar-derive.mjs),前端只负责画。
 *
 * IQ 永远和 24 小时运行次数一起看:8 次的 105.8 和 122 次的 87.1 分量不一样。
 */
export function RadarPanel({ baseUrl }: { baseUrl?: string }) {
  const [data, setData] = useState<RadarRatings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setData(await fetchRadarRatings({ force, baseUrl }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 codexradar 失败')
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => { void load(false) }, [load])

  const rows = useMemo(() => {
    const byFamily = new Map<string, RadarModel[]>()
    for (const model of data?.models ?? []) {
      const list = byFamily.get(model.family)
      if (list) list.push(model)
      else byFamily.set(model.family, [model])
    }
    return [...byFamily.entries()].map(([family, items]) => ({ family, items }))
  }, [data])

  const refresh = () => void load(true)

  return (
    <div data-testid="radar-panel" className="h-full space-y-4 overflow-auto p-4">
      {/* —— Station Picks —— */}
      <section data-testid="radar-picks" className="rounded-lg p-3"
        style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-medium">◎ 电台精选</h2>
          <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            实测结果里挑出的实用组合
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {data && (
            <span data-testid="radar-picks-time" className="rounded px-1.5 py-0.5 text-[11px] tabular-nums"
              style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)' }}>
              {clock(data.updatedAt)}
            </span>
          )}
          <RefreshButton onClick={refresh} busy={loading} testId="radar-refresh-picks" />
        </div>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {(data?.picks ?? []).map((pick) => (
            <div key={pick.key} data-testid={`radar-pick-${pick.key}`} className="rounded-lg"
              style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <div className="px-2 py-1 text-xs font-medium"
                style={{ borderBottom: '1px solid var(--color-line)' }} title={pick.rule}>
                {pick.title} <span style={{ color: 'var(--color-fg-dim)' }}>ⓘ</span>
              </div>
              {pick.items.map((item) => (
                <div key={item.id} className="flex items-baseline gap-2 px-2 py-1 text-xs tabular-nums">
                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--color-fg)' }}>{item.label}</span>
                  <span className="w-12 text-right" style={{ color: 'var(--color-success)' }}>
                    {item.iq == null ? '—' : item.iq.toFixed(1)}
                  </span>
                  <span className="w-14 text-right" style={{ color: 'var(--color-fg-dim)' }}>{money(item.costUsd)}</span>
                  <span className="w-10 text-right" style={{ color: 'var(--color-fg-dim)' }}>{minutes(item.minutes)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* —— Intelligence Efficiency —— */}
      <section data-testid="radar-efficiency" className="rounded-lg p-3"
        style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-medium">🧠 智能效率</h2>
          {data && (
            <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
              更新于 {clock(data.metricsUpdatedAt || data.updatedAt)}
            </span>
          )}
          <RefreshButton onClick={refresh} busy={loading} testId="radar-refresh-efficiency" />
          <span className="ml-auto text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            社区实测数据 · 每一次贡献都让结果更准
          </span>
        </div>
        {data && (
          <div className="mt-1">
            <span data-testid="radar-runs" className="rounded px-1.5 py-0.5 text-[11px] tabular-nums"
              style={{ border: '1px solid var(--color-accent)', color: 'var(--color-accent)' }}>
              24 小时内 {data.runs24hTotal} 次有效运行
            </span>
          </div>
        )}
        <div className="mt-2 overflow-x-auto">
          <div className="space-y-2" style={{ minWidth: 720 }}>
            {rows.map(({ family, items }) => (
              <div key={family} data-testid={`radar-family-${family}`}
                className="grid gap-2" style={{ gridTemplateColumns: `repeat(${TIERS.length}, minmax(0, 1fr))` }}>
                {items.map((model) => (
                  <div key={model.id} style={{ gridColumn: TIERS.indexOf(model.effort) + 1 }}>
                    <ModelCard model={model} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* —— Combined cost × IQ —— */}
      {data && data.models.length > 0 && (
        <section data-testid="radar-chart-section" className="rounded-lg p-3"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-sm font-medium">综合成本 × IQ</h2>
            <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>更新于 {clock(data.updatedAt)}</span>
            <span className="ml-auto text-xs" style={{ color: 'var(--color-fg-dim)' }}>越靠左上越划算</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            {[...new Map(data.models.map((m) => [m.family, m.color])).entries()].map(([family, color]) => (
              <span key={family} className="flex items-center gap-1" style={{ color: 'var(--color-fg-dim)' }}>
                <span className="inline-block h-0.5 w-4" style={{ background: color }} />{family}
              </span>
            ))}
          </div>
          <CostIqChart models={data.models} />
        </section>
      )}

      {/* 拿旧数据顶上时必须说清楚,否则用户会以为看到的是最新的。 */}
      {data?.stale && (
        <div data-testid="radar-stale" className="rounded-lg p-2 text-xs"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
          没能连上 codexradar（{data.error}），上面是 {clock(new Date(data.fetchedAt).toISOString())} 取到的那批。
        </div>
      )}

      {error && !data && (
        <div data-testid="radar-error" className="rounded-lg p-3 text-xs"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)', color: 'var(--color-danger)' }}>
          {error}
        </div>
      )}

      {!data && !error && <div className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>读取中…</div>}
    </div>
  )
}
