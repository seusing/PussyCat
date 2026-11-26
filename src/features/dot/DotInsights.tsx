import { useId, useState, type PointerEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DotInsight, InsightChange, InsightMetric, InsightPoint, InsightSegment } from './dotInsightData'

// 数据洞察:回答里能比较的数字画成小图,几张卡片用「‹ ›」翻。
// 涨跌配色同行情图:红涨绿跌。

const SEGMENT_COLORS = ['#4f8cff', '#3fb950', '#d29922', '#db61a2', '#39c5cf', '#a371f7', '#f0883e']

const Entity = ({ children }: { children: ReactNode }) => <span className="dot-insight-entity">{children}</span>
const Num = ({ children, tone }: { children: ReactNode; tone?: 'up' | 'down' }) => (
  <code className={`dot-insight-num${tone ? ` is-${tone}` : ''}`}>{children}</code>
)

/** 最大、最小用什么字:时长说最长最短,距离说最远最近…… */
function extremes(family: string): [string, string] {
  if (family === 'minutes') return ['最长', '最短']
  if (family === 'meters') return ['最远', '最近']
  if (family === 'grams') return ['最重', '最轻']
  if (family.startsWith('count:')) return ['最多', '最少']
  return ['最高', '最低']
}

const trim = (value: number, digits = 2) => String(Number(value.toFixed(digits)))

/** 变化幅度:百分数之间说「个百分点」,其余说相对涨跌。 */
export function changeDelta(change: InsightChange): { text: string; tone: 'up' | 'down' | undefined; relative: number } {
  const diff = change.to - change.from
  const relative = change.from !== 0 ? diff / Math.abs(change.from) : 0
  const tone = diff > 0 ? 'up' : diff < 0 ? 'down' : undefined
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  const text = change.percent || change.from === 0
    ? `${sign}${trim(Math.abs(diff))}${change.percent ? ' 个百分点' : ''}`
    : `${sign}${trim(Math.abs(relative) * 100, 1)}%`
  return { text, tone, relative }
}

function MetricToggle({ metrics, index, onChange }: { metrics: InsightMetric[]; index: number; onChange: (index: number) => void }) {
  if (metrics.length < 2) return null
  return (
    <span className="dot-insight-toggle" role="group" aria-label="指标">
      {metrics.map((metric, position) => (
        <button key={metric.name} type="button" aria-pressed={position === index} onClick={() => onChange(position)}>
          {metric.name}
        </button>
      ))}
    </span>
  )
}

function Bars({ points }: { points: InsightPoint[] }) {
  const max = Math.max(...points.map((point) => point.value), 0)
  const top = points.reduce((best, point) => (point.value > best.value ? point : best), points[0])
  return (
    <ul className="dot-bars">
      {points.map((point, index) => (
        <li key={`${point.label}-${index}`} className={point === top ? 'is-top' : undefined}>
          <span className="dot-bar-label" title={point.label}>{point.label}</span>
          <span className="dot-bar-track">
            <span
              className="dot-bar-fill"
              style={{ width: `${max > 0 ? Math.max(0, point.value / max) * 100 : 0}%`, animationDelay: `${index * 40}ms` }}
            />
          </span>
          <span className="dot-bar-value">{point.display}</span>
        </li>
      ))}
    </ul>
  )
}

// 折线:Catmull-Rom 转三次贝塞尔,曲线经过每个点
const LINE_W = 320
const LINE_H = 120
const LINE_PAD = 14

