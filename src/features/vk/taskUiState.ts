const VK_RERUN_JOBS_KEY = 'opencli-app:vk-rerun-jobs:v1'

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
