// 弹窗通道:顶栏标题右边到按钮组左边剩下的那段空间。够宽就把弹窗压在顶栏这一行,
// 否则退到顶栏下方。纯函数,量好的矩形进、位置出;测量和写样式变量在 AppShell 里。

export type Box = { left: number; right: number; top: number; bottom: number }

export type ToastLane = {
  placement: 'header' | 'below-header'
  /** 相对 .app-main 顶部。 */
  top: number
  /** 相对 .app-main 左右两侧的内缩。 */
  left: number
  right: number
}

/** 顶栏上标题与按钮之间的留白。 */
const LANE_GAP = 12
/** 通道至少这么宽才把弹窗放进顶栏这一行。 */
export const MIN_LANE_WIDTH = 320
const HEADER_TOP = 10
const BELOW_HEADER_GAP = 8
const BELOW_HEADER_INSET = 12

export function computeToastLane(main: Box, header: Box, title: Box, actions: Box): ToastLane {
  const left = title.right - main.left + LANE_GAP
  const right = main.right - actions.left + LANE_GAP
  const width = main.right - main.left - left - right
  // 顶栏窄到换行时按钮组掉到了标题下面,这时通道不在同一行上。
  const wrapped = actions.top >= title.bottom
  if (width >= MIN_LANE_WIDTH && !wrapped) return { placement: 'header', top: HEADER_TOP, left, right }
  return {
    placement: 'below-header',
    top: header.bottom - main.top + BELOW_HEADER_GAP,
    left: BELOW_HEADER_INSET,
    right: BELOW_HEADER_INSET,
  }
}
