import type { PolicyDecision } from './policy'

// 登录状态校验 —— 纯数据层,不碰 React、不碰网络。
//
// **能检查哪些站点由 Host 判决决定,不由本文件决定。** 全目录有 65 条 whoami,当前只有 4 条
// 经过人工审定放行(browser-cookie-read-pilot);其余 61 条是 unknown,Host 一律 403。
// 所以这里不维护"支持的站点列表"——站点是否可检查,一律现场问判决表(I-P1:前端不复制准入规则)。

export type LoginCheckState =
  | 'unchecked'        // 还没查过
  | 'checking'         // 正在查
  | 'logged-in'        // whoami 返回 logged_in 为真
  | 'logged-out'       // whoami 返回 logged_in 为假
  | 'error'            // 命令执行失败(桥接没通、超时、解析失败……)
  | 'needs-ack'        // 命令需确认但用户还没确认过
  | 'not-approved'     // Host 判 denied/unknown —— 该站的 whoami 尚未审定

export type LoginCheckEntry = {
  site: string
  commandKey: string
  state: LoginCheckState
  /** 上次**完成**检查的时刻(不是发起时刻);从未查过为 undefined。 */
  checkedAt?: number
  /** 给用户看的一句话。失败时是原因,成功时是账号标识之类的补充信息。 */
  detail?: string
}

/** runId 前缀:登录检查的运行**不进运行面板**,靠这个前缀在全局 onDone 里分流。 */
export const LOGIN_CHECK_RUN_PREFIX = 'login-check:'

export function isLoginCheckRunId(runId: string): boolean {
  return runId.startsWith(LOGIN_CHECK_RUN_PREFIX)
}

export function loginCheckRunId(site: string, nonce: string): string {
  return `${LOGIN_CHECK_RUN_PREFIX}${site}:${nonce}`
}

/** 从 runId 反解站点。非登录检查的 runId 返回 undefined。 */
export function siteOfLoginCheckRunId(runId: string): string | undefined {
  if (!isLoginCheckRunId(runId)) return undefined
  const rest = runId.slice(LOGIN_CHECK_RUN_PREFIX.length)
  const at = rest.lastIndexOf(':')
  return at > 0 ? rest.slice(0, at) : undefined
}

/**
 * 由判决决定这条 whoami 当前处于什么可执行状态。
 * `acknowledged` 由调用方从 preferences 算好传入 —— 本函数不读存储。
 */
export function stateFromDecision(decision: PolicyDecision | undefined, acknowledged: boolean): LoginCheckState {
  if (!decision) return 'not-approved'
  if (decision.state === 'ready') return 'unchecked'
  if (decision.state === 'acknowledgement-required') return acknowledged ? 'unchecked' : 'needs-ack'
  return 'not-approved'   // denied / unknown
}

/**
 * 解析 whoami 的返回行。四条试点 whoami 的 columns 都含 `logged_in`(实测),
 * 但**不假设它一定是布尔**:适配器可能给字符串。只认明确的真/假,其余一律判 error——
 * 「拿不准」不能当成「已登录」,那会让用户以为会话还在。
 */
export function parseWhoamiResult(rows: Record<string, unknown>[] | undefined): {
  state: 'logged-in' | 'logged-out' | 'error'
  detail?: string
} {
  const row = rows?.[0]
  if (!row) return { state: 'error', detail: '命令没有返回任何数据' }
  const raw = row.logged_in
  const truthy = raw === true || raw === 'true' || raw === 1 || raw === '1'
  const falsy = raw === false || raw === 'false' || raw === 0 || raw === '0'
  if (!truthy && !falsy) return { state: 'error', detail: '返回体里没有可识别的登录状态字段' }
  if (!truthy) return { state: 'logged-out', detail: '需要重新登录' }
  // 账号标识:各站字段名不同(username / name / id),取第一个非空的字符串值作展示。
  // **不取全部字段**——那会把 whoami 的返回体整个摊到界面上。
  for (const key of ['username', 'name', 'id']) {
    const v = row[key]
    if (typeof v === 'string' && v.trim()) return { state: 'logged-in', detail: v.trim() }
    if (typeof v === 'number') return { state: 'logged-in', detail: String(v) }
  }
  return { state: 'logged-in' }
}

/** 自动刷新的合法区间(分钟)。下限 5 分钟:whoami 会真的开浏览器标签,更密只会打扰用户。 */
export const AUTO_REFRESH_MIN_MINUTES = 5
export const AUTO_REFRESH_MAX_MINUTES = 240
export const AUTO_REFRESH_DEFAULT_MINUTES = 30

export function clampIntervalMinutes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return AUTO_REFRESH_DEFAULT_MINUTES
  return Math.min(AUTO_REFRESH_MAX_MINUTES, Math.max(AUTO_REFRESH_MIN_MINUTES, Math.round(n)))
}
