// 三栏布局宽度持久化——独立 localStorage key,与 preferences.ts(执行确认/收藏,受 I-P7 不落盘约束管辖)
// 完全分离:这里存的是纯 UI 尺寸偏好,不受那份契约管辖,也不应该混进那份契约。
import { AUTO_REFRESH_DEFAULT_MINUTES, clampIntervalMinutes } from './loginStatus'

export const LAYOUT_KEY = 'opencli-app:layout:v1'

export const NAV_MIN = 200
export const NAV_MAX = 480
export const NAV_DEFAULT = 280

export const RUNS_MIN = 280
export const RUNS_MAX = 560
export const RUNS_DEFAULT = 360

export const MODULE_SIDEBAR_MIN = 176
export const MODULE_SIDEBAR_MAX = 360
export const MODULE_SIDEBAR_DEFAULT = 224

export const DETAILS_MIN = 300
export const DETAILS_MAX = 560
export const DETAILS_DEFAULT = 380

// 中栏(命令详情)最小宽度——不持久化、不可独立拖拽,只作为左右两栏拖拽时的挤压下限。
export const CONFIG_MIN = 400

export type LayoutSnapshot = {
  navWidth: number
  runsWidth: number
  moduleSidebarWidth: number
  moduleSidebarHidden: boolean
  detailsWidth: number
  /** 登录状态的自动刷新开关与间隔。放这里而**不放 preferences**——那是执行确认的存储,受 I-P7 管辖。 */
  autoLoginRefresh: boolean
  autoLoginRefreshMinutes: number
  navHidden: boolean
  runsHidden: boolean
}

export function defaultLayout(): LayoutSnapshot {
  return {
    autoLoginRefresh: false,
    autoLoginRefreshMinutes: AUTO_REFRESH_DEFAULT_MINUTES,
    navWidth: NAV_DEFAULT,
    runsWidth: RUNS_DEFAULT,
    moduleSidebarWidth: MODULE_SIDEBAR_DEFAULT,
    moduleSidebarHidden: false,
    detailsWidth: DETAILS_DEFAULT,
    navHidden: false,
    runsHidden: false,
  }
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage
  try {
    // 浏览器封锁存储时,访问 localStorage 属性本身会抛 SecurityError(同 preferences.ts 的既有处理)
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isBool = (x: unknown): x is boolean => typeof x === 'boolean'

// 归一化一份"看起来像 LayoutSnapshot"的原始值。非法字段(负数/字符串/NaN/超界)一律夹回合法区间:
// 数值但越界→算术夹取;非数值(字符串/NaN/缺失)→退回该字段默认值(默认值本身在合法区间内,
// 因此结果不变量始终成立:输出的 navWidth 必在 [NAV_MIN,NAV_MAX]、runsWidth 必在 [RUNS_MIN,RUNS_MAX]。
// 导出供测试直接喂入真实 NaN(JSON 文本本身无法编码 NaN,只能在这一层直接验证)。
// navHidden/runsHidden 同一套"非法即回退默认值"策略:非布尔(缺失/字符串/数字等)→回退 false。
// 老数据(只有 navWidth/runsWidth 两个字段的 JSON)天然落入"缺失"分支,两个新字段取 false——
// 这正是折叠开关的向后兼容语义(见 loadLayout 端到端测试)。
export function normalizeLayout(raw: unknown): LayoutSnapshot {
  const fallback = defaultLayout()
  if (!raw || typeof raw !== 'object') return fallback
  const o = raw as Record<string, unknown>
  const navWidth = isFiniteNum(o.navWidth) ? clamp(o.navWidth, NAV_MIN, NAV_MAX) : fallback.navWidth
  const runsWidth = isFiniteNum(o.runsWidth) ? clamp(o.runsWidth, RUNS_MIN, RUNS_MAX) : fallback.runsWidth
  const moduleSidebarWidth = isFiniteNum(o.moduleSidebarWidth)
    ? clamp(o.moduleSidebarWidth, MODULE_SIDEBAR_MIN, MODULE_SIDEBAR_MAX)
    : fallback.moduleSidebarWidth
  const detailsWidth = isFiniteNum(o.detailsWidth)
    ? clamp(o.detailsWidth, DETAILS_MIN, DETAILS_MAX)
    : fallback.detailsWidth
  // 自动刷新配置同样按不可信边界处理:开关非布尔→回退 false(**默认关**,这是会反复动用
  // 登录态的功能,默认不能是开的);间隔走 clampIntervalMinutes,非法值退默认、越界夹回区间。
  const autoLoginRefresh = isBool(o.autoLoginRefresh) ? o.autoLoginRefresh : fallback.autoLoginRefresh
  const autoLoginRefreshMinutes = clampIntervalMinutes(o.autoLoginRefreshMinutes)
  const navHidden = isBool(o.navHidden) ? o.navHidden : fallback.navHidden
  const runsHidden = isBool(o.runsHidden) ? o.runsHidden : fallback.runsHidden
  const moduleSidebarHidden = isBool(o.moduleSidebarHidden) ? o.moduleSidebarHidden : fallback.moduleSidebarHidden
  return {
    navWidth,
    runsWidth,
    moduleSidebarWidth,
    moduleSidebarHidden,
    detailsWidth,
    navHidden,
    runsHidden,
    autoLoginRefresh,
    autoLoginRefreshMinutes,
  }
}

export function loadLayout(storage?: Storage): LayoutSnapshot {
  const s = resolveStorage(storage)
  if (!s) return defaultLayout()
  try {
    const raw = s.getItem(LAYOUT_KEY)
    if (!raw) return defaultLayout()
    return normalizeLayout(JSON.parse(raw))
  } catch {
    return defaultLayout()
  }
}

export function saveLayout(layout: LayoutSnapshot, storage?: Storage): boolean {
  const s = resolveStorage(storage)
  if (!s) return false
  try {
    s.setItem(LAYOUT_KEY, JSON.stringify(layout))
    return true
  } catch {
    return false   // 配额满 / 隐私模式:静默降级,内存态(当前会话)仍有效
  }
}

// 拖拽时把"提议宽度"夹到合法区间,并在已知容器宽度时额外防止把中栏挤到 CONFIG_MIN 以下。
// containerWidth 未知/不可用(如 jsdom 测试环境里 getBoundingClientRect 恒返回 0,或首次布局前)时,
// 退化为只受自身 min/max 约束——真实浏览器里再叠加 CSS `minmax(CONFIG_MIN, 1fr)` 兜底,双保险。
export function clampColumnWidth(proposed: number, min: number, max: number, otherFixedWidth: number, containerWidth: number): number {
  const roomAware = Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.min(max, containerWidth - otherFixedWidth - CONFIG_MIN)
    : max
  const effectiveMax = Math.max(min, roomAware)   // 防御:容器极端窄时至少保住自身下限,不产出 max<min 的坏区间
  return clamp(proposed, min, effectiveMax)
}
