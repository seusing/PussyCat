const VK_RERUN_JOBS_KEY = 'opencli-app:vk-rerun-jobs:v1'
// 任务编号由列表侧按提交先后分配，但详情页也要显示它，而两者没有共同的父组件持有这份
// 状态。这里存一份 job_id → 编号的索引：列表算完写进来，详情页直接查。
const VK_TASK_NUMBER_INDEX_KEY = 'opencli-app:vk-task-number-index:v1'

export const VK_OPEN_OUTPUT_EVENT = 'vk:open-output'

function loadRerunJobs(): Record<string, true> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VK_RERUN_JOBS_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === true)) as Record<string, true>
  } catch {
    return {}
  }
}

export function markVkJobAsRerun(jobId: string): void {
  try {
    localStorage.setItem(VK_RERUN_JOBS_KEY, JSON.stringify({ ...loadRerunJobs(), [jobId]: true }))
  } catch {
    // The task still runs when preferences cannot be persisted.
  }
}

export function isVkJobRerun(jobId: string): boolean {
  return loadRerunJobs()[jobId] === true
}

function loadTaskNumberIndex(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VK_TASK_NUMBER_INDEX_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'number'),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

export function rememberVkTaskNumbers(entries: Record<string, number>): void {
  try {
    localStorage.setItem(VK_TASK_NUMBER_INDEX_KEY, JSON.stringify({ ...loadTaskNumberIndex(), ...entries }))
  } catch {
    // 编号只是给人看的，存不下也不该拦住任务本身。
  }
}

export function vkTaskNumberFor(jobId: string | null): number | null {
  if (!jobId) return null
  return loadTaskNumberIndex()[jobId] ?? null
}

/** 批次维度的编号键。批量任务在列表里折成一行,详情页打开的却是批里的某个成员,
 *  只按 job_id 记索引必然查不到,标题就退回一串 UUID。 */
export function vkBatchNumberKey(batchId: string): string {
  return `batch:${batchId}`
}

export function vkTaskNumberForBatch(batchId: string | null): number | null {
  if (!batchId) return null
  return loadTaskNumberIndex()[vkBatchNumberKey(batchId)] ?? null
}

/** 「提交到结束」的墙钟。没结束就算到此刻。
 *
 * 从任务列表挪过来的:批量任务一行代表多个视频,列表上那个耗时是**整批**的墙钟
 * (第一条提交到最后一条结束),很容易被读成"每条要跑这么久"。现在只在详情页按
 * 单条显示。 */
export function vkElapsedLabel(submittedAt: string, finishedAt?: string | null): string {
  const start = Date.parse(submittedAt)
  if (Number.isNaN(start)) return '—'
  const finish = finishedAt ? Date.parse(finishedAt) : Date.now()
  if (Number.isNaN(finish)) return '—'
  const seconds = Math.max(0, Math.round((finish - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}
