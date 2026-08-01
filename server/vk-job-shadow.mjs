// Node 侧的任务影子(阶段 2 契约 §7):**仅持久化**脱敏五元组 ——
// clientJobId / idempotencyKey / requestFingerprint / runId / displayStatus
// (+ updatedAt 记账时刻)。业务数据(URL、请求体、产物、成本明细)的真源在
// vk.db,Node 绝不复制。落盘采用 preferences.ts 的 I-P7 姿势:逐字段重建,
// 走私字段结构性丢弃而不是过滤。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SHADOW_FIELDS = [
  'clientJobId',
  'idempotencyKey',
  'requestFingerprint',
  'runId',
  'displayStatus',
  'updatedAt',
]

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null
}

// I-P7 姿势:白名单逐字段重建。原对象上有什么多余字段都流不进来。
function toCleanEntry(raw) {
  return {
    clientJobId: stringOrNull(raw?.clientJobId),
    idempotencyKey: stringOrNull(raw?.idempotencyKey),
    requestFingerprint: stringOrNull(raw?.requestFingerprint),
    runId: stringOrNull(raw?.runId),
    displayStatus: stringOrNull(raw?.displayStatus),
    updatedAt: stringOrNull(raw?.updatedAt),
  }
}

export function createVkJobShadow({
  stateFile,
  now = () => new Date().toISOString(),
  maxEntries = 200,
} = {}) {
  // 最新在前。vkJobId 是进程内关联键(vk 重启后作废),只在内存,不落盘。
  let entries = []

  function load() {
    if (!stateFile) return
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      const stored = Array.isArray(parsed?.entries) ? parsed.entries : []
      entries = stored.map((item) => ({ vkJobId: null, ...toCleanEntry(item) }))
    } catch {
      entries = [] // 坏文件按空处理:影子是可再生的展示态,不值得为它崩 Host
    }
  }

  function persist() {
    if (!stateFile) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const payload = JSON.stringify({ entries: list() }, null, 2)
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, stateFile)
    } catch {
      // 磁盘满/锁定不影响主流程;影子丢了可由 vk.db 历史视图重建展示。
    }
  }

  function trim() {
    if (entries.length > maxEntries) entries = entries.slice(0, maxEntries)
  }

  function list() {
    return entries.map((entry) => toCleanEntry(entry))
  }

  load()

  return {
    recordSubmit({ vkJobId, clientJobId, idempotencyKey } = {}) {
      entries.unshift({
        vkJobId: stringOrNull(vkJobId),
        ...toCleanEntry({
          clientJobId,
          idempotencyKey,
          displayStatus: 'submitted',
          updatedAt: now(),
        }),
      })
      trim()
      persist()
    },

    observeView(view) {
      const vkJobId = stringOrNull(view?.job_id)
      if (!vkJobId) return
      const entry = entries.find((item) => item.vkJobId === vkJobId)
      if (!entry) return // 只关联经本 Host 提交的任务
      entry.runId = stringOrNull(view?.run_id) ?? entry.runId
      entry.requestFingerprint = stringOrNull(view?.request_fingerprint) ?? entry.requestFingerprint
      entry.displayStatus = stringOrNull(view?.status) ?? entry.displayStatus
      entry.updatedAt = now()
      persist()
    },

    list,
  }
}
