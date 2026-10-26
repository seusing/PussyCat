import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TimeBand, VerticalMarker } from './chartMarker'
import { titleForPeriod } from './MarketChart'
import { TermHintMarkdown } from './TermHint'

const chartLib = vi.hoisted(() => {
  const setData = vi.fn()
  const attachPrimitive = vi.fn()
  const createPriceLine = vi.fn()
  const setVisibleRange = vi.fn()
  const setVisibleLogicalRange = vi.fn()
  const timeToCoordinate = vi.fn((_time: string) => 120 as number | null)
  const remove = vi.fn()
  const addSeries = vi.fn(() => ({ setData, attachPrimitive, createPriceLine }))
  const timeScale = () => ({ setVisibleRange, setVisibleLogicalRange, timeToCoordinate })
  const createChart = vi.fn(() => ({ addSeries, timeScale, remove }))
  return {
    setData, attachPrimitive, createPriceLine, setVisibleRange, setVisibleLogicalRange, timeToCoordinate, remove, addSeries, createChart,
  }
})

vi.mock('lightweight-charts', () => ({
  createChart: chartLib.createChart,
  CandlestickSeries: 'CandlestickSeries',
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
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

// —— 时段、价位、周期切换 ——

// 分钟级 time:北京钟面当作 UTC 编码的整数秒。
const clock = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000
const bar = (time: string | number) => ({ time, open: 10, high: 12, low: 9, close: 11 })

const HOURLY = {
  period: '1h',
  bars: [clock(2026, 10, 26, 10, 30), clock(2026, 10, 26, 11, 30), clock(2026, 10, 26, 15, 0)].map(bar),
  first: '2026-10-26 10:30',
  last: '2026-10-26 15:00',
}
const SWITCHABLE = { ...CHART, intervals: ['15m', '1h', 'day', 'week', 'month'] }

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

/** 图 JSON 一个答案,/bars?period=<p> 按 period 取答案;没配的周期回 400。 */
function stubChartAndBars(chart: unknown, answers: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (url: string) => {
    const period = /\/bars\?period=(.+)$/.exec(url)?.[1]
    if (period === undefined) return new Response(JSON.stringify(chart), { status: 200 })
    return (answers[period] ?? json({ error: '周期不在 intervals 里' }, 400))()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const periodButtons = () => within(screen.getByRole('group', { name: 'K 线周期' })).getAllByRole('button')

/** 让原语按给定的坐标映射画一遍,返回画布上收到的调用。 */
function drawPrimitive(primitive: unknown, coordinates: (time: string | number) => number | null) {
  const timeToCoordinate = vi.fn(coordinates)
  const chart = { timeScale: () => ({ timeToCoordinate, logicalToCoordinate: (logical: number) => logical * 10 }) }
  const context = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 80 })),
    strokeStyle: '', fillStyle: '', globalAlpha: 1, lineWidth: 0, font: '', textAlign: '', textBaseline: '',
  }
  const view = primitive as TimeBand
  view.attached({ chart, requestUpdate: vi.fn() } as never)
  const target = {
    useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 400, height: 260 } }),
  }
  view.paneViews()[0].renderer()!.draw(target as never)
  return { context, timeToCoordinate }
}

const attachedBands = () => chartLib.attachPrimitive.mock.calls.map(([primitive]) => primitive).filter((p) => p instanceof TimeBand)
const attachedMarkers = () => chartLib.attachPrimitive.mock.calls.map(([primitive]) => primitive).filter((p) => p instanceof VerticalMarker)

