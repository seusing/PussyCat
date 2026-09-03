import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, ChevronUp, Pause, RefreshCw, Send, Square, X } from 'lucide-react'
import {
  fetchVkJob,
  fetchVkJobs,
  fetchVkProviderSettings,
  postVkJobAction,
} from '../../host/vkClient'
import type { VkJobView, VkProviderSettings, VkStageMetric } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { AppAlert } from '../../components/AppAlert'
import { copyText } from '../../lib/clipboard'
import {
  isVkJobRerun, markVkJobAsRerun, vkDurationLabel, vkElapsedLabel, vkTaskNumberFor, vkTaskNumberForBatch,
  VK_OPEN_OUTPUT_EVENT,
} from './taskUiState'
import './VkTaskDetailSidebar.css'
import { VkResultActions } from './VkResultActions'
import { vkJobRowFromView, vkPrimaryOutput, vkTaskResultGroups, type VkTaskResultGroup } from './taskResults'

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

type BatchState = 'running' | 'done' | 'failed' | 'interrupted'

const BATCH_STATE_LABELS: Record<BatchState, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
}

const BATCH_STATE_COLORS: Record<BatchState, 'primary' | 'success' | 'warning' | 'danger'> = {
  running: 'primary',
  done: 'success',
  failed: 'danger',
  interrupted: 'warning',
}

function batchState(status: string): BatchState {
  const value = status.trim().toLowerCase()
  if (SUCCESS_STATUSES.has(value)) return 'done'
  if (INTERRUPTED_STATUSES.has(value)) return 'interrupted'
  if (FAILED_STATUSES.has(value) || /fail|error|quarantin/.test(value)) return 'failed'
  return 'running'
}

type BatchMember = {
  job_id: string
  source: string
  state: BatchState
  submitted_at: string
  finished_at: string | null
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
  rows: readonly {
    job_id: string; parent_job_id?: string | null; submitted_at: string
    finished_at?: string | null; status: string; source?: string
  }[],
): BatchMember[] {
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
  // 归并键:**同一个视频**。优先用来源链接——那是"这一条小任务是哪个视频"的唯一
  // 事实,与后端怎么串联尝试无关。取不到来源(老数据)才退回重试链的根。
  //
  // 只按重试链归并是不够的:重跑一条已完成的曾经走的是"另开一条新任务"(带 batch、
  // 不带 parent),那条链认不出来,小任务列表于是一次比一次长。那条路已经改成 refresh
  // 了,但**显示不该依赖后端一定串对**——用户的要求是"提交时几条,永远显示几条"。
  const chains = new Map<string, typeof rows[number][]>()
  for (const row of rows) {
    const key = memberSource(row) || rootOf(row)
    const chain = chains.get(key)
    if (chain) chain.push(row)
    else chains.set(key, [row])
  }
  return [...chains.entries()]
    .map(([, attempts]) => {
      const ordered = [...attempts].sort(
        (left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at),
      )
      const latest = ordered[ordered.length - 1]
      const source = ordered.map(memberSource).find(Boolean) ?? ''
      return { first: ordered[0], latest, source }
    })
    // 排序按**首次**提交,这样重跑不会把行的位置打乱——小任务2 永远是小任务2。
    .sort((left, right) => Date.parse(left.first.submitted_at) - Date.parse(right.first.submitted_at))
    .map(({ latest, source }) => ({
      job_id: latest.job_id,
      source,
      state: batchState(latest.status),
      // 耗时按**最新那次尝试**算。从首次提交算起会把中间等着的时间也算进去,
      // 那不是这次跑用了多久。
      submitted_at: latest.submitted_at,
      finished_at: latest.finished_at ?? null,
    }))
}

