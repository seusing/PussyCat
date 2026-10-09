// 解析任务、批次与串联从进行中落定时的系统通知:状态变化检测与文案是纯函数,
// 发送只在 Tauri 壳里、窗口不在前台时进行,其余一律安静跳过。
import type { VkJobRow, VkStorylineRow } from '../../host/vkClient'
import { STORYLINE_IN_PROGRESS, storylineStatusText } from './storyline'

const ACTIVE_JOB_STATUSES = new Set([
  'queued', 'running', 'cancel_requested', 'submitted', 'processing',
  'retry_requested', 'retrying', 'rerunning',
])
const FAILED_JOB_STATUS = /fail|error|quarantin/
const INTERRUPTED_JOB_STATUS = /cancel|interrupt/

export type JobOutcome = 'done' | 'partial' | 'failed'

export type JobSettlement = {
  /** 表格里这一行的 job_id;任务的通知开关按它记。 */
  jobId: string
  taskNumber?: number
  outcome: JobOutcome
  total: number
  succeeded: number
  failed: number
  interrupted: number
  /** 失败成员的 job_id,按批内顺序;通知里的失败原因取第 1 项。 */
  failedJobIds: string[]
}

export type DesktopNotice = { title: string; body: string }

const statusOf = (row: Pick<VkJobRow, 'status'>) => row.status.trim().toLowerCase()
const taskKey = (row: VkJobRow) => row.logicalTaskId ?? row.job_id

/** 按逻辑任务(批次折成一行后的行)记下当前状态,供下一次轮询比对。 */
export function snapshotJobStatuses(rows: readonly VkJobRow[]): Map<string, string> {
  return new Map(rows.map((row) => [taskKey(row), statusOf(row)]))
}

function settlementOf(row: VkJobRow): JobSettlement | null {
  const members = row.batchMembers ?? [row]
  const statuses = members.map(statusOf)
  const done = statuses.filter((status) => status === 'done').length
  const partial = statuses.filter((status) => status === 'partial').length
  const failedMembers = members.filter((member) => FAILED_JOB_STATUS.test(statusOf(member)))
  const interrupted = statuses.filter((status) => INTERRUPTED_JOB_STATUS.test(status)).length
  const succeeded = done + partial
  // 全是用户中断的不通知:那是用户自己的操作。
  if (succeeded === 0 && failedMembers.length === 0) return null
  const outcome: JobOutcome = succeeded === 0
    ? 'failed'
    : failedMembers.length + interrupted + partial === 0 ? 'done' : 'partial'
  return {
    jobId: row.job_id,
    taskNumber: row.taskNumber,
    outcome,
    total: members.length,
    succeeded,
    failed: failedMembers.length,
    interrupted,
    failedJobIds: failedMembers.map((member) => member.job_id),
  }
}

/**
 * 上一次快照里还在进行、这一次已经落定的逻辑任务。没有上一次快照(首次加载)或上一次
 * 就没见过这个任务时一律不算:只通知本次运行里亲眼看到的状态变化,不翻历史。
 */
export function detectJobSettlements(
  previous: ReadonlyMap<string, string> | null,
  rows: readonly VkJobRow[],
): JobSettlement[] {
  if (!previous) return []
  return rows.flatMap((row) => {
    const before = previous.get(taskKey(row))
    if (!before || !ACTIVE_JOB_STATUSES.has(before) || ACTIVE_JOB_STATUSES.has(statusOf(row))) return []
    const settlement = settlementOf(row)
    return settlement ? [settlement] : []
  })
}

const OUTCOME_TITLES: Record<JobOutcome, string> = {
  done: '解析完成',
  failed: '解析失败',
  partial: '部分完成',
}

/** 失败时 headline 是第 1 个失败项的人话原因(取不到就不写)。 */
export function jobSettlementNotice(settlement: JobSettlement, headline?: string): DesktopNotice {
  const label = settlement.taskNumber ? `任务 ${settlement.taskNumber}` : '视频解析任务'
  const reason = settlement.failed > 0 && headline ? headline : undefined
  if (settlement.total <= 1) {
    return { title: OUTCOME_TITLES[settlement.outcome], body: reason ? `${label}：${reason}` : label }
  }
  const counts = [
    settlement.succeeded > 0 && `${settlement.succeeded} 成功`,
    settlement.failed > 0 && `${settlement.failed} 失败`,
    settlement.interrupted > 0 && `${settlement.interrupted} 中断`,
  ].filter(Boolean).join('、')
  return {
    title: OUTCOME_TITLES[settlement.outcome],
    body: `${settlement.total} 个视频：${counts}${reason ? `（${reason}）` : ''}`,
  }
}

export function snapshotStorylineStatuses(rows: readonly VkStorylineRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.storyline_id, row.status]))
}

/** 上一次还在串联、这一次已经出结果(完成、部分完成或失败)的记录;「不足两个视频」的 skipped 不通知。 */
export function detectStorylineSettlements(
  previous: ReadonlyMap<string, string> | null,
  rows: readonly VkStorylineRow[],
): VkStorylineRow[] {
  if (!previous) return []
  return rows.filter((row) => {
    const before = previous.get(row.storyline_id)
    return !!before && STORYLINE_IN_PROGRESS.has(before)
      && (row.status === 'done' || row.status === 'partial' || row.status === 'failed')
  })
}

export function storylineNotice(row: VkStorylineRow, headline?: string): DesktopNotice {
  if (row.status === 'failed') return { title: '串联失败', body: headline ?? storylineStatusText(row) }
  return { title: '串联完成', body: storylineStatusText(row) }
}

/** 窗口不在前台(最小化、被遮住或没有焦点)。 */
export function appInBackground(): boolean {
  return document.hidden || !document.hasFocus()
}

// 项目里的 Tauri 判断:壳就绪后才会往页面注入 __OPENCLI_BOOT__(见 host/index.ts)。
const inTauriShell = () => !!window.__OPENCLI_BOOT__?.baseUrl

/** 发系统通知。浏览器开发模式、用户拒绝权限、插件出任何问题都安静跳过。 */
export async function notifyDesktop(notice: DesktopNotice): Promise<void> {
  if (!inTauriShell()) return
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
    const granted = await isPermissionGranted() || await requestPermission() === 'granted'
    if (granted) sendNotification(notice)
  } catch {
    // 通知是锦上添花,不影响任务本身。
  }
}
