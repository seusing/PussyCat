import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, createChart } from 'lightweight-charts'
import { fetchVkChart, type VkChart } from '../../host/vkClient'
import { VerticalMarker } from './chartMarker'
import './MarketChart.css'

/** 笔记里的行情图引用:`charts/<12 位十六进制>.json`。 */
export const CHART_SRC = /^charts\/([0-9a-f]{12})\.json$/

/** 图的配色读应用的主题变量;红涨绿跌,A 股、港股的习惯。 */
function readTheme() {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    text: token('--color-fg-dim', '#9aa4b2'),
    line: token('--color-line', '#262c38'),
    accent: token('--color-accent', '#4f8cff'),
    up: token('--color-danger', '#f85149'),
    down: token('--color-success', '#3fb950'),
  }
}

/** 发布日不一定是交易日:竖线落在发布日当天或之后的第一根 K 线上,发布日晚于最后一根就落在最后一根。 */
function markerBarTime(chart: VkChart): string {
  const { bars, marker } = chart
  return (bars.find((bar) => bar.time >= marker.time) ?? bars[bars.length - 1]).time
}

function ChartCanvas({ chart }: { chart: VkChart }) {
  const hostRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const theme = readTheme()
    const api = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: theme.text },
      grid: { vertLines: { color: theme.line }, horzLines: { color: theme.line } },
      rightPriceScale: { borderColor: theme.line },
      timeScale: { borderColor: theme.line },
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
    series.setData(chart.bars)
    series.attachPrimitive(new VerticalMarker(
      markerBarTime(chart),
      `${chart.marker.label} ${chart.marker.time}`,
      { line: theme.accent, text: theme.accent },
    ))
    api.timeScale().setVisibleRange(chart.visible)
    return () => api.remove()
  }, [chart])

  return <span ref={hostRef} className="vk-chart-canvas" />
}

/**
 * 一张笔记行情图:取回图 JSON 后用 lightweight-charts 画 K 线,默认定位到 visible 范围,可拖动、缩放。
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
  const { chart } = state
  const tradingViewUrl = typeof chart.tradingview_url === 'string' && /^https:\/\//.test(chart.tradingview_url)
    ? chart.tradingview_url
    : null
  return (
    <span className="vk-chart">
      <span className="vk-chart-title">{alt || chart.title}</span>
      <ChartCanvas chart={chart} />
      <span className="vk-chart-footer">
        <span>数据来源：{chart.source}</span>
        {tradingViewUrl && (
          <a href={tradingViewUrl} target="_blank" rel="noopener noreferrer">在 TradingView 中打开</a>
        )}
      </span>
    </span>
  )
}
