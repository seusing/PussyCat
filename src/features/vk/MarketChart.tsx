import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type CandlestickData,
  type Time,
} from 'lightweight-charts'
import {
  fetchVkChart,
  fetchVkChartBars,
  type VkChart,
  type VkChartBar,
  type VkChartInterval,
} from '../../host/vkClient'
import { alignBand, firstBarFrom, lastBarUntil, type BarTime } from './chartTime'
import { TimeBand, VerticalMarker } from './chartMarker'
import './MarketChart.css'

/** 笔记里的行情图引用:`charts/<12 位十六进制>.json`。 */
export const CHART_SRC = /^charts\/([0-9a-f]{12})\.json$/

/** 非存档周期默认只显示最近这么多根 K 线。 */
const VISIBLE_BARS = 150

const INTERVALS: ReadonlyArray<{ value: VkChartInterval; label: string }> = [
  { value: '15m', label: '15分' },
  { value: '1h', label: '1时' },
  { value: '4h', label: '4时' },
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

const PERIOD_NAMES: Record<string, string> = {
  '15m': '15分钟K',
  '1h': '1小时K',
  '4h': '4小时K',
  day: '日K',
  week: '周K',
  month: '月K',
}

/** 引擎写的图名里带着存档周期(日K / 周K / 月K);换了周期就把第一个出现的换成当前周期。图名里没有这三个词时原样返回。 */
export function titleForPeriod(title: string, period: string): string {
  const name = PERIOD_NAMES[period]
  return name ? title.replace(/日K|周K|月K/, name) : title
}

/** 图的配色读应用的主题变量;红涨绿跌,A 股、港股的习惯。 */
function readTheme() {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    text: token('--color-fg-dim', '#9aa4b2'),
    line: token('--color-line', '#262c38'),
    accent: token('--color-accent', '#4f8cff'),
    warning: token('--color-warning', '#d29922'),
    up: token('--color-danger', '#f85149'),
    down: token('--color-success', '#3fb950'),
  }
}

/**
 * 发布日不一定是交易日:竖线落在发布日当天或之后的第一根 K 线上。
 * 存档的默认周期里发布日晚于最后一根就落在最后一根;其他周期的数据范围不含发布日时返回 null。
 */
function markerBarTime(bars: VkChartBar[], day: string, isDefaultPeriod: boolean): BarTime | null {
  const onOrAfter = firstBarFrom(bars, day)
  if (isDefaultPeriod) return onOrAfter ?? bars[bars.length - 1].time
  return lastBarUntil(bars, day) === null ? null : onOrAfter
}

/** 当前显示的一组 K 线;first / last 只有取回的周期才有。 */
type ChartData = { period: string; bars: VkChartBar[]; first?: string; last?: string }

function ChartCanvas({ chart, data, markerTime }: { chart: VkChart; data: ChartData; markerTime: BarTime | null }) {
  const hostRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const theme = readTheme()
    const { bars } = data
    const isDefaultPeriod = data.period === chart.period
    const api = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: theme.text },
      grid: { vertLines: { color: theme.line }, horzLines: { color: theme.line } },
      rightPriceScale: { borderColor: theme.line },
      // 分钟级 time 是整数秒,横轴要带时分。
      timeScale: { borderColor: theme.line, timeVisible: typeof bars[0].time === 'number', secondsVisible: false },
      localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' },
    })
    const series = api.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    })
    series.setData(bars as CandlestickData<Time>[])
    if (markerTime !== null) {
      series.attachPrimitive(new VerticalMarker(
        markerTime as Time,
        `${chart.marker.label} ${chart.marker.time}`,
        { line: theme.accent, text: theme.accent },
      ))
    }
    // 画出来的色带各占一行标签,起点相同的两条带标签不叠。
    let labelRow = 0
    for (const band of chart.bands ?? []) {
      const span = alignBand(bars, band.from, band.to)
      if (!span) continue
      const forecast = band.kind === 'forecast'
      series.attachPrimitive(new TimeBand(
        span.from as Time,
        span.to as Time,
        forecast ? `预测 · ${band.label}` : band.label,
        forecast ? theme.warning : theme.accent,
        labelRow,
      ))
      labelRow += 1
    }
    for (const level of chart.levels ?? []) {
      if (!level.drawable) continue
      const lines = level.high === null
        ? [{ price: level.low, title: level.label }]
        : [{ price: level.low, title: `${level.label} 下沿` }, { price: level.high, title: `${level.label} 上沿` }]
      for (const line of lines) {
        series.createPriceLine({ ...line, color: theme.accent, lineWidth: 1, lineStyle: LineStyle.Dashed })
      }
    }
    if (isDefaultPeriod) {
      api.timeScale().setVisibleRange(chart.visible)
    } else {
      api.timeScale().setVisibleLogicalRange({
        from: Math.max(bars.length - VISIBLE_BARS, 0) - 0.5,
        to: bars.length - 0.5,
      })
    }
    return () => api.remove()
  }, [chart, data, markerTime])

  return <span ref={hostRef} className="vk-chart-canvas" />
}

