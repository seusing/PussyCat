import { VerticalMarker } from './chartMarker'

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
