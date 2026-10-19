// 多视频批次的成员归并与整批状态。详情页的「小任务n」、列表页的整批状态、应用内横幅
// 共用这一份,三处对「第几个小任务」「整批现在什么状态」的说法才不会各算各的。

export const ACTIVE_STATUSES = new Set([
  'queued', 'running', 'cancel_requested', 'submitted', 'processing',
  'retry_requested', 'retrying', 'rerunning',
])
export const FAILED_STATUSES = new Set(['failed', 'quarantined', 'error'])
export const INTERRUPTED_STATUSES = new Set(['cancelled', 'interrupted', 'completed_after_cancel_request'])
export const SUCCESS_STATUSES = new Set(['done', 'partial'])

const TERMINAL_JOB_STATUSES = new Set([
  'done', 'partial', 'failed', 'quarantined', 'error',
  'cancelled', 'interrupted', 'completed_after_cancel_request',
])

/** 一批里若还有没跑完的,整批算「正在执行」。都跑完了:全成功、全失败、全中断各算各的;
 * 结果混杂但至少有一条产出了结果(done/partial),整批算合成状态 `partial_success`,
 * 不能因为一条失败就把另外几条的成果一并说成失败。没有任何产出的混合(失败 + 中断)仍按失败。 */
export function aggregateBatchStatus(members: readonly { status: string }[]): string {
  const pending = members.find((row) => !TERMINAL_JOB_STATUSES.has(row.status.trim().toLowerCase()))
  if (pending) return pending.status
  const statusOf = (row: { status: string }) => row.status.trim().toLowerCase()
  const failed = members.find((row) => /fail|error|quarantin/.test(statusOf(row)))
  const interrupted = members.find((row) => /cancel|interrupt/.test(statusOf(row)))
  const done = members.some((row) => statusOf(row) === 'done')
  const partial = members.some((row) => statusOf(row) === 'partial')
  if ((done || partial) && (failed || interrupted || (done && partial))) return 'partial_success'
  return failed?.status ?? interrupted?.status ?? members[0].status
}

export type BatchState = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'interrupted'

export function batchState(status: string): BatchState {
  const value = status.trim().toLowerCase()
  if (value === 'queued') return 'queued'
  if (value === 'partial') return 'partial'
  if (SUCCESS_STATUSES.has(value)) return 'done'
  if (INTERRUPTED_STATUSES.has(value)) return 'interrupted'
  if (FAILED_STATUSES.has(value) || /fail|error|quarantin/.test(value)) return 'failed'
  return 'running'
}

/** 还没落定:排队等名额,或已经在跑。 */
export function memberInFlight(state: BatchState): boolean {
  return state === 'queued' || state === 'running'
}

export type BatchMember = {
  job_id: string
  source: string
  /** 最新一次尝试的原始状态,整批汇总按它算。 */
  status: string
  state: BatchState
  submitted_at: string
  finished_at: string | null
}

/** 批量成员的来源:一条 job 一个视频,取不到就退回 job_id。
 *
 * **列表接口把 source 放在行的顶层**,不在 `request` 里(那是单条详情的形状)。
 * 之前只读 `request.source`,于是永远取不到,六条小任务显示的全是 UUID —— 功能看着
 * 做完了、测试也绿,实际一次都没生效。两处都读,顺序按接口的真实形状来。 */
export function memberSource(row: { source?: string; request?: { source?: string } }): string {
  const source = row.source ?? row.request?.source
  return typeof source === 'string' ? source.split(/\r?\n/)[0].trim() : ''
}

type AttemptRow = {
  job_id: string; parent_job_id?: string | null; submitted_at: string
  finished_at?: string | null; status: string; source?: string
}

/** 同一个视频的多次尝试归成一组,组按首次提交排序。组的位置就是「小任务n」的 n。
 *
 * 重试在后端是一条新 job(parent_job_id 指回被重试的那条、batch_id 不变),这是对的
 * ——审计要看得见每一次尝试。但**界面上不该因此多出一行**:用户重跑的是「小任务2」,
 * 看到的就该还是小任务2,状态从「已中断」变成「进行中」,而不是列表尾巴上又冒出
 * 「小任务3」。真机上两个视频重跑一次就变成四条,谁也说不清哪条对哪条。
 */
function groupAttempts<Row extends AttemptRow>(rows: readonly Row[]): {
  attempts: Row[]; latest: Row; source: string
}[] {
  const byId = new Map(rows.map((row) => [row.job_id, row]))
  const rootOf = (row: Row): string => {
    let current = row
    const seen = new Set<string>()
    while (current.parent_job_id && !seen.has(current.job_id)) {
      seen.add(current.job_id)
      const parent = byId.get(current.parent_job_id)
      if (!parent) break
      current = parent
    }
    return current.job_id
  }
  // 归并键:**同一个视频**。优先用来源链接——那是"这一条小任务是哪个视频"的唯一
  // 事实,与后端怎么串联尝试无关。取不到来源(老数据)才退回重试链的根。
  //
  // 只按重试链归并是不够的:重跑一条已完成的曾经走的是"另开一条新任务"(带 batch、
  // 不带 parent),那条链认不出来,小任务列表于是一次比一次长。那条路已经改成 refresh
  // 了,但**显示不该依赖后端一定串对**——用户的要求是"提交时几条,永远显示几条"。
  const chains = new Map<string, Row[]>()
  for (const row of rows) {
    const key = memberSource(row) || rootOf(row)
    const chain = chains.get(key)
    if (chain) chain.push(row)
    else chains.set(key, [row])
  }
  return [...chains.values()]
    .map((attempts) => {
      const ordered = [...attempts].sort(
        (left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at),
      )
      const source = ordered.map(memberSource).find(Boolean) ?? ''
      return { attempts: ordered, latest: ordered[ordered.length - 1], source }
    })
    // 排序按**首次**提交,这样重跑不会把行的位置打乱——小任务2 永远是小任务2。
    .sort((left, right) => Date.parse(left.attempts[0].submitted_at) - Date.parse(right.attempts[0].submitted_at))
}

/** 把「同一个视频的多次尝试」折成一行。
 *
 * 折叠取**最新一次尝试**的状态与 job_id(点进去、重跑都该落在它身上),来源取链上
 * 任意一条能取到的——同一个视频,链接本来就一样。
 */
export function collapseAttempts(rows: readonly AttemptRow[]): BatchMember[] {
  return groupAttempts(rows).map(({ latest, source }) => ({
    job_id: latest.job_id,
    source,
    status: latest.status,
    state: batchState(latest.status),
    // 耗时按**最新那次尝试**算。从首次提交算起会把中间等着的时间也算进去,
    // 那不是这次跑用了多久。
    submitted_at: latest.submitted_at,
    finished_at: latest.finished_at ?? null,
  }))
}

/** job_id → 小任务编号(从 1 起)。同一个视频的每一次尝试都落在同一个编号上,
 * 顺序与 `collapseAttempts` 完全一致。传入的必须是同一批的成员行。 */
export function subtaskNumbers(rows: readonly AttemptRow[]): Map<string, number> {
  const numbers = new Map<string, number>()
  groupAttempts(rows).forEach(({ attempts }, index) => {
    for (const attempt of attempts) numbers.set(attempt.job_id, index + 1)
  })
  return numbers
}