function linePath(coords: Array<[number, number]>): string {
  if (coords.length < 2) return ''
  let path = `M${coords[0][0]},${coords[0][1]}`
  for (let index = 0; index < coords.length - 1; index += 1) {
    const [x0, y0] = coords[Math.max(0, index - 1)]
    const [x1, y1] = coords[index]
    const [x2, y2] = coords[index + 1]
    const [x3, y3] = coords[Math.min(coords.length - 1, index + 2)]
    path += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`
  }
  return path
}

/** 折线;鼠标所在的点交给 onHover,由卡片标题行显示读数(不在图上浮一块提示盖住线)。 */
function Line({ points, hover, onHover }: { points: InsightPoint[]; hover: number | null; onHover: (index: number | null) => void }) {
  const gradientId = useId()
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const coords = points.map((point, index): [number, number] => [
    (index / (points.length - 1)) * LINE_W,
    max === min ? LINE_H / 2 : LINE_PAD + (1 - (point.value - min) / (max - min)) * (LINE_H - LINE_PAD * 2),
  ])
  const path = linePath(coords)
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const progress = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onHover(Math.round(progress * (points.length - 1)))
  }
  return (
    <div className="dot-line">
      <div className="dot-line-stage" onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => onHover(null)}>
        <svg viewBox={`0 0 ${LINE_W} ${LINE_H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path} L${LINE_W},${LINE_H} L0,${LINE_H} Z`} fill={`url(#${gradientId})`} />
          <path d={path} className="dot-line-path" />
        </svg>
        {coords.map(([x, y], index) => (
          <span
            key={index}
            className={`dot-line-dot${hover === index ? ' is-active' : ''}`}
            style={{ left: `${(x / LINE_W) * 100}%`, top: `${(y / LINE_H) * 100}%` }}
          />
        ))}
        {hover !== null && coords[hover] && (
          <span className="dot-line-cursor" style={{ left: `${(coords[hover][0] / LINE_W) * 100}%` }} />
        )}
      </div>
      <div className="dot-line-axis">
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  )
}

function SeriesPage({ insight }: { insight: Extract<DotInsight, { kind: 'series' }> }) {
  const [index, setIndex] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const metric = insight.metrics[Math.min(index, insight.metrics.length - 1)]
  const points = metric.points
  const hovered = hover === null ? null : points[hover]
  let prose: ReactNode
  if (insight.layout === 'line') {
    const first = points[0]
    const last = points[points.length - 1]
    const change = changeDelta({ label: '', from: first.value, to: last.value, fromText: '', toText: '', percent: metric.family === 'percent' })
    prose = (
      <>
        {metric.name && <>{metric.name}：</>}从 <Entity>{first.label}</Entity> 的 <Num>{first.display}</Num> 到 <Entity>{last.label}</Entity> 的 <Num>{last.display}</Num>
        {change.tone && <>，<Num tone={change.tone}>{change.text}</Num></>}
      </>
    )
  } else {
    const [high, low] = extremes(metric.family)
    const top = points.reduce((best, point) => (point.value > best.value ? point : best), points[0])
    const bottom = points.reduce((best, point) => (point.value < best.value ? point : best), points[0])
    prose = (
      <>
        {metric.name && <>{metric.name}：</>}<Entity>{top.label}</Entity> {high}（<Num>{top.display}</Num>），<Entity>{bottom.label}</Entity> {low}（<Num>{bottom.display}</Num>）
      </>
    )
  }
  return (
    <>
      <p className="dot-insight-prose">{prose}</p>
      <div className="dot-insight-card">
        <div className="dot-insight-card-head">
          {hovered
            ? <span className="is-hover">{hovered.label} · <span className="dot-insight-mono">{hovered.display}</span></span>
            : <span>{insight.subject || metric.name || '对比'}</span>}
          <MetricToggle metrics={insight.metrics} index={index} onChange={(next) => { setIndex(next); setHover(null) }} />
        </div>
        {insight.layout === 'line'
          ? <Line key={metric.name} points={points} hover={hover} onHover={setHover} />
          : <Bars key={metric.name} points={points} />}
      </div>
    </>
  )
}

function ChangePage({ changes }: { changes: InsightChange[] }) {
  const rows = changes.map((change) => ({ change, delta: changeDelta(change) }))
  const biggest = rows.reduce((best, row) => (Math.abs(row.delta.relative) > Math.abs(best.delta.relative) ? row : best), rows[0])
  return (
    <>
      <p className="dot-insight-prose">
        {rows.length} 处前后变化里，<Entity>{biggest.change.label}</Entity> 变化最大：
        <Num>{biggest.change.fromText}</Num> → <Num tone={biggest.delta.tone}>{biggest.change.toText}</Num>
      </p>
      <div className="dot-insight-card">
        <div className="dot-insight-card-head"><span>前后对比</span></div>
        <ul className="dot-changes">
          {rows.map(({ change, delta }, index) => {
            const scale = Math.max(change.from, change.to) * 1.15 || 1
            const left = (Math.min(change.from, change.to) / scale) * 100
            const right = (Math.max(change.from, change.to) / scale) * 100
            return (
              <li key={`${change.label}-${index}`}>
                <div className="dot-change-head">
                  <span className="dot-change-label" title={change.label}>{change.label}</span>
                  <span className="dot-change-values">{change.fromText} → {change.toText}</span>
                  <Num tone={delta.tone}>{delta.text}</Num>
                </div>
                <span className={`dot-change-track${delta.tone ? ` is-${delta.tone}` : ''}`}>
                  <span className="dot-change-span" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
                  <span className="dot-change-dot is-from" style={{ left: `${(change.from / scale) * 100}%` }} />
                  <span className="dot-change-dot is-to" style={{ left: `${(change.to / scale) * 100}%` }} />
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

function SharePage({ segments }: { segments: InsightSegment[] }) {
  const topIndex = segments.reduce((best, segment, index) => (segment.pct > segments[best].pct ? index : best), 0)
  const [selected, setSelected] = useState(topIndex)
  const active = segments[selected] ?? segments[topIndex]
  const total = segments.reduce((sum, segment) => sum + segment.pct, 0)
  return (
    <>
      <p className="dot-insight-prose">
        <Entity>{segments[topIndex].label}</Entity> 占比最高，为 <Num>{trim(segments[topIndex].pct)}%</Num>
      </p>
      <div className="dot-insight-card">
        <div className="dot-insight-card-head"><span>占比</span></div>
        <div className="dot-share">
          <div className="dot-share-hero">
            <strong>{trim(active.pct)}%</strong>
            <span>{active.label}</span>
          </div>
          <div className="dot-share-bar" role="group" aria-label="占比">
            {segments.map((segment, index) => (
              <button
                key={segment.label}
                type="button"
                aria-pressed={index === selected}
                aria-label={`${segment.label}：${trim(segment.pct)}%`}
                onClick={() => setSelected(index)}
                style={{ width: `${(segment.pct / total) * 100}%`, background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }}
              />
            ))}
          </div>
          <div className="dot-share-legend">
            {segments.map((segment, index) => (
              <button key={segment.label} type="button" aria-pressed={index === selected} onClick={() => setSelected(index)}>
                <span style={{ background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }} />
                {segment.label} <span className="dot-insight-mono">{trim(segment.pct)}%</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function InsightPage({ insight }: { insight: DotInsight }) {
  if (insight.kind === 'series') return <SeriesPage insight={insight} />
  if (insight.kind === 'change') return <ChangePage changes={insight.changes} />
  return <SharePage segments={insight.segments} />
}

/** 回答下方的数据洞察;多张时用「‹ ›」翻页,换页时模糊淡入。 */
export function DotInsights({ insights }: { insights: DotInsight[] }) {
  const [page, setPage] = useState(0)
  const count = insights.length
  const current = Math.min(page, count - 1)
  const move = (step: -1 | 1) => setPage((current + step + count) % count)
  return (
    <section className="dot-insights" aria-label="数据洞察" data-testid="dot-insights">
      <header>
        <span className="dot-insights-title">数据洞察</span>
        {count > 1 && (
          <>
            <span className="dot-insights-count">{current + 1}/{count}</span>
            <span className="dot-insights-pager">
              <button type="button" aria-label="上一条" onClick={() => move(-1)}><ChevronLeft size={14} aria-hidden="true" /></button>
              <button type="button" aria-label="下一条" onClick={() => move(1)}><ChevronRight size={14} aria-hidden="true" /></button>
            </span>
          </>
        )}
      </header>
      <div className="dot-insight-page" key={current}>
        <InsightPage insight={insights[current]} />
      </div>
    </section>
  )
}
