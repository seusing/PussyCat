import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
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

const BAND_ALPHA = 0.14

/**
 * 两根 K 线之间整列高度的半透明色带,左上角写标签,画在 K 线下层。
 * 两端各外扩半根 K 线,只含一根 K 线的时段(月线上的一个月)也有宽度。
 * 两端任一取不到坐标(时间不在图里)就不画。
 */
export class TimeBand implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private span: { left: number; right: number } | null = null
  private readonly view: IPrimitivePaneView

  constructor(
    private readonly from: Time,
    private readonly to: Time,
    private readonly label: string,
    private readonly color: string,
    private readonly labelRow = 0,
  ) {
    this.view = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target) }) }
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart
    this.measure()
    requestUpdate()
  }

  detached() {
    this.chart = null
  }

  updateAllViews() {
    this.measure()
  }

  paneViews() {
    return [this.view]
  }

  private measure() {
    const scale = this.chart?.timeScale()
    const left = scale?.timeToCoordinate(this.from) ?? null
    const right = scale?.timeToCoordinate(this.to) ?? null
    if (!scale || left === null || right === null) {
      this.span = null
      return
    }
    const half = ((scale.logicalToCoordinate(1 as Logical) ?? 0) - (scale.logicalToCoordinate(0 as Logical) ?? 0)) / 2
    this.span = { left: left - half, right: right + half }
  }

  private draw(target: DrawTarget) {
    const span = this.span
    if (!span) return
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      // 左端滚出画面时标签贴着画面左缘,仍然看得到。
      const left = Math.max(span.left, 0)
      const width = span.right - left
      if (width <= 0) return
      context.save()
      context.fillStyle = this.color
      context.globalAlpha = BAND_ALPHA
      context.fillRect(left, 0, width, mediaSize.height)
      context.globalAlpha = 1
      context.font = '12px sans-serif'
      context.textAlign = 'left'
      context.textBaseline = 'top'
      // 比发布日竖线的标签低一行;同图的多条色带按 labelRow 再逐行下移,起点相同时标签不叠在一起。
      context.fillText(this.label, left + 4, 22 + this.labelRow * 16)
      context.restore()
    })
  }
}
