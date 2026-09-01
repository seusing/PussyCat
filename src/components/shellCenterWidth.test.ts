import { describe, expect, it } from 'vitest'
import {
  CONFIG_MIN, DETAILS_MAX, DETAILS_MIN, MODULE_SIDEBAR_MAX, MODULE_SIDEBAR_MIN,
  SHELL_CENTER_MIN, clampColumnWidth,
} from '../data/layout'

/** AppShell 渲染时算的那两个"生效宽度",提出来直接验算术。 */
function effective(shellWidth: number, moduleSidebar: number, details: number) {
  const effectiveDetails = clampColumnWidth(
    details, DETAILS_MIN, DETAILS_MAX, moduleSidebar, shellWidth,
  )
  const effectiveModuleSidebar = clampColumnWidth(
    moduleSidebar, MODULE_SIDEBAR_MIN, MODULE_SIDEBAR_MAX, effectiveDetails, shellWidth,
  )
  return { effectiveDetails, effectiveModuleSidebar }
}

describe('窗口变窄时中栏不被挤没', () => {
  it('窗口缩小后两侧一起让位,中栏仍留得下', () => {
    // 用户的复现路径:先拖窄中栏,再从右上角等比缩小窗口 —— 夹取原先只在**拖拽**时
    // 发生,窗口自己变窄时没人重算,两侧仍按存下来的像素占位,中栏被压到 0,
    // 标题、图标、内容全叠在一起。双击调整条能恢复,正是因为那条路会重新夹取。
    const wide = effective(1600, MODULE_SIDEBAR_MAX, DETAILS_MAX)
    expect(1600 - wide.effectiveModuleSidebar - wide.effectiveDetails)
      .toBeGreaterThanOrEqual(CONFIG_MIN)

    const narrow = effective(1000, MODULE_SIDEBAR_MAX, DETAILS_MAX)
    expect(narrow.effectiveDetails).toBeLessThan(DETAILS_MAX)
    expect(1000 - narrow.effectiveModuleSidebar - narrow.effectiveDetails)
      .toBeGreaterThanOrEqual(CONFIG_MIN)
  })

  it('极窄窗口下两侧退到各自下限,不产出负宽度', () => {
    const tiny = effective(420, MODULE_SIDEBAR_MAX, DETAILS_MAX)
    expect(tiny.effectiveModuleSidebar).toBe(MODULE_SIDEBAR_MIN)
    expect(tiny.effectiveDetails).toBe(DETAILS_MIN)
  })

  it('拉回宽窗口时用户调好的宽度回得来 —— 夹取不写回存量', () => {
    // 这就是"渲染用夹取值、存量不动"的理由:把夹取结果写回 layout,窗口一缩再放大,
    // 用户自己拖好的宽度就永久没了。
    expect(effective(1600, MODULE_SIDEBAR_MAX, DETAILS_MAX).effectiveDetails).toBe(DETAILS_MAX)
  })

  it('中栏的 CSS 下限是个正数 —— minmax(0, 1fr) 等于允许压成零宽', () => {
    expect(SHELL_CENTER_MIN).toBeGreaterThan(0)
  })
})
