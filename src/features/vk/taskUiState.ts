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