describe('MarketChart 周期按钮', () => {
  it('旧图(没有 intervals / bands / levels)不显示周期按钮,不画时段和价位,脚注只有数据来源和外链', async () => {
    stubChartFetch()
    const { container } = renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('group', { name: 'K 线周期' })).not.toBeInTheDocument()
    expect(container.querySelector('.vk-chart button')).toBeNull()
    expect(attachedBands()).toHaveLength(0)
    expect(attachedMarkers()).toHaveLength(1)
    expect(chartLib.createPriceLine).not.toHaveBeenCalled()
    expect(chartLib.setVisibleLogicalRange).not.toHaveBeenCalled()
    expect(chartLib.createChart).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      timeScale: expect.objectContaining({ timeVisible: false }),
    }))
    expect(container.querySelector('.vk-chart-footer')).toHaveTextContent(/^数据来源：东方财富在 TradingView 中打开$/)
  })

  it('有 intervals 时图上方一行六个按钮,默认周期高亮;东方财富的图 4 时置灰并写明原因', async () => {
    stubChartFetch(SWITCHABLE)
    renderNote()
    await screen.findByRole('group', { name: 'K 线周期' })

    expect(periodButtons().map((button) => button.textContent)).toEqual(['15分', '1时', '4时', '日', '周', '月'])
    const four = screen.getByRole('button', { name: '4时' })
    expect(four).toBeDisabled()
    expect(four).toHaveAttribute('title', '东方财富不提供 4 小时 K 线')
    for (const name of ['15分', '1时', '日', '周', '月']) expect(screen.getByRole('button', { name })).toBeEnabled()
    expect(screen.getByRole('button', { name: '日' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '日' })).toHaveClass('is-active')
    expect(screen.getByRole('button', { name: '1时' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('周期不在 intervals 里的置灰,4 时以外的原因写「数据源不提供该周期」;六个都在时全部可点', async () => {
    stubChartFetch({ ...CHART, period: 'week', intervals: ['1h', 'week'] })
    const first = renderNote()
    await screen.findByRole('group', { name: 'K 线周期' })
    expect(screen.getByRole('button', { name: '15分' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '15分' })).toHaveAttribute('title', '数据源不提供该周期')
    expect(screen.getByRole('button', { name: '月' })).toHaveAttribute('title', '数据源不提供该周期')
    expect(screen.getByRole('button', { name: '1时' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '1时' })).not.toHaveAttribute('title')
    expect(screen.getByRole('button', { name: '周' })).toHaveAttribute('aria-pressed', 'true')
    first.unmount()

    stubChartFetch({ ...CHART, intervals: ['15m', '1h', '4h', 'day', 'week', 'month'] })
    renderNote()
    await screen.findByRole('group', { name: 'K 线周期' })
    for (const button of periodButtons()) expect(button).toBeEnabled()
  })

  it('点另一个周期:取该周期的 K 线、整张图重建;取数时按钮全部置灰并显示「加载中…」', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = stubChartAndBars(SWITCHABLE, { '1h': () => pending })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(fetchMock).toHaveBeenLastCalledWith(`http://host/vk/v1/jobs/run:r1/charts/${NAME}/bars?period=1h`)
    expect(screen.getByText('加载中…')).toBeInTheDocument()
    for (const button of periodButtons()) expect(button).toBeDisabled()
    expect(chartLib.createChart).toHaveBeenCalledTimes(1)

    release(new Response(JSON.stringify(HOURLY), { status: 200 }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(chartLib.remove).toHaveBeenCalledTimes(1)
    expect(chartLib.setData).toHaveBeenLastCalledWith(HOURLY.bars)
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1时' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '日' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '日' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '4时' })).toBeDisabled()
  })

  it('分钟级图的横轴带时分,可见范围是最近 150 根(不足就全显示);默认周期仍用 visible', async () => {
    stubChartAndBars(SWITCHABLE, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(chartLib.setVisibleRange).toHaveBeenCalledWith(CHART.visible)
    expect(chartLib.setVisibleLogicalRange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(chartLib.createChart).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      timeScale: expect.objectContaining({ timeVisible: true, secondsVisible: false }),
    }))
    expect(chartLib.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: -0.5, to: 2.5 })
    expect(chartLib.setVisibleRange).toHaveBeenCalledTimes(1)
  })

  it('超过 150 根时只显示最近 150 根', async () => {
    const weekly = {
      period: 'week',
      bars: Array.from({ length: 200 }, (_, index) => bar(new Date(Date.UTC(2023, 0, 2 + 7 * index)).toISOString().slice(0, 10))),
      first: '2023-01-02',
      last: '2026-10-26',
    }
    stubChartAndBars(SWITCHABLE, { week: json(weekly) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '周' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(chartLib.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 49.5, to: 199.5 })
  })

  it('取过的周期缓存在组件里,切回来不再请求;默认周期用存档的 K 线', async () => {
    const fetchMock = stubChartAndBars(SWITCHABLE, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: '日' }))
    expect(chartLib.createChart).toHaveBeenCalledTimes(3)
    expect(chartLib.setData).toHaveBeenLastCalledWith(CHART.bars)
    expect(chartLib.setVisibleRange).toHaveBeenLastCalledWith(CHART.visible)

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(chartLib.createChart).toHaveBeenCalledTimes(4)
    expect(chartLib.setData).toHaveBeenLastCalledWith(HOURLY.bars)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(chartLib.createChart).toHaveBeenCalledTimes(4)
  })

  it('取数失败:停在原周期,显示「取数失败：原因」;再点可以重试', async () => {
    const answers: Record<string, () => Response> = { '1h': json({ error: '东方财富暂时取不到数据' }, 502) }
    const fetchMock = stubChartAndBars(SWITCHABLE, answers)
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(await screen.findByText('取数失败：东方财富暂时取不到数据')).toBeInTheDocument()
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '日' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '1时' })).toBeEnabled()
    expect(chartLib.createChart).toHaveBeenCalledTimes(1)

    answers['1h'] = json(HOURLY)
    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/取数失败/)).not.toBeInTheDocument()
  })

  it('分钟级脚注写「数据覆盖 起 至 止」;日线以上不写', async () => {
    stubChartAndBars(SWITCHABLE, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/数据覆盖/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(await screen.findByText('数据覆盖 2026-10-26 10:30 至 2026-10-26 15:00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '日' }))
    expect(screen.queryByText(/数据覆盖/)).not.toBeInTheDocument()
  })

  it('发布日在分钟级数据范围内:竖线落在发布日当天或之后的第一根上,按秒数对齐', async () => {
    stubChartAndBars({ ...SWITCHABLE, marker: { time: '2026-10-26', label: '视频发布' } }, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    chartLib.attachPrimitive.mockClear()

    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(attachedMarkers()).toHaveLength(1))
    const { timeToCoordinate } = drawPrimitive(attachedMarkers()[0], () => 100)
    expect(timeToCoordinate).toHaveBeenLastCalledWith(HOURLY.bars[0].time)
    expect(screen.queryByText('视频发布日不在此周期的数据范围内')).not.toBeInTheDocument()
  })

  it.each([
    ['早于第一根', '2026-04-25'],
    ['晚于最后一根', '2026-12-01'],
  ])('发布日%s:其他周期里不画竖线并提示;切回默认周期照常画', async (_name, day) => {
    stubChartAndBars({ ...SWITCHABLE, marker: { time: day, label: '视频发布' } }, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(attachedMarkers()).toHaveLength(1)
    expect(screen.queryByText('视频发布日不在此周期的数据范围内')).not.toBeInTheDocument()

    chartLib.attachPrimitive.mockClear()
    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(await screen.findByText('视频发布日不在此周期的数据范围内')).toBeInTheDocument()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(attachedMarkers()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '日' }))
    expect(attachedMarkers()).toHaveLength(1)
    expect(screen.queryByText('视频发布日不在此周期的数据范围内')).not.toBeInTheDocument()
  })
})

