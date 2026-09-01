import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronUp, Eye, RefreshCw, Send, Square, X } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  fetchVkJob,
  fetchVkJobs,
  fetchVkProviderSettings,
  postVkJob,
  postVkJobAction,
} from '../../host/vkClient'
import type { VkJobView, VkProviderSettings } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import {
  isVkJobRerun, markVkJobAsRerun, vkTaskNumberFor, vkTaskNumberForBatch, VK_OPEN_OUTPUT_EVENT,
} from './taskUiState'
import './VkTaskDetailSidebar.css'

const ACTIVE_STATUSES = new Set([
  'queued', 'running', 'cancel_requested', 'submitted', 'processing',
  'retry_requested', 'retrying', 'rerunning',
])
const FAILED_STATUSES = new Set(['failed', 'quarantined', 'error'])
const INTERRUPTED_STATUSES = new Set(['cancelled', 'interrupted', 'completed_after_cancel_request'])
const SUCCESS_STATUSES = new Set(['done', 'partial'])
const VK_JOB_DETAIL_TERMINAL_EVENT = 'vk:job-detail-terminal'
const VK_JOB_TERMINAL_EVENT = 'vk:job-terminal'
const VK_JOB_RETRY_SUBMITTED_EVENT = 'vk:job-retry-submitted'

function detailError(error: unknown): string {
  if (error instanceof HostRequestError) return error.summary
  if (error instanceof Error) return error.message
  return '任务详情获取失败'
}

function secondsLabel(value: number | null): string {
  if (value === null) return '进行中'
  if (value < 1) return `${Math.round(value * 1000)} ms`
  return `${value.toFixed(2)} 秒`
}

type BatchState = 'running' | 'done' | 'failed' | 'interrupted'

const BATCH_STATE_LABELS: Record<BatchState, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
}

function batchState(status: string): BatchState {
  const value = status.trim().toLowerCase()
  if (SUCCESS_STATUSES.has(value)) return 'done'
  if (INTERRUPTED_STATUSES.has(value)) return 'interrupted'
  if (FAILED_STATUSES.has(value) || /fail|error|quarantin/.test(value)) return 'failed'
  return 'running'
}

/** 批量成员的来源:一条 job 一个视频,取不到就退回 job_id。
 *
 * **列表接口把 source 放在行的顶层**,不在 `request` 里(那是单条详情的形状)。
 * 之前只读 `request.source`,于是永远取不到,六条小任务显示的全是 UUID —— 功能看着
 * 做完了、测试也绿,实际一次都没生效。两处都读,顺序按接口的真实形状来。 */
function memberSource(row: { source?: string; request?: { source?: string } }): string {
  const source = row.source ?? row.request?.source
  return typeof source === 'string' ? source.split(/\r?\n/)[0].trim() : ''
}

/** 把「同一个视频的多次尝试」折成一行。
 *
 * 重试在后端是一条新 job(parent_job_id 指回被重试的那条、batch_id 不变),这是对的
 * ——审计要看得见每一次尝试。但**界面上不该因此多出一行**:用户重跑的是「小任务2」,
 * 看到的就该还是小任务2,状态从「已中断」变成「进行中」,而不是列表尾巴上又冒出
 * 「小任务3」。真机上两个视频重跑一次就变成四条,谁也说不清哪条对哪条。
 *
 * 折叠取**最新一次尝试**的状态与 job_id(点进去、重跑都该落在它身上),来源取链上
 * 任意一条能取到的——同一个视频,链接本来就一样。
 */
