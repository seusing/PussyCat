import { computeToastLane, MIN_LANE_WIDTH, type Box } from './toastLane'

const box = (left: number, right: number, top = 0, bottom = 62): Box => ({ left, right, top, bottom })

// 1280 宽窗口去掉 220 的应用侧栏:.app-main 从 229 到 1280;顶栏 62 高,标题和按钮都垂直居中。
const MAIN = box(229, 1280, 0, 900)
const HEADER = box(229, 1280, 0, 62)
const TITLE = box(331, 391, 21, 41)       // 左边是两个折叠按钮,标题在它们后面
const ACTIONS = box(1110, 1258, 14, 48)   // 铃铛、运行面板开关等

describe('computeToastLane', () => {
  it('uses the header row when the space between the title and the buttons is wide enough', () => {
    expect(computeToastLane(MAIN, HEADER, TITLE, ACTIONS)).toEqual({
      placement: 'header',
      top: 10,
      left: 391 - 229 + 12,
      right: 1280 - 1110 + 12,
    })
  })

  it('accepts a lane of exactly 320px and refuses one that is a pixel short', () => {
    // 通道宽 = 按钮组左边 - 标题右边 - 两侧各 12 的留白
    const actionsAt = (laneWidth: number) => box(TITLE.right + 24 + laneWidth, 1258, 14, 48)

    expect(computeToastLane(MAIN, HEADER, TITLE, actionsAt(MIN_LANE_WIDTH)).placement).toBe('header')
    expect(computeToastLane(MAIN, HEADER, TITLE, actionsAt(MIN_LANE_WIDTH - 1)).placement).toBe('below-header')
  })

  it('falls back below the header, 8px under its bottom edge, when the lane is too narrow', () => {
    // 例如视频解析的右侧栏开着、窗口又较窄:按钮组左边 590,标题右边 391 → 通道只剩 590-391-24 = 175
    const narrowMain = box(229, 760, 0, 900)
    const narrowHeader = box(229, 760, 0, 62)
    const narrowActions = box(590, 738, 14, 48)

    expect(computeToastLane(narrowMain, narrowHeader, TITLE, narrowActions)).toEqual({
      placement: 'below-header', top: 62 + 8, left: 12, right: 12,
    })
  })

  it('measures the fallback from the real header bottom and main top', () => {
    const main = box(0, 600, 40, 900)
    const header = box(0, 600, 40, 142)   // 换行后顶栏变高
    const title = box(100, 160, 60, 80)
    const actions = box(12, 588, 102, 136)

    expect(computeToastLane(main, header, title, actions)).toEqual({
      placement: 'below-header', top: 142 - 40 + 8, left: 12, right: 12,
    })
  })

  it('treats a wrapped header as below-header even if the numbers alone would leave a wide lane', () => {
    // 按钮组掉到标题下面一行(actions.top >= title.bottom):通道不在同一行上
    const title = box(331, 391, 14, 34)
    const actions = box(1110, 1258, 62, 96)
    const header = box(229, 1280, 0, 110)

    expect(computeToastLane(MAIN, header, title, actions)).toEqual({
      placement: 'below-header', top: 110 + 8, left: 12, right: 12,
    })
  })

  it('stays in the header row when the title and the buttons only touch vertically', () => {
    const title = box(331, 391, 21, 41)
    const actions = box(1110, 1258, 20, 54)

    expect(computeToastLane(MAIN, HEADER, title, actions).placement).toBe('header')
  })
})
