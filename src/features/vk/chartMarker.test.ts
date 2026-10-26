import { TimeBand, VerticalMarker } from './chartMarker'

const COLORS = { line: '#4f8cff', text: '#4f8cff' }
const SIZE = { width: 400, height: 260 }

function setup(coordinate: number | null) {
  const timeToCoordinate = vi.fn((_time: string): number | null => coordinate)
  const chart = { timeScale: () => ({ timeToCoordinate }) }
  const marker = new VerticalMarker('2026-04-24', '视频发布 2026-04-24', COLORS)
  marker.attached({ chart, requestUpdate: vi.fn() } as never)

  const context = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    setLineDash: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 80 })),
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
  }
  const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: SIZE }) }
  const draw = () => marker.paneViews()[0].renderer()!.draw(target as never)
  return { marker, context, draw, timeToCoordinate }
}

describe('VerticalMarker', () => {
  it('在发布日那根 K 线的位置画一条贯穿整个高度的竖线,标签放在线右侧', () => {
    const { context, draw, timeToCoordinate } = setup(100)
    draw()
    expect(timeToCoordinate).toHaveBeenCalledWith('2026-04-24')
    expect(context.moveTo).toHaveBeenCalledWith(100, 0)
    expect(context.lineTo).toHaveBeenCalledWith(100, SIZE.height)
    expect(context.strokeStyle).toBe(COLORS.line)
    expect(context.textAlign).toBe('left')
    expect(context.fillText).toHaveBeenCalledWith('视频发布 2026-04-24', 106, 6)
  })

  it('竖线靠近右边缘时标签翻到线左侧', () => {
    const { context, draw } = setup(380)
    draw()
    expect(context.textAlign).toBe('right')
    expect(context.fillText).toHaveBeenCalledWith('视频发布 2026-04-24', 374, 6)
  })

  it('图拖动后库回调 updateAllViews,竖线跟着新位置;时间不在图里就不画', () => {
    const { marker, context, draw, timeToCoordinate } = setup(100)
    timeToCoordinate.mockReturnValue(220)
    marker.updateAllViews()
    draw()
    expect(context.moveTo).toHaveBeenLastCalledWith(220, 0)

    context.moveTo.mockClear()
    context.fillText.mockClear()
    timeToCoordinate.mockReturnValue(null)
    marker.updateAllViews()
    draw()
    expect(context.moveTo).not.toHaveBeenCalled()
    expect(context.fillText).not.toHaveBeenCalled()
  })

  it('detached 之后不再读图', () => {
    const { marker, draw, context, timeToCoordinate } = setup(100)
    marker.detached()
    timeToCoordinate.mockClear()
    marker.updateAllViews()
    expect(timeToCoordinate).not.toHaveBeenCalled()
    context.moveTo.mockClear()
    draw()
    expect(context.moveTo).not.toHaveBeenCalled()
  })
})

// 色带:库按 timeToCoordinate 给两端的 x,logicalToCoordinate 量出一根 K 线的宽度(这里每根 10)。
function setupBand(coordinates: Record<string, number | null>, labelRow?: number) {
  const timeToCoordinate = vi.fn((time: string): number | null => coordinates[time] ?? null)
  const logicalToCoordinate = vi.fn((logical: number): number => logical * 10)
  const chart = { timeScale: () => ({ timeToCoordinate, logicalToCoordinate }) }
  const band = new TimeBand('2026-04-01', '2026-04-30', '八月行情', '#4f8cff', labelRow)
  band.attached({ chart, requestUpdate: vi.fn() } as never)

  const alpha = { fillRect: -1, fillText: -1 }
  const context = {
    save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    fillStyle: '', globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
  }
  context.fillRect.mockImplementation(() => { alpha.fillRect = context.globalAlpha })
  context.fillText.mockImplementation(() => { alpha.fillText = context.globalAlpha })
  const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: SIZE }) }
  const draw = () => band.paneViews()[0].renderer()!.draw(target as never)
  return { band, context, alpha, draw, timeToCoordinate }
}

describe('TimeBand', () => {
  it('在两端 K 线之间画整列高度的半透明矩形,两端各外扩半根 K 线,标签写在左上角,画在 K 线下层', () => {
    const { band, context, alpha, draw, timeToCoordinate } = setupBand({ '2026-04-01': 100, '2026-04-30': 300 })
    draw()
    expect(timeToCoordinate).toHaveBeenCalledWith('2026-04-01')
    expect(timeToCoordinate).toHaveBeenCalledWith('2026-04-30')
    expect(band.paneViews()[0].zOrder?.()).toBe('bottom')
    expect(context.fillRect).toHaveBeenCalledWith(95, 0, 210, SIZE.height)
    expect(context.fillStyle).toBe('#4f8cff')
    expect(alpha.fillRect).toBeCloseTo(0.14)
    expect(context.fillText).toHaveBeenCalledWith('八月行情', 99, 22)
    expect(alpha.fillText).toBe(1)
    expect(context.textAlign).toBe('left')
  })

  it.each([
    [undefined, 22],
    [0, 22],
    [1, 38],
    [2, 54],
  ])('labelRow 为 %s 时标签写在 y=%i,矩形不变', (labelRow, y) => {
    const { context, draw } = setupBand({ '2026-04-01': 100, '2026-04-30': 300 }, labelRow)
    draw()
    expect(context.fillText).toHaveBeenCalledWith('八月行情', 99, y)
    expect(context.fillRect).toHaveBeenCalledWith(95, 0, 210, SIZE.height)
  })

  it('只含一根 K 线的时段也有宽度', () => {
    const { context, draw } = setupBand({ '2026-04-01': 100, '2026-04-30': 100 })
    draw()
    expect(context.fillRect).toHaveBeenCalledWith(95, 0, 10, SIZE.height)
  })

  it('左端滚出画面时矩形和标签贴着画面左缘', () => {
    const { context, draw } = setupBand({ '2026-04-01': -80, '2026-04-30': 300 })
    draw()
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 305, SIZE.height)
    expect(context.fillText).toHaveBeenCalledWith('八月行情', 4, 22)
  })

  it('整段都在画面左侧时不画', () => {
    const { context, draw } = setupBand({ '2026-04-01': -300, '2026-04-30': -100 })
    draw()
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.fillText).not.toHaveBeenCalled()
  })

  it('任一端取不到坐标就不画;图拖动后库回调 updateAllViews,色带跟着新位置', () => {
    const coordinates: Record<string, number | null> = { '2026-04-01': null, '2026-04-30': 300 }
    const { band, context, draw } = setupBand(coordinates)
    draw()
    expect(context.fillRect).not.toHaveBeenCalled()

    coordinates['2026-04-01'] = 120
    band.updateAllViews()
    draw()
    expect(context.fillRect).toHaveBeenLastCalledWith(115, 0, 190, SIZE.height)

    coordinates['2026-04-30'] = null
    band.updateAllViews()
    context.fillRect.mockClear()
    draw()
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.fillText).toHaveBeenCalledTimes(1)
  })

  it('detached 之后不再读图', () => {
    const { band, context, draw, timeToCoordinate } = setupBand({ '2026-04-01': 100, '2026-04-30': 300 })
    band.detached()
    timeToCoordinate.mockClear()
    band.updateAllViews()
    expect(timeToCoordinate).not.toHaveBeenCalled()
    draw()
    expect(context.fillRect).not.toHaveBeenCalled()
  })
})
