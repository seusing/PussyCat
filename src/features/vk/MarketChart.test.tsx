import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { VerticalMarker } from './chartMarker'
import { TermHintMarkdown } from './TermHint'

const chartLib = vi.hoisted(() => {
  const setData = vi.fn()
  const attachPrimitive = vi.fn()
  const setVisibleRange = vi.fn()
  const timeToCoordinate = vi.fn((_time: string) => 120 as number | null)
  const remove = vi.fn()
  const addSeries = vi.fn(() => ({ setData, attachPrimitive }))
  const timeScale = () => ({ setVisibleRange, timeToCoordinate })
  const createChart = vi.fn(() => ({ addSeries, timeScale, remove }))
  return { setData, attachPrimitive, setVisibleRange, timeToCoordinate, remove, addSeries, createChart }
})

vi.mock('lightweight-charts', () => ({
  createChart: chartLib.createChart,
  CandlestickSeries: 'CandlestickSeries',
  ColorType: { Solid: 'solid' },
}))

const NAME = '0123456789ab'
const ALT = '贵州茅台 日K（视频发布前后）'
const note = `- 关键点\n  ![${ALT}](charts/${NAME}.json)`

const CHART = {
  title: '贵州茅台 日K',
  symbol: '600519',
  market: 'a',
  source: '东方财富',
  period: 'day',
  bars: [
    { time: '2026-04-23', open: 10, high: 12, low: 9, close: 11 },
    { time: '2026-04-24', open: 11, high: 13, low: 10, close: 12 },
    { time: '2026-04-27', open: 12, high: 14, low: 11, close: 13 },
  ],
  marker: { time: '2026-04-25', label: '视频发布' },
  visible: { from: '2026-03-10', to: '2026-05-22' },
  tradingview_url: 'https://www.tradingview.com/chart/?symbol=SSE:600519',
}

function stubChartFetch(body: unknown = CHART, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderNote = (markdown = note) => render(
  <TermHintMarkdown terms={[]} note={null} figureJobId="run:r1" baseUrl="http://host">{markdown}</TermHintMarkdown>,
)

beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.removeAttribute('style')
})