function sourceItems(job: VkJobView | null): string[] {
  const source = job?.request?.source
  if (typeof source !== 'string') return []
  return [...new Set(source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
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

type StageDisplay = {
  stage: string
  metric: VkStageMetric | null
  state: 'completed' | 'active' | 'interrupted' | 'failed' | 'recorded'
}

/**
 * 只返回后端已经触及的阶段。阶段列表不是预先绘制的计划清单：
 * completed_stages、当前阶段、阶段指标和模型调用记录中的任一项，才足以让阶段出现在 UI。
 */
function stageDisplayEntries(job: VkJobView): StageDisplay[] {
  const progress = job.progress
  const completedStages = new Set(
    (Array.isArray(progress?.completed_stages) ? progress.completed_stages : [])
      .filter((stage): stage is string => typeof stage === 'string' && stage.length > 0),
  )
  const metrics = (Array.isArray(progress?.stage_metrics) ? progress.stage_metrics : [])
    .filter((metric): metric is VkStageMetric => !!metric && typeof metric.stage === 'string' && metric.stage.length > 0)
  const metricByStage = new Map<string, VkStageMetric>()
  for (const metric of metrics) metricByStage.set(metric.stage, metric)

  const observed = new Set<string>(completedStages)
  for (const metric of metrics) observed.add(metric.stage)
  for (const attempt of progress?.model_attempts ?? []) {
    if (typeof attempt?.stage === 'string' && attempt.stage.length > 0) observed.add(attempt.stage)
  }
  const currentStage = typeof progress?.current_stage === 'string' && progress.current_stage.length > 0
    ? progress.current_stage
    : undefined
  if (currentStage) observed.add(currentStage)
  if (observed.size === 0) return []

  const sawFullAnalysis = observed.has('claim') || observed.has('qc')
  const quickRequested = job.auto_route?.processing_depth === 'quick' || job.request?.preset === 'quick-summary'
  const phases = !sawFullAnalysis && quickRequested ? QUICK_SUMMARY_PHASES : FULL_ANALYSIS_PHASES
  const phaseOrder = phases.flatMap((phase) => phase.stages)
  const orderedStages = [
    ...phaseOrder.filter((stage) => observed.has(stage)),
    ...[...observed].filter((stage) => !phaseOrder.includes(stage)),
  ]
  const latestMetricStage = metrics.at(-1)?.stage
  const latestAttemptStage = progress?.model_attempts?.at(-1)?.stage
  const isCompleted = (stage: string) => completedStages.has(stage)
    || /^(done|success|ok)$/i.test(metricByStage.get(stage)?.status ?? '')
  const unfinishedStages = orderedStages.filter((stage) => !isCompleted(stage))
  const latestStage = [currentStage, latestAttemptStage, latestMetricStage]
    .find((stage) => stage && !isCompleted(stage)) ?? unfinishedStages.at(-1)
  const status = job.status.toLowerCase()

  return orderedStages.map((stage) => {
    const metric = metricByStage.get(stage) ?? null
    let state: StageDisplay['state'] = isCompleted(stage) ? 'completed' : 'recorded'
    if (stage === latestStage && state !== 'completed') {
      if (ACTIVE_STATUSES.has(status)) state = 'active'
      else if (INTERRUPTED_STATUSES.has(status)) state = 'interrupted'
      else if (batchState(status) === 'failed') state = 'failed'
    }
    return { stage, metric, state }
  })
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

function modelAttemptName(route: string, settings: VkProviderSettings | null): string {
  const channelId = route.split(':', 1)[0]
  return settings?.channels.find((channel) => channel.id === channelId)?.name ?? route
}

type TaskRowProps = {
  id: string
  label: string
  source: string
  state: BatchState
  elapsed: string
  current: boolean
  expanded: boolean
  onToggle: () => void
  onCopy: (source: string) => void
  /** Changes only when the row's inline progress is owned by the parent job. */
  contentVersion?: unknown
  children?: ReactNode
}

const TaskDisclosureContext = createContext(true)

function TaskRow({
  id, label, source, state, elapsed, current, expanded, onToggle, onCopy, children,
}: TaskRowProps) {
  const reduceMotion = useReducedMotion()
  return (
    <li
      className={`vk-task-detail-task-row is-${state}`}
      data-testid="vk-task-detail-task-row"
      data-row-id={id}
      data-state={state}
      data-color={BATCH_STATE_COLORS[state]}
    >
      <button
        type="button"
        data-testid={`vk-task-detail-task-row-${id}`}
        data-current={current || undefined}
        aria-expanded={expanded}
        onClick={(event) => {
          // A double click is a copy gesture; do not immediately collapse the row on its second click.
          if (event.detail > 1) return
          onToggle()
        }}
        onDoubleClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onCopy(source)
        }}
        title="双击复制链接"
      >
        <span className="vk-task-detail-task-main">
          <b>{label}：</b>
          <span className="vk-task-detail-task-source">{source || '未返回来源信息'}</span>
        </span>
        <span className={`vk-task-detail-batch-status is-${state}`}>{BATCH_STATE_LABELS[state]}</span>
        <span className="vk-task-detail-task-elapsed">{elapsed}</span>
        <ChevronDown className="vk-task-detail-task-chevron" size={14} aria-hidden="true" />
      </button>
      <TaskDisclosureContext.Provider value={expanded}>
        <AnimatePresence initial={false}>
          {expanded && children ? (
          <motion.div
            key="task-disclosure"
            className="vk-task-detail-task-disclosure"
            initial={reduceMotion ? false : { gridTemplateRows: '0fr', opacity: 0, y: -4 }}
            animate={{ gridTemplateRows: '1fr', opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { gridTemplateRows: '0fr', opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="vk-task-detail-task-disclosure-inner">
              {children}
            </div>
          </motion.div>
          ) : null}
        </AnimatePresence>
      </TaskDisclosureContext.Provider>
    </li>
  )
}

const MemoTaskRow = memo(TaskRow, (previous, next) => (
  previous.id === next.id
  && previous.label === next.label
  && previous.source === next.source
  && previous.state === next.state
  && previous.elapsed === next.elapsed
  && previous.current === next.current
  && previous.expanded === next.expanded
  && previous.contentVersion === next.contentVersion
))

function TaskProgressDetails({
  job, progress,
}: {
  job: VkJobView
  progress: ReturnType<typeof stageProgress>
}) {
  const entries = stageDisplayEntries(job)
  const stageCountLabel = ACTIVE_STATUSES.has(job.status)
    ? `阶段 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}`
    : `${entries.length} 个阶段已记录`

  return (
    <div
      className="vk-task-detail-stage-details"
      data-testid="vk-task-detail-stage-details"
      data-stage-count={entries.length}
    >
      <div className="vk-task-detail-stage-progress-meta">
        <span>{progress.currentLabel}</span>
        <strong>{stageCountLabel}</strong>
      </div>
      {entries.length > 0 ? (
        <ol className="vk-task-detail-steps" aria-label="解析阶段">
          {entries.map((entry, index) => {
            const metric = entry.metric
            const elapsed = entry.state === 'active'
              ? metric?.elapsed_s == null ? '进行中' : `${vkDurationLabel(metric.elapsed_s)} · 进行中`
              : metric?.elapsed_s == null
                ? '未记录'
                : vkDurationLabel(metric.elapsed_s)
            return (
            <li
              key={entry.stage}
              className={`vk-task-detail-step is-${entry.state}`}
              data-stage={entry.stage}
              data-stage-state={entry.state}
              aria-current={entry.state === 'active' ? 'step' : undefined}
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <span className="vk-task-detail-step-indicator">
                {entry.state === 'completed' ? <Check size={13} aria-label="已完成" />
                  : entry.state === 'interrupted' ? <Pause size={12} aria-label="已中断" />
                    : entry.state === 'failed' ? <X size={13} aria-label="失败" />
                      : index + 1}
                {entry.state === 'active' && (
                  <span className="vk-task-detail-step-spinner" role="progressbar" aria-label={`${stageLabel(entry.stage)}进行中`} />
                )}
              </span>
              {index < entries.length - 1 && (
                <span className={`vk-task-detail-step-connector is-${entries[index + 1].state}`} aria-hidden="true" />
              )}
              <div className="vk-task-detail-step-content">
                <strong>{stageLabel(entry.stage)}</strong>
                <span>{elapsed}</span>
              </div>
            </li>
            )
          })}
        </ol>
      ) : (
        <p className="vk-task-detail-stage-empty">
          {ACTIVE_STATUSES.has(job.status) ? '等待阶段数据' : '尚未返回阶段数据'}
        </p>
      )}
    </div>
  )
}

function TaskMemberProgress({ jobId, baseUrl, currentJob }: {
  jobId: string
  baseUrl?: string
  currentJob: VkJobView | null
}) {
  const pollingEnabled = useContext(TaskDisclosureContext)
  const [memberJob, setMemberJob] = useState<VkJobView | null>(
    () => currentJob?.job_id === jobId ? currentJob : null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (pollingEnabled) setError(null)
  }, [pollingEnabled])

  useEffect(() => {
    if (!pollingEnabled) return undefined
    let disposed = false
    let loading = false
    let timer: number | undefined
    const load = async () => {
      if (loading || disposed) return
      loading = true
      try {
        const nextJob = await fetchVkJob(jobId, baseUrl)
        if (disposed) return
        setMemberJob(nextJob)
        setError(null)
        if (ACTIVE_STATUSES.has(nextJob.status)) {
          timer ??= window.setInterval(load, 1500)
        } else if (timer !== undefined) {
          window.clearInterval(timer)
          timer = undefined
        }
      } catch (loadError) {
        if (!disposed) setError(detailError(loadError))
      } finally {
        loading = false
      }
    }
    void load()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [jobId, baseUrl, pollingEnabled])

  const detail = memberJob?.job_id === jobId ? memberJob : null
  return (
    <>
      {error && <p role="alert">读取小任务进度失败：{error}</p>}
      {!detail && !error && <p role="status">正在读取小任务进度…</p>}
      {detail && (
        <TaskProgressDetails job={detail} progress={stageProgress(detail, SUCCESS_STATUSES.has(detail.status))} />
      )}
    </>
  )
}

const MemoTaskMemberProgress = memo(TaskMemberProgress, (previous, next) => (
  previous.jobId === next.jobId
  && previous.baseUrl === next.baseUrl
  && previous.currentJob?.job_id === next.currentJob?.job_id
))

export function VkTaskDetailSidebar({ jobId, baseUrl, onClose, onJobChange, onJobRefresh }: {
  jobId: string | null
  baseUrl?: string
  onClose: () => void
  onJobChange?: (jobId: string) => void
  onJobRefresh?: () => void
}) {
  const [job, setJob] = useState<VkJobView | null>(null)
  const [providers, setProviders] = useState<VkProviderSettings | null>(null)
  const [resultState, setResultState] = useState<{ jobId: string; groups: VkTaskResultGroup[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<'cancel' | 'retry' | 'resubmit' | 'batch' | null>(null)
  const [submitHovered, setSubmitHovered] = useState(false)
  const [batchMembers, setBatchMembers] = useState<
    BatchMember[]
  >([])
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set())
  const expandedScopeRef = useRef<string | null>(null)
  const expandedScope = job?.job_id === jobId ? job?.batch_id ?? job?.job_id : null
  const [copyNotices, setCopyNotices] = useState<number[]>([])
  const copyNoticeId = useRef(0)
  const reduceMotion = useReducedMotion()
  // 编号先按 job_id 查;查不到再按批次查 —— 列表把一批折成一行、只记得住那一行的
  // job_id,而详情页打开的往往是批里的某个成员,直查必然落空,标题就退回一串 UUID。
  const taskNumber = useMemo(
    () => vkTaskNumberFor(jobId) ?? vkTaskNumberForBatch(job?.batch_id ?? null),
    [jobId, job?.batch_id],
  )
  const batchSettledCount = batchMembers.filter((member) => member.state !== 'running').length
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
  const batchTerminal = batchMembers.length > 1 && batchMembers.every((member) => member.state !== 'running')
  // 悬停展开,但**不只靠悬停**:纯 hover 菜单键盘用不了,鼠标移向菜单项的途中也容易掠出
  // 容器把菜单收掉(实测就是这么翻的)。点箭头可以「钉住」,钉住后移开不收。
  const [rerunMenuOpen, setRerunMenuOpen] = useState(false)
  const [rerunMenuPinned, setRerunMenuPinned] = useState(false)
  const rerunMenuPinnedRef = useRef(false)
  const rerunMenuRef = useRef<HTMLDivElement | null>(null)
  const rerunMenuCloseTimer = useRef<number | null>(null)
  const [rerunMenuPosition, setRerunMenuPosition] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const [rerunPicked, setRerunPicked] = useState<Set<string> | null>(null)
  const batchStateSignature = useMemo(
    () => batchMembers.map((member) => `${member.job_id}:${member.state}`).join('|'),
    [batchMembers],
  )
  // 切换任务或批次从执行中进入终态时,清掉上一批的手动勾选。终态批量的首次动作
  // 必须回到「重新提交全部任务」,不能把上一批的选择偷偷带过来。
  useEffect(() => {
    setRerunPicked(null)
    setRerunMenuOpen(false)
    setRerunMenuPinned(false)
    rerunMenuPinnedRef.current = false
  }, [jobId, batchStateSignature])

  useEffect(() => {
    if (!expandedScope || expandedScopeRef.current === expandedScope) return
    expandedScopeRef.current = expandedScope
    setExpandedTaskIds(new Set())
  }, [expandedScope])

  const toggleTask = (rowId: string) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  const clearRerunMenuClose = useCallback(() => {
    if (rerunMenuCloseTimer.current !== null) {
      window.clearTimeout(rerunMenuCloseTimer.current)
      rerunMenuCloseTimer.current = null
    }
  }, [])

  const updateRerunMenuPosition = useCallback(() => {
    const anchor = rerunMenuRef.current?.getBoundingClientRect()
    if (!anchor) return
    const margin = 12
    const width = Math.min(Math.max(anchor.width, 320), Math.max(220, window.innerWidth - margin * 2))
    const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - margin - width))
    const bottom = Math.max(margin, window.innerHeight - anchor.top + 6)
    setRerunMenuPosition({ left, bottom, width })
  }, [])

  const openRerunMenu = useCallback(() => {
    clearRerunMenuClose()
    updateRerunMenuPosition()
    setRerunMenuOpen(true)
  }, [clearRerunMenuClose, updateRerunMenuPosition])

  const scheduleRerunMenuClose = useCallback(() => {
    if (rerunMenuPinnedRef.current) return
    clearRerunMenuClose()
    rerunMenuCloseTimer.current = window.setTimeout(() => {
      setRerunMenuOpen(false)
      rerunMenuCloseTimer.current = null
    }, 160)
  }, [clearRerunMenuClose])

  useEffect(() => () => clearRerunMenuClose(), [clearRerunMenuClose])

  useEffect(() => {
    if (!rerunMenuOpen) return undefined
    updateRerunMenuPosition()
    const update = () => updateRerunMenuPosition()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [rerunMenuOpen, updateRerunMenuPosition])

  const copyLink = useCallback(async (source: string) => {
    const link = source.trim()
    if (!link) return
    if (await copyText(link)) {
      const id = ++copyNoticeId.current
      setCopyNotices((notices) => [id, ...notices])
    }
  }, [])
  // 钉住之后点别处要能收起来。原先只有再点一次箭头才收,菜单于是一直挂在那儿挡着下面
  // 的内容 —— 用户的原话是「点击菜单以外的地方时不会自动收回」。Esc 一并收。
  useEffect(() => {
    if (!rerunMenuOpen) return undefined
    const dismiss = (event: Event) => {
      const node = rerunMenuRef.current
      const target = event.target
      if (
        target instanceof Node
        && ((node && node.contains(target))
          || (target instanceof Element && target.closest('.vk-task-batch-rerun-menu')))
      ) return
      setRerunMenuOpen(false)
      rerunMenuPinnedRef.current = false
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
  // 执行中的批量默认只选失败项,避免重复计费;批次全部进入终态后首次操作改为全选,
  // 让「重新提交全部任务」的文案与实际请求集合保持一致。
  const selection = useMemo(() => {
    if (rerunPicked) return rerunPicked
    if (batchTerminal) return new Set(rerunable.map((member) => member.job_id))
    if (failedIds.length > 0) return new Set(failedIds)
    return new Set(rerunable.map((member) => member.job_id))
  }, [batchTerminal, rerunPicked, failedIds, rerunable])
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
      setProviders(null)
      setResultState(null)
      setBatchMembers([])
      return
    }
    try {
      // The detail endpoint contains the current output path. Render it as soon
      // as it arrives; the provider and list reads only enrich history and
      // sibling rows and must not hold the result action hostage.
      const providersPromise = fetchVkProviderSettings(baseUrl).catch(() => null)
      const rowsPromise = fetchVkJobs(baseUrl).catch(() => [])
      const nextJob = await fetchVkJob(jobId, baseUrl)
      if (generation !== loadGeneration.current) return
      setJob(nextJob)
      setError(null)
      const currentRow = vkJobRowFromView(nextJob)
      const currentGroups = vkTaskResultGroups([currentRow], nextJob.job_id)
      setResultState({
        jobId: nextJob.job_id,
        groups: vkPrimaryOutput(nextJob) ? currentGroups : currentGroups.map((group) => ({
          ...group, versions: group.versions.filter((version) => version.jobId !== nextJob.job_id),
        })),
      })

      const [nextProviders, rows] = await Promise.all([providersPromise, rowsPromise])
      if (generation !== loadGeneration.current) return
      setProviders(nextProviders)
      const mergedRows = rows.some((row) => row.job_id === nextJob.job_id)
        ? rows.map((row) => row.job_id === nextJob.job_id ? { ...row, ...currentRow } : row)
        : [...rows, currentRow]
      const groups = vkTaskResultGroups(mergedRows, nextJob.job_id)
      setResultState({
        jobId: nextJob.job_id,
        groups: vkPrimaryOutput(nextJob) ? groups : groups.map((group) => ({
          ...group, versions: group.versions.filter((version) => version.jobId !== nextJob.job_id),
        })),
      })
      if (nextJob.batch_id) {
        setBatchMembers(collapseAttempts(
          mergedRows.filter((row) => row.batch_id === nextJob.batch_id),
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
    setJob(null)
    setProviders(null)
    setResultState(null)
    setBatchMembers([])
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
    const batchActive = batchMembers.some((member) => member.state === 'running')
    if (!job || (!ACTIVE_STATUSES.has(job.status) && !batchActive)) return
    const timer = window.setInterval(load, 1500)
    return () => window.clearInterval(timer)
  }, [batchMembers, job, load])

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
      const jobAction = action === 'resubmit' && SUCCESS_STATUSES.has(job.status) ? 'refresh' : 'retry'
      const result = await postVkJobAction(jobId, jobAction, baseUrl)
      const nextJobId = typeof result.job_id === 'string' ? result.job_id : null
      if (nextJobId) {
        markVkJobAsRerun(nextJobId)
        window.dispatchEvent(new CustomEvent(VK_JOB_RETRY_SUBMITTED_EVENT, {
          detail: { jobId: nextJobId },
        }))
        onJobChange?.(nextJobId)
        onJobRefresh?.()
      }
      else await load()
    } catch (actionError) {
      setError(detailError(actionError))
    } finally {
      setActionPending(null)
    }
  }

  /** 重跑选中的小任务:失败/中断走 retry,已完成走 refresh。空选由调用方拦截。 */
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
        // 两条路都走 job action,**都会把 parent_job_id 指回被重跑的那条**:
        //   失败/中断 → retry(沿用请求,走缓存)
        //   已完成   → refresh(同一请求,显式绕过缓存——重跑一条已完成的,要的就是重算)
        // 原先"已完成"那支是 postVkJob 另开一条新任务:batch_id 虽然带上了,但**没有
        // parent**,于是前端按重试链折叠时认不出它是同一个视频的又一次尝试,小任务
        // 列表就一次比一次长(用户看到 2 条变 3 条、3 条变 4 条)。
        const result = await postVkJobAction(
          member.job_id, member.state === 'done' ? 'refresh' : 'retry', baseUrl,
        )
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
    if (firstNewJobId) {
      onJobChange?.(firstNewJobId)
      onJobRefresh?.()
    }
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
      {copyNotices.length > 0 && (
        <div className="vk-task-detail-notification" data-testid="vk-task-detail-notification">
          {copyNotices.map((id) => <AppAlert
            key={id}
            testId="vk-copy-notice"
            tone="success"
            title="已复制链接"
            durationMs={1_000}
            onExpire={() => setCopyNotices((notices) => notices.filter((notice) => notice !== id))}
          />)}
        </div>
      )}
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

          {/* 提交内容是唯一的任务入口。阶段耗时收进对应 task row,默认收起,点击后按已到达
              的阶段渐进展示,批量任务切换成员时只加载该成员的真实进度。 */}
          <div className="vk-task-detail-section" data-testid="vk-task-detail-sources">
            <h3>
              提交内容
              {batchMembers.length > 1 && (
                <span className="vk-task-detail-batch-count">
                  {' '}共 {batchMembers.length} 个视频 · 已处理 {batchSettledCount}/{batchMembers.length}
                </span>
              )}
            </h3>
            <ol className="vk-task-detail-task-list">
              {batchMembers.length > 1
                ? batchMembers.map((member, index) => (
                  <MemoTaskRow
                    key={member.job_id}
                    id={member.job_id}
                    label={`小任务${index + 1}`}
                    source={member.source || member.job_id}
                    state={member.state}
                    elapsed={`耗时 ${vkElapsedLabel(member.submitted_at, member.finished_at)}`}
                    current={member.job_id === jobId}
                    expanded={expandedTaskIds.has(member.job_id)}
                    onToggle={() => toggleTask(member.job_id)}
                    onCopy={copyLink}
                    contentVersion={baseUrl}
                  >
                    <MemoTaskMemberProgress jobId={member.job_id} baseUrl={baseUrl} currentJob={job} />
                  </MemoTaskRow>
                ))
                : sources.length > 0
                  ? sources.map((source, index) => {
                    const rowId = `source-${index}`
                    return (
                      <MemoTaskRow
                        key={rowId}
                        id={rowId}
                        label="链接"
                        source={source}
                        state={batchState(job.status)}
                        elapsed={`耗时 ${vkElapsedLabel(job.submitted_at, job.finished_at)}`}
                        current
                        expanded={expandedTaskIds.has(rowId)}
                        onToggle={() => toggleTask(rowId)}
                        onCopy={copyLink}
                        contentVersion={job}
                      >
                        <TaskProgressDetails job={job} progress={progress} />
                      </MemoTaskRow>
                    )
                  })
                  : (
                    <li className="vk-task-detail-task-empty">未返回来源信息</li>
                  )}
            </ol>
          </div>

          <dl className="vk-task-detail-list" data-testid="vk-task-detail-metadata">
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

          {job.error && <div className="vk-task-detail-error">{job.error}</div>}

          <div className="vk-task-detail-actions">
            {/* 整批重跑。放在最前:从批量行点进来的人,想要的多半是"这一批再来一次",
                而不是只重跑落在眼前的这一条。条数写在按钮上,因为已完成的批量重跑会
                再花一次额度——那是明知的取舍(整批失败时需要一键重来),但不能让人误点。 */}
            {rerunable.length > 1 && (
              <div
                className="vk-task-batch-rerun"
                data-terminal-batch={batchTerminal || undefined}
                ref={rerunMenuRef}
                onMouseEnter={openRerunMenu}
                onMouseLeave={scheduleRerunMenuClose}
              >
                {rerunMenuPosition && typeof document !== 'undefined' && createPortal(
                  <AnimatePresence>
                  {rerunMenuOpen && <motion.div
                    key="rerun-menu"
                    className="vk-task-operation-menu vk-task-batch-rerun-menu"
                    role="menu"
                    style={{ ...rerunMenuPosition, originY: 1 }}
                    onMouseEnter={openRerunMenu}
                    onMouseLeave={scheduleRerunMenuClose}
                    variants={{
                      hidden: { opacity: 0, y: 5, scaleY: 0.96, transition: { duration: reduceMotion ? 0 : 0.2, staggerChildren: reduceMotion ? 0 : 0.04, staggerDirection: -1, when: 'afterChildren' } },
                      visible: { opacity: 1, y: 0, scaleY: 1, transition: { duration: reduceMotion ? 0 : 0.2, staggerChildren: reduceMotion ? 0 : 0.04 } },
                    }}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                  >
                    {batchMembers.map((member, index) => {
                      const disabled = member.state === 'running'
                      const checked = selection.has(member.job_id)
                      return (
                        <motion.button
                          key={member.job_id}
                          type="button"
                          role="menuitemcheckbox"
                          className={`vk-task-batch-rerun-option is-${member.state}`}
                          data-state={member.state}
                          data-color={BATCH_STATE_COLORS[member.state]}
                          aria-checked={checked}
                          disabled={disabled}
                          variants={{
                            hidden: { opacity: 0, y: 5 },
                            visible: { opacity: 1, y: 0 },
                          }}
                          transition={{ duration: reduceMotion ? 0 : 0.18 }}
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
                          <span className={`vk-task-detail-batch-status is-${member.state}`} data-state={member.state}>
                            {member.state === 'done' ? '已完成 · 再计费' : BATCH_STATE_LABELS[member.state]}
                          </span>
                        </motion.button>
                      )
                    })}
                    <motion.button
                      type="button"
                      role="menuitem"
                      className="vk-task-batch-rerun-all"
                      variants={{ hidden: { opacity: 0, y: 5 }, visible: { opacity: 1, y: 0 } }}
                      transition={{ duration: reduceMotion ? 0 : 0.18 }}
                      onClick={() => setRerunPicked(
                        selectedCount === rerunable.length
                          ? new Set(failedIds)
                          : new Set(rerunable.map((member) => member.job_id)),
                      )}
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      <span>{selectedCount === rerunable.length ? '只选失败的' : '全选'}</span>
                    </motion.button>
                  </motion.div>}
                  </AnimatePresence>,
                  document.body,
                )}
                <button
                  type="button"
                  className="vk-task-batch-rerun-button"
                  disabled={actionPending !== null || selectedCount === 0}
                  aria-haspopup="menu"
                  aria-expanded={rerunMenuOpen}
                  onFocus={openRerunMenu}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRerunMenuOpen(false)
                    if (event.key === 'ArrowUp') { event.preventDefault(); openRerunMenu() }
                  }}
                  onClick={() => { void rerunSelected(selection) }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{actionPending === 'batch' ? '正在重跑…' : batchTerminal && rerunPicked === null ? '重新提交全部任务' : selectedLabel}</span>
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
                    rerunMenuPinnedRef.current = next
                    setRerunMenuPinned(next)
                    if (next) openRerunMenu()
                    else setRerunMenuOpen(false)
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
            <VkResultActions
              groups={resultState?.jobId === jobId ? resultState.groups : []}
              onOpen={(versionJobId) => {
                const output = versionJobId ? null : vkPrimaryOutput(job)
                window.dispatchEvent(new CustomEvent(VK_OPEN_OUTPUT_EVENT, {
                  detail: { jobId, versionJobId, title: '解析结果', ...(output ? { outputId: output.id } : {}) },
                }))
              }}
            />
          </div>
        </div>
      )}
    </section>
  )
}

export default VkTaskDetailSidebar