function collapseAttempts(
  rows: readonly { job_id: string; parent_job_id?: string | null; submitted_at: string; status: string; source?: string }[],
): { job_id: string; source: string; state: BatchState }[] {
  const byId = new Map(rows.map((row) => [row.job_id, row]))
  const rootOf = (row: typeof rows[number]): string => {
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
  const chains = new Map<string, typeof rows[number][]>()
  for (const row of rows) {
    const root = rootOf(row)
    const chain = chains.get(root)
    if (chain) chain.push(row)
    else chains.set(root, [row])
  }
  return [...chains.entries()]
    .map(([root, attempts]) => {
      const ordered = [...attempts].sort(
        (left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at),
      )
      const latest = ordered[ordered.length - 1]
      const source = ordered.map(memberSource).find(Boolean) ?? ''
      return { root, first: ordered[0], latest, source }
    })
    // 排序按**首次**提交,这样重跑不会把行的位置打乱——小任务2 永远是小任务2。
    .sort((left, right) => Date.parse(left.first.submitted_at) - Date.parse(right.first.submitted_at))
    .map(({ latest, source }) => ({
      job_id: latest.job_id,
      source,
      state: batchState(latest.status),
    }))
}

function sourceItems(job: VkJobView | null): string[] {
  const source = job?.request?.source
  if (typeof source !== 'string') return []
  return [...new Set(source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
}

function primaryOutput(job: VkJobView): { id: string; label: string } | null {
  if (job.outputs?.note_path) return { id: job.outputs.note_path, label: '查看解析结果' }
  const artifact = job.outputs?.product_artifacts?.find((item) => item.markdown)
  return artifact?.markdown ? { id: artifact.markdown, label: '查看解析结果' } : null
}

type TaskPhase = Readonly<{ label: string; stages: readonly string[] }>

const QUICK_SUMMARY_PHASES: readonly TaskPhase[] = [
  { label: '获取视频内容', stages: ['acquire', 'normalize'] },
  { label: '理解视频重点', stages: ['chapter'] },
  { label: '整理知识笔记', stages: ['note'] },
  { label: '生成解析结果', stages: ['product'] },
]

const FULL_ANALYSIS_PHASES: readonly TaskPhase[] = [
  { label: '获取视频内容', stages: ['acquire', 'normalize'] },
  { label: '理解视频结构', stages: ['chapter'] },
  { label: '核对关键信息', stages: ['claim', 'qc'] },
  { label: '整理知识笔记', stages: ['note'] },
  { label: '生成解析结果', stages: ['product'] },
]

const STAGE_LABELS: Record<string, string> = {
  acquire: '采集与转写',
  normalize: '整理字幕',
  chapter: '理解视频',
  claim: '提取关键信息',
  qc: '核对关键信息',
  note: '整理知识笔记',
  product: '生成解析结果',
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

function stageProgress(job: VkJobView, successful: boolean): {
  completed: number
  total: number
  percent: number
  currentLabel: string
} {
  const rawCompleted = Array.isArray(job.progress?.completed_stages) ? job.progress.completed_stages : []
  const completedStages = new Set(rawCompleted.filter((stage): stage is string => typeof stage === 'string'))
  const observedStages = new Set(completedStages)
  const currentStage = typeof job.progress?.current_stage === 'string' ? job.progress.current_stage : undefined
  if (currentStage) observedStages.add(currentStage)
  for (const metric of job.progress?.stage_metrics ?? []) observedStages.add(metric.stage)
  for (const attempt of job.progress?.model_attempts ?? []) observedStages.add(attempt.stage)
  const sawFullAnalysis = observedStages.has('claim') || observedStages.has('qc')
  const quickRequested = job.auto_route?.processing_depth === 'quick' || job.request?.preset === 'quick-summary'
  const phases = !sawFullAnalysis && quickRequested ? QUICK_SUMMARY_PHASES : FULL_ANALYSIS_PHASES
  let completed = 0
  if (successful) completed = phases.length
  else {
    for (const phase of phases) {
      if (!phase.stages.every((stage) => completedStages.has(stage))) break
      completed += 1
    }
  }
  const latestAttemptStage = job.progress?.model_attempts?.at(-1)?.stage
  const activeStage = currentStage ?? latestAttemptStage
  const activePhaseIndex = activeStage
    ? phases.findIndex((phase) => phase.stages.includes(activeStage))
    : -1
  if (!successful && activePhaseIndex >= 0) completed = Math.max(completed, activePhaseIndex)
  const current = phases[activePhaseIndex >= 0 ? activePhaseIndex : Math.min(completed, phases.length - 1)]
  return {
    completed,
    total: phases.length,
    percent: Math.round((completed / phases.length) * 100),
    currentLabel: successful ? '解析完成' : current.label,
  }
}

function configuredModelName(job: VkJobView, settings: VkProviderSettings | null): string {
  const actualRoutes = [...new Set(
    (job.progress?.model_attempts ?? []).map((attempt) => attempt.provider_route),
  )]
  if (actualRoutes.length > 0) {
    return actualRoutes.map((route) => modelAttemptName(route, settings)).join(' → ')
  }
  const profile = typeof job.request?.provider_profile === 'string' ? job.request.provider_profile : ''
  const direct = settings?.channels.find((channel) => channel.id === profile)
  if (direct) return direct.name

  const assignedChannelId = settings
    ? Object.values(settings.roles).find((channelId): channelId is string => typeof channelId === 'string' && !!channelId)
    : null
  const assigned = assignedChannelId
    ? settings?.channels.find((channel) => channel.id === assignedChannelId)
    : null
  if (assigned) return assigned.name
  if (profile && profile !== 'default') return profile
  return '跟随默认模型配置'
}

const MODEL_ATTEMPT_STATUS: Record<string, string> = {
  ok: '成功',
  transient_error: '临时故障',
  permanent_error: '配置或请求错误',
  schema_error: '响应格式错误',
  abandoned: '已停止等待',
}

function transportLabel(mode: string | undefined): string {
  if (mode === 'sse') return '流式'
  if (mode === 'sync_fallback') return '同步回退'
  return '同步'
}

function telemetryMs(label: string, value: number | null | undefined): string {
  return value == null ? `${label}不可测` : `${label} ${Math.max(0, value)} ms`
}

function modelAttemptName(route: string, settings: VkProviderSettings | null): string {
  const channelId = route.split(':', 1)[0]
  return settings?.channels.find((channel) => channel.id === channelId)?.name ?? route
}

export function VkTaskDetailSidebar({ jobId, baseUrl, onClose, onJobChange }: {
  jobId: string | null
  baseUrl?: string
  onClose: () => void
  onJobChange?: (jobId: string) => void
}) {
  const [job, setJob] = useState<VkJobView | null>(null)
  const [providers, setProviders] = useState<VkProviderSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<'cancel' | 'retry' | 'resubmit' | 'batch' | null>(null)
  const [submitHovered, setSubmitHovered] = useState(false)
  const [batchMembers, setBatchMembers] = useState<
    { job_id: string; source: string; state: BatchState }[]
  >([])
  // 编号先按 job_id 查;查不到再按批次查 —— 列表把一批折成一行、只记得住那一行的
  // job_id,而详情页打开的往往是批里的某个成员,直查必然落空,标题就退回一串 UUID。
  const taskNumber = useMemo(
    () => vkTaskNumberFor(jobId) ?? vkTaskNumberForBatch(job?.batch_id ?? null),
    [jobId, job?.batch_id],
  )
  const batchDoneCount = batchMembers.filter((member) => member.state !== 'running').length
  const currentSource = batchMembers.find((member) => member.job_id === jobId)?.source
    ?? sourceItems(job)[0]
    ?? ''
  // 还在跑的不参与重跑:它本来就在跑,再点一次只会白花一次额度。
  const rerunable = useMemo(
    () => batchMembers.filter((member) => member.state !== 'running'),
    [batchMembers],
  )
  const failedIds = useMemo(
    () => rerunable.filter((member) => member.state === 'failed').map((member) => member.job_id),
    [rerunable],
  )
  // 悬停展开,但**不只靠悬停**:纯 hover 菜单键盘用不了,鼠标移向菜单项的途中也容易掠出
  // 容器把菜单收掉(实测就是这么翻的)。点箭头可以「钉住」,钉住后移开不收。
  const [rerunMenuOpen, setRerunMenuOpen] = useState(false)
  const [rerunMenuPinned, setRerunMenuPinned] = useState(false)
  const rerunMenuRef = useRef<HTMLDivElement | null>(null)
  const [rerunPicked, setRerunPicked] = useState<Set<string> | null>(null)
  // 钉住之后点别处要能收起来。原先只有再点一次箭头才收,菜单于是一直挂在那儿挡着下面
  // 的内容 —— 用户的原话是「点击菜单以外的地方时不会自动收回」。Esc 一并收。
  useEffect(() => {
    if (!rerunMenuOpen) return undefined
    const dismiss = (event: Event) => {
      const node = rerunMenuRef.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      setRerunMenuOpen(false)
      setRerunMenuPinned(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(event) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [rerunMenuOpen])
  // 默认只选失败的——那是绝大多数情况下想重跑的。全失败时它就等于「全部重跑」;
  // 一条没失败时退回全选,否则按钮会是个点不动的空壳。
  const selection = useMemo(() => {
    if (rerunPicked) return rerunPicked
    if (failedIds.length > 0) return new Set(failedIds)
    return new Set(rerunable.map((member) => member.job_id))
  }, [rerunPicked, failedIds, rerunable])
  const selectedCount = rerunable.filter((member) => selection.has(member.job_id)).length
  const selectedLabel = useMemo(() => {
    const picked = rerunable
      .map((member, index) => ({ member, ordinal: batchMembers.indexOf(member) + 1, index }))
      .filter((entry) => selection.has(entry.member.job_id))
    if (picked.length === 0) return '未选中任何小任务'
    if (picked.length === rerunable.length) return `重跑全部 ${picked.length} 个`
    if (picked.length === 1) return `重跑小任务${picked[0].ordinal}`
    return `重跑选中 ${picked.length} 个`
  }, [rerunable, batchMembers, selection])
  const loadGeneration = useRef(0)
  const previousJobStatus = useRef<string | null>(null)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    if (!jobId) {
      setJob(null)
      setError(null)
      return
    }
    try {
      const [nextJob, nextProviders] = await Promise.all([
        fetchVkJob(jobId, baseUrl),
        fetchVkProviderSettings(baseUrl).catch(() => null),
      ])
      if (generation !== loadGeneration.current) return
      setJob(nextJob)
      setProviders(nextProviders)
      setError(null)
      // 同批的兄弟任务不在这条详情里,得从任务列表按 batch_id 捞。取不到就当单条处理——
      // 批量视图是锦上添花,不该因为列表接口抖一下就把整个详情页拖垮。
      if (nextJob.batch_id) {
        const siblings = await fetchVkJobs(baseUrl).catch(() => [])
        if (generation !== loadGeneration.current) return
        setBatchMembers(collapseAttempts(
          siblings.filter((row) => row.batch_id === nextJob.batch_id),
        ))
      } else {
        setBatchMembers([])
      }
      const previous = previousJobStatus.current
      previousJobStatus.current = nextJob.status
      if (previous && ACTIVE_STATUSES.has(previous) && !ACTIVE_STATUSES.has(nextJob.status)) {
        window.dispatchEvent(new CustomEvent(VK_JOB_DETAIL_TERMINAL_EVENT, {
          detail: { jobId: nextJob.job_id },
        }))
      }
    } catch (loadError) {
      if (generation !== loadGeneration.current) return
      setError(detailError(loadError))
    }
  }, [jobId, baseUrl])

  useEffect(() => {
    previousJobStatus.current = null
    void load()
  }, [load])
  useEffect(() => {
    if (!jobId) return
    const syncTerminalDetail = (event: Event) => {
      const terminalJobId = (event as CustomEvent<{ jobId?: string }>).detail?.jobId
      if (terminalJobId === jobId) void load()
    }
    window.addEventListener(VK_JOB_TERMINAL_EVENT, syncTerminalDetail)
    return () => window.removeEventListener(VK_JOB_TERMINAL_EVENT, syncTerminalDetail)
  }, [jobId, load])
  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return
    const timer = window.setInterval(load, 1500)
    return () => window.clearInterval(timer)
  }, [job, load])

  const sources = useMemo(() => sourceItems(job), [job])
  const active = !!job && ACTIVE_STATUSES.has(job.status)
  const interrupted = !!job && INTERRUPTED_STATUSES.has(job.status)
  const completedSuccessfully = !!job && SUCCESS_STATUSES.has(job.status)
  const failed = !!job && (FAILED_STATUSES.has(job.status) || (!active && !interrupted && !completedSuccessfully))
  const stopping = job?.status === 'cancel_requested'
  const rerunning = active && !!job && (!!job.parent_job_id || isVkJobRerun(job.job_id))
  const progress = job
    ? stageProgress(job, completedSuccessfully)
    : { completed: 0, total: 4, percent: 0, currentLabel: '准备处理' }

  const runAction = async (action: 'cancel' | 'retry' | 'resubmit') => {
    if (!jobId || !job) return
    setActionPending(action)
    setError(null)
    try {
      if (action === 'cancel') {
        await postVkJobAction(jobId, 'cancel', baseUrl)
        await load()
        return
      }
      if (action === 'retry') {
        const result = await postVkJobAction(jobId, 'retry', baseUrl)
        const nextJobId = typeof result.job_id === 'string' ? result.job_id : null
        if (nextJobId) {
          markVkJobAsRerun(nextJobId)
          window.dispatchEvent(new CustomEvent(VK_JOB_RETRY_SUBMITTED_EVENT, {
            detail: { jobId: nextJobId },
          }))
          onJobChange?.(nextJobId)
        }
        else await load()
        return
      }
      const request = job.request
      if (!request?.source) throw new Error('该历史任务没有可再次提交的来源信息')
      const result = await postVkJob({
        request,
        idempotency_key: crypto.randomUUID(),
        client_job_id: crypto.randomUUID(),
        ...(job.batch_id ? { batch_id: job.batch_id } : {}),
      }, baseUrl)
      markVkJobAsRerun(result.job_id)
      onJobChange?.(result.job_id)
    } catch (actionError) {
      setError(detailError(actionError))
    } finally {
      setActionPending(null)
    }
  }

  /** 整批重跑:失败的走 retry(沿用原请求),已完成的重新提交一次。
   *
   * 已完成的批量重跑会再花一次额度——这是明知的取舍:整批失败时也需要一键重来,
   * 而"只重跑失败的那几条"覆盖不了那个场景。按钮上把条数写出来,别让人误点。 */
  /** 重跑选中的那些小任务。空选等于不做事,由调用方保证非空。 */
  const rerunSelected = async (selection: ReadonlySet<string>) => {
    if (selection.size === 0) return
    setRerunMenuOpen(false)
    setRerunMenuPinned(false)
    setActionPending('batch')
    setError(null)
    const failures: string[] = []
    let firstNewJobId: string | null = null
    for (const member of batchMembers) {
      if (!selection.has(member.job_id)) continue
      if (member.state === 'running') continue    // 还在跑的没什么可重跑的
      try {
        const detail = await fetchVkJob(member.job_id, baseUrl)
        const result = member.state === 'done'
          ? await postVkJob({
            request: detail.request as Record<string, unknown>,
            idempotency_key: crypto.randomUUID(),
            client_job_id: crypto.randomUUID(),
            ...(detail.batch_id ? { batch_id: detail.batch_id } : {}),
          }, baseUrl)
          : await postVkJobAction(member.job_id, 'retry', baseUrl)
        const newId = typeof result.job_id === 'string' ? result.job_id : null
        if (newId) {
          markVkJobAsRerun(newId)
          firstNewJobId ??= newId
        }
      } catch (memberError) {
        failures.push(`${member.source || member.job_id}：${detailError(memberError)}`)
      }
    }
    setActionPending(null)
    // 部分失败要说清是哪几条,否则用户只知道"没全跑起来"却不知道差在哪。
    if (failures.length > 0) setError(`部分视频未能重跑\n${failures.join('\n')}`)
    if (firstNewJobId) onJobChange?.(firstNewJobId)
    else await load()
  }

  if (!jobId) {
    return (
      <div className="vk-task-detail-empty" data-testid="vk-task-detail-empty">
        <span>选择一条任务查看执行详情</span>
      </div>
    )
  }

  return (
    <section className="vk-task-detail-sidebar" data-testid="vk-task-detail-sidebar" aria-label="任务执行详情">
      <header>
        <div>
          <span>任务详情</span>
          {/* 标题只给编号。链接在下面的「提交内容」里逐条列着,标题再放一条只是重复;
              一批多个视频时它还只能显示其中一条,反而误导。UUID 退到 title 属性里
              ——排查问题时日志里只有它,鼠标悬停仍拿得到。 */}
          {taskNumber === null
            ? <strong title={job?.job_id ?? jobId ?? undefined}>{currentSource || job?.job_id || jobId}</strong>
            : (
              <strong data-testid="vk-task-detail-number" title={job?.job_id ?? jobId ?? undefined}>
                任务 {taskNumber}
              </strong>
            )}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭任务详情" title="关闭">
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      {error && <div className="vk-task-detail-error" role="alert">{error}</div>}
      {!job && !error && <div className="vk-task-detail-loading">正在读取任务详情…</div>}

      {job && (
        <div className="vk-task-detail-body">
          <div className="vk-task-detail-summary">
            <span role="status" aria-live="polite" className={`vk-task-detail-badge ${failed ? 'is-failed' : interrupted ? 'is-interrupted' : rerunning ? 'is-rerunning' : active ? 'is-running' : 'is-completed'}`}>
              {failed ? '失败' : interrupted ? '已中断' : stopping ? '正在停止' : rerunning ? '重跑中' : active ? '正在执行' : '已完成'}
            </span>
            <button type="button" onClick={() => { void load() }} aria-label="刷新任务详情" title="刷新">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>

          {active && (
            <div className="vk-task-progress-visual" aria-label="任务正在执行">
              <ThinkingOrb
                state={rerunning ? 'solving' : 'composing'}
                size={64}
                speed={rerunning ? 0.9 : 1.5}
                theme="dark"
                aria-label={rerunning ? '任务重跑中' : '任务处理中'}
              />
              <div className="vk-task-progress-copy">
                <strong>阶段 {Math.min(progress.completed + 1, progress.total)} / {progress.total}</strong>
                <span>{progress.currentLabel}</span>
              </div>
            </div>
          )}

          <div className="vk-task-progress-meta">
            <span>处理进度</span>
            <strong>{progress.percent}%</strong>
          </div>
          <div
            className="vk-task-progress-track"
            role="progressbar"
            aria-label="处理阶段进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>

          {/* 提交内容排在最前:打开详情第一个想确认的是"这条跑的是哪个视频"。
              一次提交多个视频时,这里要逐个列出各自的状态,而不是只显示被点开的那一条。 */}
          <div className="vk-task-detail-section" data-testid="vk-task-detail-sources">
            <h3>
              提交内容
              {batchMembers.length > 1 && (
                <span className="vk-task-detail-batch-count">
                  {/* 不写"当前查看第 N 个":批量是并行跑的,那句话会让人以为在排队等前一条。
                      当前看的是哪条,由下面列表里高亮的那一项表达,不必用序数再说一遍。 */}
                  {' '}共 {batchMembers.length} 个视频 · 已完成 {batchDoneCount}/{batchMembers.length}
                </span>
              )}
            </h3>
            {batchMembers.length > 1
              ? (
                <ol className="vk-task-detail-batch-list">
                  {batchMembers.map((member, index) => (
                    <li key={member.job_id}>
                      <button
                        type="button"
                        data-current={member.job_id === jobId || undefined}
                        onClick={() => onJobChange?.(member.job_id)}
                        title={member.job_id}
                      >
                        {/* 「小任务N：链接」。原先只给 source,取不到就退回一串 UUID——而列表
                            接口此前根本不返回 source,于是实际显示的全是 UUID,谁也认不出哪条是
                            哪条。序号是为了让下面的重跑菜单能用同一个称呼指代它们。 */}
                        <span className="vk-task-detail-batch-source">
                          <b>小任务{index + 1}：</b>{member.source || member.job_id}
                        </span>
                        <span className={`vk-task-detail-batch-status is-${member.state}`}>
                          {BATCH_STATE_LABELS[member.state]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )
              : sources.length > 0
                ? <ol>{sources.map((source) => <li key={source}>{source}</li>)}</ol>
                : <p>未返回来源信息</p>}
          </div>

          <dl className="vk-task-detail-list">
            <div>
              <dt>模型配置</dt>
              <dd>{configuredModelName(job, providers)}</dd>
            </div>
            <div>
              <dt>处理目的</dt>
              <dd>{String(job.request?.preset ?? '—')}</dd>
            </div>
            <div>
              <dt>提交时间</dt>
              <dd>{job.submitted_at ? new Date(job.submitted_at).toLocaleString('zh-CN') : '—'}</dd>
            </div>
          </dl>

          {/* 缓存 Token 恒为 0（本产品不走 prompt 缓存），费用则因通道普遍不提供可信价格
              而长期显示"未统计"——两个格子都只是占地方，去掉。 */}
          {job.progress?.usage && (
            <div className="vk-task-detail-section" data-testid="vk-run-metrics">
              <h3>本次解析用量</h3>
              <dl className="vk-run-metrics-grid">
                <div><dt>输入 {job.progress.usage.input_tokens.toLocaleString('zh-CN')}</dt><dd>Token</dd></div>
                <div><dt>输出 {job.progress.usage.output_tokens.toLocaleString('zh-CN')}</dt><dd>Token</dd></div>
              </dl>
            </div>
          )}

          {(job.progress?.stage_metrics?.length ?? 0) > 0 && (
            <div className="vk-task-detail-section" data-testid="vk-stage-metrics">
              <h3>阶段耗时</h3>
              <ol className="vk-stage-metric-list">
                {job.progress!.stage_metrics!.map((metric, index) => (
                  <li key={`${metric.stage}-${index}`}>
                    <div><strong>{stageLabel(metric.stage)}</strong><span>{secondsLabel(metric.elapsed_s)}</span></div>
                    <p>{metric.model_calls} 次模型调用 · 输入 {metric.input_tokens.toLocaleString('zh-CN')} · 输出 {metric.output_tokens.toLocaleString('zh-CN')}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {(job.progress?.model_attempts?.length ?? 0) > 0 && (
            <div className="vk-task-detail-section" data-testid="vk-model-attempts">
              <h3>模型调用记录</h3>
              <ol className="vk-model-attempt-list">
                {job.progress!.model_attempts!.map((attempt) => (
                  <li key={`${attempt.attempt_number}-${attempt.created_at}`}>
                    <div>
                      <strong>第 {attempt.attempt_number} 次 · {modelAttemptName(attempt.provider_route, providers)}</strong>
                      <span className={`is-${attempt.status}`}>{MODEL_ATTEMPT_STATUS[attempt.status] ?? attempt.status}</span>
                    </div>
                    <p>{stageLabel(attempt.stage)} · {attempt.model_reported || attempt.model_requested}</p>
                    <p>总耗时 {Math.max(0, attempt.latency_ms)} ms · {telemetryMs('首字', attempt.first_text_ms)}</p>
                    {/* 逐事件的流式明细只有排查卡顿时才用得上,平时是噪声。收进折叠区,
                        需要时展开——不是删掉,那些字段正是上次定位超时的依据。 */}
                    <details className="vk-model-attempt-trace">
                      <summary>流式明细</summary>
                      <p>
                        {transportLabel(attempt.transport_mode)} · {telemetryMs('响应头', attempt.response_headers_ms)} · {' '}
                        {telemetryMs('首事件', attempt.first_event_ms)}
                      </p>
                      <p>
                        {telemetryMs('首推理事件', attempt.first_reasoning_ms)} · {' '}
                        最后事件 {attempt.last_event_type || '未记录'}{attempt.last_event_ms == null ? '' : `（${attempt.last_event_ms} ms）`} · {' '}
                        终止事件 {attempt.terminal_event_type || '未记录'} · {' '}
                        [DONE] {attempt.stream_done_received ? '已收到' : '未收到'}
                      </p>
                      {attempt.stream_event_types && attempt.stream_event_types !== '{}' && (
                        <p>事件类型 {attempt.stream_event_types}</p>
                      )}
                      <p>
                        推理强度 {attempt.reasoning_effort || '未记录'} · {' '}
                        输出上限 {attempt.max_output_tokens == null ? '未记录' : attempt.max_output_tokens.toLocaleString('zh-CN')}
                      </p>
                    </details>
                    {attempt.request_may_still_run && (
                      <p role="alert" style={{ color: 'var(--color-warning)', fontWeight: 600 }}>
                        上游可能仍在运行和计费；系统没有自动重试
                      </p>
                    )}
                    {attempt.switch_reason === 'previous_route_transient_error' && (
                      <p className="vk-model-switch-reason">上一通道发生临时故障，已按你的备用顺序切换</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {job.error && <div className="vk-task-detail-error">{job.error}</div>}

          <div className="vk-task-detail-actions">
            {/* 整批重跑。放在最前:从批量行点进来的人,想要的多半是"这一批再来一次",
                而不是只重跑落在眼前的这一条。条数写在按钮上,因为已完成的批量重跑会
                再花一次额度——那是明知的取舍(整批失败时需要一键重来),但不能让人误点。 */}
            {rerunable.length > 1 && (
              <div
                className="vk-task-batch-rerun"
                ref={rerunMenuRef}
                onMouseEnter={() => setRerunMenuOpen(true)}
                onMouseLeave={() => { if (!rerunMenuPinned) setRerunMenuOpen(false) }}
              >
                {rerunMenuOpen && (
                  <div className="vk-task-operation-menu vk-task-batch-rerun-menu" role="menu">
                    {batchMembers.map((member, index) => {
                      const disabled = member.state === 'running'
                      const checked = selection.has(member.job_id)
                      return (
                        <button
                          key={member.job_id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          disabled={disabled}
                          onClick={() => {
                            const next = new Set(selection)
                            if (next.has(member.job_id)) next.delete(member.job_id)
                            else next.add(member.job_id)
                            setRerunPicked(next)
                          }}
                        >
                          {checked ? <Check size={15} aria-hidden="true" /> : <span className="vk-task-batch-rerun-blank" />}
                          <span className="vk-task-batch-rerun-item">
                            <b>小任务{index + 1}</b>
                            <em>{member.source || member.job_id}</em>
                          </span>
                          {/* 重跑已完成的会再花一次额度,选之前得看得见 */}
                          <span className={`vk-task-detail-batch-status is-${member.state}`}>
                            {member.state === 'done' ? '已完成 · 再计费' : BATCH_STATE_LABELS[member.state]}
                          </span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      role="menuitem"
                      className="vk-task-batch-rerun-all"
                      onClick={() => setRerunPicked(
                        selectedCount === rerunable.length
                          ? new Set(failedIds)
                          : new Set(rerunable.map((member) => member.job_id)),
                      )}
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      <span>{selectedCount === rerunable.length ? '只选失败的' : '全选'}</span>
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="vk-task-batch-rerun-button"
                  disabled={actionPending !== null || selectedCount === 0}
                  aria-haspopup="menu"
                  aria-expanded={rerunMenuOpen}
                  onFocus={() => setRerunMenuOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRerunMenuOpen(false)
                    if (event.key === 'ArrowUp') { event.preventDefault(); setRerunMenuOpen(true) }
                  }}
                  onClick={() => { void rerunSelected(selection) }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{actionPending === 'batch' ? '正在重跑…' : selectedLabel}</span>
                </button>
                <button
                  type="button"
                  className="vk-task-batch-rerun-caret"
                  aria-label={rerunMenuPinned ? '收起小任务选择' : '展开小任务选择'}
                  aria-haspopup="menu"
                  aria-expanded={rerunMenuOpen}
                  disabled={actionPending !== null}
                  onClick={() => {
                    const next = !rerunMenuPinned
                    setRerunMenuPinned(next)
                    setRerunMenuOpen(next)
                  }}
                >
                  <ChevronUp size={13} aria-hidden="true" />
                </button>
              </div>
            )}
            {active && (
              <button type="button" className="vk-task-stop-button" disabled={stopping || actionPending !== null} onClick={() => { void runAction('cancel') }}>
                <Square size={13} fill="currentColor" aria-hidden="true" />
                <span>{stopping || actionPending === 'cancel' ? '正在停止…' : '停止任务'}</span>
              </button>
            )}
            {failed && (
              <motion.button
                type="button"
                className="vk-task-retry-button"
                disabled={actionPending !== null}
                onClick={() => { void runAction('retry') }}
                whileHover={{ scale: 1.02 }}
              >
                <motion.span whileHover={{ rotate: 180 }} transition={{ type: 'spring', stiffness: 400, damping: 25 }}>
                  <RefreshCw size={15} aria-hidden="true" />
                </motion.span>
                <span>{actionPending === 'retry' ? '正在重试…' : '重试'}</span>
              </motion.button>
            )}
            {(completedSuccessfully || interrupted) && (
              <motion.button
                type="button"
                className="vk-task-submit-again-button"
                disabled={actionPending !== null}
                onMouseEnter={() => setSubmitHovered(true)}
                onMouseLeave={() => setSubmitHovered(false)}
                onClick={() => { void runAction('resubmit') }}
                whileHover={{ scale: 1.02 }}
              >
                <span className="vk-task-action-icon">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {!submitHovered ? (
                      <motion.span key="send" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 25 }}>
                        <Send size={15} aria-hidden="true" />
                      </motion.span>
                    ) : (
                      <motion.span key="check" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 25 }}>
                        <Check size={15} aria-hidden="true" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
                <span>{actionPending ? '正在提交…' : '再次提交任务'}</span>
              </motion.button>
            )}
            {/* 看结果和再跑一次是同一时刻的两个选择,并排放;原先「查看解析结果」独占一个
                区块吊在最底下,还得先滚过去。 */}
            {completedSuccessfully && primaryOutput(job) && (
              <button type="button" className="vk-task-open-output-button" onClick={() => {
                const output = primaryOutput(job)
                if (output) window.dispatchEvent(new CustomEvent(VK_OPEN_OUTPUT_EVENT, {
                  detail: { outputId: output.id, title: '解析结果' },
                }))
              }}>
                <Eye size={14} aria-hidden="true" />
                <span>{primaryOutput(job)?.label}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default VkTaskDetailSidebar