describe('MarketChart', () => {
  it('charts/<12 位十六进制>.json 引用按任务取回 JSON,画成 K 线并定位到 visible 范围', async () => {
    const fetchMock = stubChartFetch()
    const { container } = renderNote()

    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(`http://host/vk/v1/jobs/run:r1/charts/${NAME}`)
    expect(chartLib.createChart).toHaveBeenCalledWith(
      container.querySelector('.vk-chart-canvas'),
      expect.objectContaining({ autoSize: true }),
    )
    expect(chartLib.addSeries).toHaveBeenCalledWith('CandlestickSeries', expect.any(Object))
    expect(chartLib.setData).toHaveBeenCalledWith(CHART.bars)
    expect(chartLib.setVisibleRange).toHaveBeenCalledWith(CHART.visible)
    expect(screen.getByText(ALT)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('发布日竖线落在发布日当天或之后的第一根 K 线上,标签带发布日', async () => {
    stubChartFetch()
    renderNote()
    await waitFor(() => expect(chartLib.attachPrimitive).toHaveBeenCalledTimes(1))

    const marker = chartLib.attachPrimitive.mock.calls[0][0] as unknown
    expect(marker).toBeInstanceOf(VerticalMarker)
    const chart = { timeScale: () => ({ timeToCoordinate: chartLib.timeToCoordinate }) }
    ;(marker as VerticalMarker).attached({ chart, requestUpdate: vi.fn() } as never)
    expect(chartLib.timeToCoordinate).toHaveBeenLastCalledWith('2026-04-27')
  })

  it('发布日晚于最后一根 K 线时竖线落在最后一根上', async () => {
    stubChartFetch({ ...CHART, marker: { time: '2026-05-30', label: '视频发布' } })
    renderNote()
    await waitFor(() => expect(chartLib.attachPrimitive).toHaveBeenCalledTimes(1))

    const chart = { timeScale: () => ({ timeToCoordinate: chartLib.timeToCoordinate }) }
    ;(chartLib.attachPrimitive.mock.calls[0][0] as VerticalMarker).attached({ chart, requestUpdate: vi.fn() } as never)
    expect(chartLib.timeToCoordinate).toHaveBeenLastCalledWith('2026-04-27')
  })

  it('图下一行写数据来源,「在 TradingView 中打开」走外链', async () => {
    stubChartFetch()
    renderNote()
    const link = await screen.findByRole('link', { name: '在 TradingView 中打开' })
    expect(link).toHaveAttribute('href', CHART.tradingview_url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link.parentElement).toHaveTextContent('数据来源：东方财富')
  })

  it('没有 TradingView 地址、或地址不是 https 时不出链接', async () => {
    stubChartFetch({ ...CHART, tradingview_url: 'javascript:alert(1)' })
    const first = renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(screen.getByText('数据来源：东方财富')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '在 TradingView 中打开' })).not.toBeInTheDocument()
    first.unmount()

    stubChartFetch({ ...CHART, tradingview_url: null })
    renderNote()
    await screen.findByText('数据来源：东方财富')
    expect(screen.queryByRole('link', { name: '在 TradingView 中打开' })).not.toBeInTheDocument()
  })

  it('配色读应用的主题变量:红涨绿跌取 danger / success,标记线取 accent', async () => {
    document.documentElement.style.setProperty('--color-danger', '#aa0000')
    document.documentElement.style.setProperty('--color-success', '#00aa00')
    document.documentElement.style.setProperty('--color-fg-dim', '#abcdef')
    stubChartFetch()
    renderNote()
    await waitFor(() => expect(chartLib.addSeries).toHaveBeenCalledTimes(1))

    expect(chartLib.addSeries).toHaveBeenCalledWith('CandlestickSeries', expect.objectContaining({
      upColor: '#aa0000', wickUpColor: '#aa0000', downColor: '#00aa00', wickDownColor: '#00aa00',
    }))
    expect(chartLib.createChart).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      layout: expect.objectContaining({ textColor: '#abcdef' }),
    }))
  })

  it('加载中先显示占位', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderNote()
    expect(await screen.findByText('行情图加载中…')).toBeInTheDocument()
    expect(chartLib.createChart).not.toHaveBeenCalled()
  })

  it.each([
    ['取图失败', () => stubChartFetch({ error: '没有' }, 404)],
    ['图里没有 K 线', () => stubChartFetch({ ...CHART, bars: [] })],
  ])('%s显示「行情图加载失败」,不建图', async (_name, stub) => {
    stub()
    renderNote()
    expect(await screen.findByText('行情图加载失败')).toBeInTheDocument()
    expect(chartLib.createChart).not.toHaveBeenCalled()
  })

  it('卸载时销毁图', async () => {
    stubChartFetch()
    const { unmount } = renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    unmount()
    expect(chartLib.remove).toHaveBeenCalledTimes(1)
  })

  it('图地址变化时销毁旧图并取新图', async () => {
    const fetchMock = stubChartFetch()
    const { rerender } = renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    rerender(
      <TermHintMarkdown terms={[]} note={null} figureJobId="run:r1" baseUrl="http://host">{'![另一张](charts/ffffffffffff.json)'}</TermHintMarkdown>,
    )
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(chartLib.remove).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenLastCalledWith('http://host/vk/v1/jobs/run:r1/charts/ffffffffffff')
    cleanup()
  })

  it('没有 figureJobId 时 charts/ 引用按普通图片渲染,不发请求', () => {
    const fetchMock = stubChartFetch()
    render(<TermHintMarkdown terms={[]} note={null}>{note}</TermHintMarkdown>)
    expect(screen.getByAltText(ALT)).toHaveAttribute('src', `charts/${NAME}.json`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chartLib.createChart).not.toHaveBeenCalled()
  })

  it('不符合 charts/<12 位十六进制>.json 的引用照常渲染,不发请求', () => {
    const fetchMock = stubChartFetch()
    render(<TermHintMarkdown terms={[]} note={null} figureJobId="job-1">{'![别的图](charts/xyz.json)'}</TermHintMarkdown>)
    expect(screen.getByAltText('别的图')).toHaveAttribute('src', 'charts/xyz.json')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('图和配图可以出现在同一个关键点下', async () => {
    stubChartFetch()
    const { container } = renderNote(`- 关键点\n  ![${ALT}](charts/${NAME}.json)\n  ![图注](figures/aaaaaaaaaaaa.jpg)`)
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    const item = container.querySelector('li')!
    expect(within(item).getByText(ALT)).toBeInTheDocument()
  })
})