describe('MarketChart 时段与价位', () => {
  const BANDS = [
    { from: '2026-04-23', to: '2026-04-24', label: '八月行情', kind: 'past' },
    { from: '2026-04-25', to: '2026-05-30', label: '年底', kind: 'forecast' },
    { from: '2026-03-01', to: '2026-04-23', label: '更早的', kind: 'past' },
    { from: '2026-06-01', to: '2026-06-30', label: '数据之外', kind: 'past' },
  ]

  it('时段用 TimeBand 画:过去的取 accent、预测的取 warning,预测标签前加「预测 · 」,完全在数据范围外的跳过', async () => {
    document.documentElement.style.setProperty('--color-accent', '#0044ff')
    document.documentElement.style.setProperty('--color-warning', '#aa8800')
    stubChartFetch({ ...CHART, bands: BANDS })
    renderNote()
    await waitFor(() => expect(chartLib.attachPrimitive).toHaveBeenCalled())

    const bands = attachedBands()
    expect(attachedMarkers()).toHaveLength(1)
    expect(bands).toHaveLength(3)

    // 起点取 from 当天或之后的第一根,终点取 to 当天或之前的最后一根。
    const coordinates: Record<string, number> = { '2026-04-23': 50, '2026-04-24': 90, '2026-04-27': 150 }
    const read = (time: string | number) => coordinates[String(time)] ?? null
    const past = drawPrimitive(bands[0], read)
    expect(past.timeToCoordinate.mock.calls.map(([time]) => time)).toEqual(['2026-04-23', '2026-04-24'])
    expect(past.context.fillText).toHaveBeenCalledWith('八月行情', 49, 22)
    expect(past.context.fillStyle).toBe('#0044ff')

    const forecast = drawPrimitive(bands[1], read)
    expect(forecast.timeToCoordinate.mock.calls.map(([time]) => time)).toEqual(['2026-04-27', '2026-04-27'])
    expect(forecast.context.fillText).toHaveBeenCalledWith('预测 · 年底', 149, 38)
    expect(forecast.context.fillStyle).toBe('#aa8800')

    // 起点越界时贴到第一根。
    const clamped = drawPrimitive(bands[2], read)
    expect(clamped.timeToCoordinate.mock.calls.map(([time]) => time)).toEqual(['2026-04-23', '2026-04-23'])
  })

  it('画出来的时段按顺序各占一行标签(y=22、38、54);被跳过的时段不占行号', async () => {
    const three = [
      { from: '2026-04-23', to: '2026-04-27', label: '疫情之后', kind: 'past' },
      { from: '2026-04-23', to: '2026-04-24', label: '二零二零年', kind: 'past' },
      { from: '2026-04-24', to: '2026-04-27', label: '年底', kind: 'forecast' },
    ]
    const labels = () => attachedBands().map((band) => drawPrimitive(band, () => 100).context.fillText.mock.calls[0])

    stubChartFetch({ ...CHART, bands: three })
    const first = renderNote()
    await waitFor(() => expect(attachedBands()).toHaveLength(3))
    expect(labels()).toEqual([['疫情之后', 99, 22], ['二零二零年', 99, 38], ['预测 · 年底', 99, 54]])
    first.unmount()

    chartLib.attachPrimitive.mockClear()
    const outside = { from: '2026-06-01', to: '2026-06-30', label: '数据之外', kind: 'past' }
    stubChartFetch({ ...CHART, bands: [three[0], outside, three[2]] })
    renderNote()
    await waitFor(() => expect(attachedBands()).toHaveLength(2))
    expect(labels()).toEqual([['疫情之后', 99, 22], ['预测 · 年底', 99, 38]])
  })

  it('分钟级图的时段按当天 00:00 / 23:59:59 的秒数对齐', async () => {
    stubChartAndBars(
      { ...SWITCHABLE, bands: [{ from: '2026-10-26', to: '2026-10-26', label: '当天', kind: 'past' }] },
      { '1h': json(HOURLY) },
    )
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(attachedBands()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(attachedBands()).toHaveLength(1))
    const { timeToCoordinate } = drawPrimitive(attachedBands()[0], () => 100)
    expect(timeToCoordinate.mock.calls.map(([time]) => time)).toEqual([HOURLY.bars[0].time, HOURLY.bars[2].time])
  })

  it('drawable 的价位用虚线价位线画;有上沿的再画一条,上下沿的标题带「上沿」「下沿」', async () => {
    document.documentElement.style.setProperty('--color-accent', '#0044ff')
    stubChartFetch({
      ...CHART,
      levels: [
        { low: 4000, high: null, label: '4000 关口', drawable: true },
        { low: 3800, high: 4200, label: '箱体', drawable: true },
      ],
    })
    renderNote()
    await waitFor(() => expect(chartLib.createPriceLine).toHaveBeenCalledTimes(3))

    const dashed = { color: '#0044ff', lineWidth: 1, lineStyle: 2 }
    expect(chartLib.createPriceLine).toHaveBeenNthCalledWith(1, { price: 4000, title: '4000 关口', ...dashed })
    expect(chartLib.createPriceLine).toHaveBeenNthCalledWith(2, { price: 3800, title: '箱体 下沿', ...dashed })
    expect(chartLib.createPriceLine).toHaveBeenNthCalledWith(3, { price: 4200, title: '箱体 上沿', ...dashed })
    expect(screen.queryByText(/博主提到的价位/)).not.toBeInTheDocument()
  })

  it('drawable 为 false 的价位不画,在脚注里列出,多个用「；」分隔', async () => {
    stubChartFetch({
      ...CHART,
      levels: [{ low: 4000, high: null, label: '4000 关口', drawable: false }],
    })
    const first = renderNote()
    expect(await screen.findByText('博主提到的价位：4000 关口（单位与本图不同，未画出）')).toBeInTheDocument()
    expect(chartLib.createPriceLine).not.toHaveBeenCalled()
    first.unmount()

    stubChartFetch({
      ...CHART,
      levels: [
        { low: 4000, high: null, label: '4000 关口', drawable: false },
        { low: 50, high: 60, label: '50 美元', drawable: true },
        { low: 5000, high: null, label: '5000 关口', drawable: false },
      ],
    })
    renderNote()
    expect(await screen.findByText('博主提到的价位：4000 关口；5000 关口（单位与本图不同，未画出）')).toBeInTheDocument()
    expect(chartLib.createPriceLine).toHaveBeenCalledTimes(2)
  })

  it('切换周期后时段、价位线按新周期的 K 线在新图上重画', async () => {
    stubChartAndBars(
      {
        ...SWITCHABLE,
        bands: [{ from: '2026-04-23', to: '2026-04-27', label: '这一周', kind: 'past' }],
        levels: [{ low: 4000, high: null, label: '4000 关口', drawable: true }],
      },
      { week: json({ period: 'week', bars: [bar('2026-04-20'), bar('2026-04-27')], first: '2026-04-20', last: '2026-04-27' }) },
    )
    const user = userEvent.setup()
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(attachedBands()).toHaveLength(1)
    expect(chartLib.createPriceLine).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '周' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(attachedBands()).toHaveLength(2)
    expect(chartLib.createPriceLine).toHaveBeenCalledTimes(2)
    const { timeToCoordinate } = drawPrimitive(attachedBands()[1], () => 100)
    expect(timeToCoordinate.mock.calls.map(([time]) => time)).toEqual(['2026-04-27', '2026-04-27'])
  })

  it('时段两端之间没有 K 线时不画', async () => {
    stubChartFetch({ ...CHART, bands: [{ from: '2026-04-25', to: '2026-04-26', label: '周末', kind: 'past' }] })
    renderNote()
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(1))
    expect(attachedBands()).toHaveLength(0)
    expect(attachedMarkers()).toHaveLength(1)
  })
})

