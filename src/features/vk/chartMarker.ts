import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0]

export type VerticalMarkerColors = { line: string; text: string }

/**
 * 贯穿整个价格区的竖线,顶部带文字标签。lightweight-charts 没有内置竖线标记,
 * 官方做法是 series primitive:图拖动、缩放、改尺寸时库会回调 updateAllViews 重算位置。
 */
export class VerticalMarker implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private x: number | null = null
  private readonly view: IPrimitivePaneView

  constructor(
    private readonly time: Time,
    private readonly label: string,
    private readonly colors: VerticalMarkerColors,
  ) {
    this.view = { renderer: () => ({ draw: (target) => this.draw(target) }) }
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart
    this.x = chart.timeScale().timeToCoordinate(this.time)
    requestUpdate()
  }

  detached() {
    this.chart = null
  }

  updateAllViews() {
    this.x = this.chart?.timeScale().timeToCoordinate(this.time) ?? null
  }

  paneViews() {
    return [this.view]
  }

  private draw(target: DrawTarget) {
    const x = this.x
    if (x === null) return
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save()
      context.strokeStyle = this.colors.line
      context.lineWidth = 1
      context.setLineDash([4, 3])
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, mediaSize.height)
      context.stroke()
      context.setLineDash([])
      context.fillStyle = this.colors.text
      context.font = '12px sans-serif'
      context.textBaseline = 'top'
      // 竖线靠右边缘时标签放到线左侧,免得被裁掉。
      const flip = x + 8 + context.measureText(this.label).width > mediaSize.width
      context.textAlign = flip ? 'right' : 'left'
      context.fillText(this.label, flip ? x - 6 : x + 6, 6)
      context.restore()
    })
  }
}
