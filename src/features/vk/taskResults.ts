import type { VkJobRow, VkJobView } from '../../host/vkClient'

const RESULT_STATUSES = new Set(['done', 'partial'])

export type VkResultVersion = {
  jobId: string
  attempt: number
  submittedAt: string
  status: string
  /** 已在任务详情中解析出的主结果;有它就不必再查一次任务详情。 */
  outputId?: string
  outputTitle?: string
}

type VkResultRow = VkJobRow & { outputs?: VkJobView['outputs'] }

export type VkTaskResultGroup = {
  id: string
  jobIds: string[]
  source: string
  ordinal: number
  taskNumber?: number
  versions: VkResultVersion[]
}

export function vkJobRowFromView(job: VkJobView): VkResultRow {
  return { ...job, source: job.request?.source }
}

/** Results belong to one submission. Retries stay with their original video. */
export function vkTaskResultGroups(rows: readonly VkResultRow[], jobId: string): VkTaskResultGroup[] {
  const byId = new Map(rows.map((row) => [row.job_id, row]))
  const selected = byId.get(jobId)
  if (!selected) return []

  const rootOf = (row: VkJobRow): VkJobRow => {
    let current = row
    const visited = new Set<string>()
    while (current.parent_job_id && !visited.has(current.job_id)) {
      visited.add(current.job_id)
      const parent = byId.get(current.parent_job_id)
      if (!parent) break
      current = parent
    }
    return current
  }
  const root = rootOf(selected)
  const batchId = root.batch_id ?? selected.batch_id
  const scope = [...byId.values()].filter((row) => {
    const ancestor = rootOf(row)
    return batchId
      ? (ancestor.batch_id ?? row.batch_id) === batchId
      : ancestor.job_id === root.job_id
  }).sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at))

  const members = new Map<string, VkJobRow[]>()
  for (const row of scope) {
    const ancestor = rootOf(row)
    const source = row.source?.trim() || ancestor.source?.trim() || ''
    const key = batchId && source ? source : ancestor.job_id
    const attempts = members.get(key) ?? []
    attempts.push(row)
    members.set(key, attempts)
  }

  return [...members.values()].map((attempts, index) => ({
    id: `job:${attempts[0].job_id}`,
    jobIds: attempts.map((row) => row.job_id),
    source: attempts.find((row) => row.source?.trim())?.source?.trim() ?? '',
    ordinal: index + 1,
    taskNumber: selected.taskNumber ?? attempts[0].taskNumber,
    versions: attempts.flatMap((row, attempt) => {
      if (!RESULT_STATUSES.has(row.status.trim().toLowerCase())) return []
      const output = vkPrimaryOutput(row)
      return [{
        jobId: row.job_id,
        attempt: attempt + 1,
        submittedAt: row.submitted_at,
        status: row.status,
        ...(output ? { outputId: output.id, outputTitle: output.title } : {}),
      }]
    }).reverse(),
  }))
}

export function vkResultVersionLabel(version: VkResultVersion, latest = false): string {
  const time = new Date(version.submittedAt).toLocaleString('zh-CN', { hour12: false })
  return `第 ${version.attempt} 次 · ${time}${latest ? ' · 最新结果' : ''}`
}

export function vkPrimaryOutput(job: Pick<VkJobView, 'outputs'>): { id: string; title: string } | null {
  if (job.outputs?.note_path) return { id: job.outputs.note_path, title: '知识笔记' }
  const product = job.outputs?.product_artifacts?.find((artifact) => artifact.markdown)
  if (product?.markdown) return { id: product.markdown, title: `${product.preset} MD` }
  if (job.outputs?.audit_path) return { id: job.outputs.audit_path, title: '证据审计' }
  return null
}