describe('MarketChart 图名跟着周期', () => {
  const WEEKLY = { ...SWITCHABLE, period: 'week' }
  const DAILY = { period: 'day', bars: [bar('2026-04-23'), bar('2026-04-24')], first: '2026-04-23', last: '2026-04-24' }
  const noteWithAlt = (alt: string) => `- 关键点\n  ![${alt}](charts/${NAME}.json)`

  it('切到别的周期,图名里的「周K」换成当前周期的叫法;切回默认周期恢复原图名', async () => {
    stubChartAndBars(WEEKLY, { '1h': json(HOURLY), day: json(DAILY) })
    const user = userEvent.setup()
    renderNote(noteWithAlt('贵州茅台 周K（视频发布前后）'))
    expect(await screen.findByText('贵州茅台 周K（视频发布前后）')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '1时' }))
    expect(await screen.findByText('贵州茅台 1小时K（视频发布前后）')).toBeInTheDocument()
    expect(screen.queryByText('贵州茅台 周K（视频发布前后）')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '日' }))
    expect(await screen.findByText('贵州茅台 日K（视频发布前后）')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '周' }))
    expect(screen.getByText('贵州茅台 周K（视频发布前后）')).toBeInTheDocument()
  })

  it('图名里没有日K / 周K / 月K 时,切换周期图名不变', async () => {
    stubChartAndBars(WEEKLY, { '1h': json(HOURLY) })
    const user = userEvent.setup()
    renderNote(noteWithAlt('贵州茅台 走势（视频发布前后）'))
    expect(await screen.findByText('贵州茅台 走势（视频发布前后）')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '1时' }))
    await waitFor(() => expect(chartLib.createChart).toHaveBeenCalledTimes(2))
    expect(screen.getByText('贵州茅台 走势（视频发布前后）')).toBeInTheDocument()
  })

  it.each([
    ['15m', '15分钟K'],
    ['1h', '1小时K'],
    ['4h', '4小时K'],
    ['day', '日K'],
    ['week', '周K'],
    ['month', '月K'],
  ])('titleForPeriod:%s 换成「%s」,只换第一个出现的', (period, name) => {
    expect(titleForPeriod('某某 日K 与 月K 对比', period)).toBe(`某某 ${name} 与 月K 对比`)
  })

  it('titleForPeriod:找不到日K / 周K / 月K 或周期未知时原样返回', () => {
    expect(titleForPeriod('某某 走势', '1h')).toBe('某某 走势')
    expect(titleForPeriod('某某 周K', 'quarter')).toBe('某某 周K')
  })
})