function PeriodSwitch({ intervals, current, busy, onSelect }: {
  intervals: VkChartInterval[]
  current: string
  busy: boolean
  onSelect: (period: VkChartInterval) => void
}) {
  return (
    <span className="vk-chart-periods" role="group" aria-label="K 线周期">
      {INTERVALS.map(({ value, label }) => {
        const supported = intervals.includes(value)
        return (
          <button
            key={value}
            type="button"
            className={value === current ? 'is-active' : undefined}
            aria-pressed={value === current}
            disabled={busy || !supported}
            title={supported ? undefined : value === '4h' ? '东方财富不提供 4 小时 K 线' : '数据源不提供该周期'}
            onClick={() => onSelect(value)}
          >
            {label}
          </button>
        )
      })}
    </span>
  )
}

function ChartView({ jobId, baseUrl, name, alt, chart }: {
  jobId: string
  baseUrl?: string
  name: string
  alt: string
  chart: VkChart
}) {
  const archive = useMemo<ChartData>(() => ({ period: chart.period, bars: chart.bars }), [chart])
  const [data, setData] = useState(archive)
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  // 取过的周期留着,切回来不再请求;存档的默认周期本来就在手里。
  const cache = useRef(new Map<string, ChartData>())

  const select = async (period: VkChartInterval) => {
    if (status.loading || period === data.period) return
    const cached = period === chart.period ? archive : cache.current.get(period)
    if (cached) {
      setStatus({ loading: false, error: null })
      setData(cached)
      return
    }
    setStatus({ loading: true, error: null })
    try {
      const answer = await fetchVkChartBars(jobId, name, period, baseUrl)
      const fetched: ChartData = { period, bars: answer.bars, first: answer.first, last: answer.last }
      cache.current.set(period, fetched)
      setData(fetched)
      setStatus({ loading: false, error: null })
    } catch (error) {
      setStatus({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const tradingViewUrl = typeof chart.tradingview_url === 'string' && /^https:\/\//.test(chart.tradingview_url)
    ? chart.tradingview_url
    : null
  const markerTime = markerBarTime(data.bars, chart.marker.time, data.period === chart.period)
  const minute = typeof data.bars[0].time === 'number'
  const title = alt || chart.title
  const undrawn = (chart.levels ?? []).filter((level) => !level.drawable).map((level) => level.label)
  return (
    <span className="vk-chart">
      <span className="vk-chart-title">{data.period === chart.period ? title : titleForPeriod(title, data.period)}</span>
      {chart.intervals && (
        <span className="vk-chart-toolbar">
          <PeriodSwitch intervals={chart.intervals} current={data.period} busy={status.loading} onSelect={select} />
          {status.loading && <span className="vk-chart-status">加载中…</span>}
          {status.error && <span className="vk-chart-status is-error" role="alert">取数失败：{status.error}</span>}
        </span>
      )}
      <ChartCanvas chart={chart} data={data} markerTime={markerTime} />
      <span className="vk-chart-footer">
        <span>数据来源：{chart.source}</span>
        {minute && data.first && data.last && <span>数据覆盖 {data.first} 至 {data.last}</span>}
        {markerTime === null && <span>视频发布日不在此周期的数据范围内</span>}
        {undrawn.length > 0 && <span>博主提到的价位：{undrawn.join('；')}（单位与本图不同，未画出）</span>}
        {tradingViewUrl && (
          <a href={tradingViewUrl} target="_blank" rel="noopener noreferrer">在 TradingView 中打开</a>
        )}
      </span>
    </span>
  )
}

/**
 * 一张笔记行情图:取回图 JSON 后用 lightweight-charts 画 K 线,默认定位到 visible 范围,可拖动、缩放,
 * 图里标出博主说的时段和价位,并可切换 K 线周期。
 * 用 span 而不是 div:图引用写在笔记的段落里,段落里放不了块元素。
 */
export function MarketChart({ jobId, baseUrl, name, alt }: {
  jobId: string
  baseUrl?: string
  name: string
  alt: string
}) {
  const key = JSON.stringify([baseUrl, jobId, name])
  const [loaded, setLoaded] = useState<{ key: string; chart: VkChart | null } | null>(null)

  useEffect(() => {
    let current = true
    fetchVkChart(jobId, name, baseUrl)
      .then((chart) => { if (current) setLoaded({ key, chart }) })
      .catch(() => { if (current) setLoaded({ key, chart: null }) })
    return () => { current = false }
  }, [key, jobId, name, baseUrl])

  // 上一张图的结果不能挂到换了地址的这张上。
  const state = loaded?.key === key ? loaded : null
  if (!state) return <span className="vk-chart is-loading">行情图加载中…</span>
  if (!state.chart) return <span className="vk-chart is-failed" title={alt || undefined}>行情图加载失败</span>
  return <ChartView key={key} jobId={jobId} baseUrl={baseUrl} name={name} alt={alt} chart={state.chart} />
}
