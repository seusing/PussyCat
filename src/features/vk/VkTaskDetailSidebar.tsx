import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, ChevronUp, Minus, Pause, RefreshCw, Send, Square, X } from 'lucide-react'
import {
  JEV_API_STYLE,
  fetchVkJob,
  fetchVkJobs,
  fetchVkProviderSettings,
  postVkBatchCancel,
  postVkJobAction,
} from '../../host/vkClient'
import type { VkJobView, VkProviderSettings, VkStageMetric } from '../../host/vkClient'
import { vkErrorText, vkStageFailureNote } from './vkErrors'
import { VkFailureNote, VkRawInfo } from './VkFailureNote'
import { describeVkFailure } from './vkFailure'
import { AppAlert } from '../../components/AppAlert'
import { AppNotificationStack } from '../../components/AppNotificationStack'
import { ConfirmPopover } from '../../components/ConfirmPopover'
import { glassPopMotion, useGlassMenuSurface } from '../../components/GlassMenu'
import { copyText } from '../../lib/clipboard'
import {
  isVkJobRerun, markVkJobAsRerun, vkDurationLabel, vkElapsedLabel, vkTaskNumberFor, vkTaskNumberForBatch,
  VK_OPEN_OUTPUT_EVENT,
} from './taskUiState'
import './VkTaskDetailSidebar.css'
import { VkResultActions } from './VkResultActions'
import { VkStorylineSection } from './VkStorylineSection'
import { vkJobRowFromView, vkPrimaryOutput, vkTaskResultGroups, type VkTaskResultGroup } from './taskResults'
import {
  ACTIVE_STATUSES, FAILED_STATUSES, INTERRUPTED_STATUSES, SUCCESS_STATUSES,
  aggregateBatchStatus, batchState, collapseAttempts, memberInFlight,
  type BatchMember, type BatchState,
} from './batchMembers'

const VK_JOB_DETAIL_TERMINAL_EVENT = 'vk:job-detail-terminal'
const VK_JOB_TERMINAL_EVENT = 'vk:job-terminal'
const VK_JOB_RETRY_SUBMITTED_EVENT = 'vk:job-retry-submitted'

function detailError(error: unknown): string {
  return vkErrorText(error, '任务详情获取失败')
}

/** 单条操作失败时提示的标题。 */
const ACTION_FAILURE_TITLES: Record<'cancel' | 'retry' | 'resubmit', string> = {
  cancel: '未能停止任务',
  retry: '未能重试',
  resubmit: '未能再次提交任务',
}

type ConfirmRequest = {
  anchor: HTMLElement
  title: string
  body: string[]
  confirmLabel: string
  onConfirm: () => void
}

const BATCH_STATE_LABELS: Record<BatchState, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  interrupted: '已中断',
}

const BATCH_STATE_COLORS: Record<BatchState, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'primary',
  done: 'success',
  partial: 'warning',
  failed: 'danger',
  interrupted: 'warning',
}

/** 批次顶部状态:成员各取最新一次尝试,口径与列表里的整批状态一致。 */
function batchBadge(members: readonly BatchMember[]): { className: string; label: string } {
  if (members.some((member) => memberInFlight(member.state))) return { className: 'is-running', label: '正在执行' }
  const status = aggregateBatchStatus(members).trim().toLowerCase()
  if (status === 'partial_success') return { className: 'is-partial', label: '部分成功' }
  if (status === 'partial') return { className: 'is-partial', label: '部分完成' }
  if (SUCCESS_STATUSES.has(status)) return { className: 'is-completed', label: '已完成' }
  if (INTERRUPTED_STATUSES.has(status)) return { className: 'is-interrupted', label: '已中断' }
  return { className: 'is-failed', label: '失败' }
}

/** 排队中的小任务还没开始跑,不显示耗时(从提交算起会把排队时间算成运行时间)。 */
function elapsedLabel(state: BatchState, submittedAt: string, finishedAt?: string | null): string {
  return state === 'queued' ? '' : `耗时 ${vkElapsedLabel(submittedAt, finishedAt)}`
}

/** done 与 partial 都有可用结果:重跑走 refresh 且会再计费,串联分析也算它。 */
function producedResult(state: BatchState): boolean {
  return state === 'done' || state === 'partial'
}

/** 菜单里的链接只留辨识部分:去掉协议和 www.,路径与查询串保留(B 站分 P 靠 ?p= 区分)。 */
function compactSource(source: string): string {
  return source.replace(/^https?:\/\/(?:www\.)?/i, '')
}

function sourceItems(job: VkJobView | null): string[] {
  const source = job?.request?.source
  if (typeof source !== 'string') return []
  return [...new Set(source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
}

type TaskPhase = Readonly<{ label: string; stages: readonly string[] }>

const QUICK_SUMMARY_PHASES: readonly TaskPhase[] = [
  { label: '获取视频内容', stages: ['acquire', 'normalize'] },
  { label: '理解视频重点', stages: ['chapter', 'jev_terms'] },
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

const STORYLINE_PHASES: readonly TaskPhase[] = [
  { label: 'Jev 判断关联', stages: ['storyline_relate'] },
  { label: '串联摘要', stages: ['series_digest'] },
  { label: '关系判定', stages: ['storyline_link'] },
  { label: '故事线汇总', stages: ['storyline_reduce'] },
  { label: '观点对比', stages: ['storyline_compare'] },
]

const STAGE_LABELS: Record<string, string> = {
  acquire: '采集与转写',
  normalize: '整理字幕',
  chapter: '理解视频',
  jev_terms: 'Jev 筛选术语',
  summary_map: '分段提取',
  summary_reduce: '分层汇总',
  claim: '提取关键信息',
  qc: '核对关键信息',
  illustrate: '配图',
  note: '整理知识笔记',
  product: '生成解析结果',
  storyline_relate: 'Jev 判断关联',
  series_digest: '串联摘要',
  storyline_link: '关系判定',
  storyline_reduce: '故事线汇总',
  storyline_compare: '观点对比',
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

const DONE_METRIC_STATUS = /^(done|success|ok)$/i
const FAILED_STAGE_METRIC_STATUSES = new Set(['quarantined', 'failed'])
const isRunningMetric = (metric: VkStageMetric) => /^running$/i.test(metric.status ?? '')
const isSkippedMetric = (metric: VkStageMetric) => /^skipped$/i.test(metric.status ?? '')
const isFailedMetric = (metric: VkStageMetric) => FAILED_STAGE_METRIC_STATUSES.has((metric.status ?? '').toLowerCase())

function stageMetricsOf(job: VkJobView): VkStageMetric[] {
  const raw = job.progress?.stage_metrics
  return (Array.isArray(raw) ? raw : [])
    .filter((metric): metric is VkStageMetric => !!metric && typeof metric.stage === 'string' && metric.stage.length > 0)
}

/** 同名阶段的指标归到一起:串联摘要每个视频跑一次,同一个阶段名会出现多条。 */
function groupStageMetrics(metrics: readonly VkStageMetric[]): Map<string, VkStageMetric[]> {
  const groups = new Map<string, VkStageMetric[]>()
  for (const metric of metrics) {
    const group = groups.get(metric.stage)
    if (group) group.push(metric)
    else groups.set(metric.stage, [metric])
  }
  return groups
}

/** 指标全是 skipped 的阶段算跳过;它若还是当前阶段,说明引擎没往下走,不算。 */
function stageSkipped(stage: string, group: readonly VkStageMetric[], currentStage: string | undefined): boolean {
  return group.length > 0 && group.every(isSkippedMetric) && stage !== currentStage
}

/**
 * 阶段是否已经结束:`done` 由调用方按各自口径给出,跳过的阶段同样算结束。
 * 同名重复的阶段只要有一次完成,completed_stages 就会带上这个名字,所以它还有一次在跑、
 * 或就是当前阶段时不能算完成。只出现一次的阶段仍以 `done` 为准。
 */
function stageFinished(
  stage: string, done: boolean, group: readonly VkStageMetric[], currentStage: string | undefined,
): boolean {
  if (group.length > 1 && (stage === currentStage || group.some(isRunningMetric))) return false
  return done || stageSkipped(stage, group, currentStage)
}

function stageProgress(
  job: VkJobView,
  successful: boolean,
  explicitPhases?: readonly TaskPhase[],
  doneLabel = '解析完成',
): {
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
  const phases = explicitPhases ?? (!sawFullAnalysis && quickRequested ? QUICK_SUMMARY_PHASES : FULL_ANALYSIS_PHASES)
  const metricGroups = groupStageMetrics(stageMetricsOf(job))
  let completed = 0
  if (successful) completed = phases.length
  else {
    for (const phase of phases) {
      const finished = (stage: string) => stageFinished(
        stage, completedStages.has(stage), metricGroups.get(stage) ?? [], currentStage,
      )
      if (!phase.stages.every(finished)) break
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
    currentLabel: successful ? doneLabel : current.label,
  }
}

type StageDisplay = {
  stage: string
  state: 'completed' | 'active' | 'interrupted' | 'failed' | 'skipped' | 'recorded'
  /** 同名阶段出现的次数(串联摘要每个视频一次),界面合并成一行。 */
  count: number
  /** 同名阶段里失败/隔离的次数。 */
  failedCount: number
  /** 同名阶段里第一条失败记录的原始错误;没有或引擎没给时为 null。 */
  firstFailureRaw: string | null
  /** 各次用时里有记录的部分之和;一次都没记录为 null。 */
  elapsedS: number | null
  /** 这一阶段最新一次模型调用答的模型(Jev 的调用也算);没有调用为 null。 */
  model: string | null
  /** 只在引擎明确判了这一阶段隔离/失败时有值。 */
  failureReason: string | null
  /** 引擎随这一阶段下发的原始错误;没给时为 null,界面只显示 failureReason 的兜底说明。 */
  failureRaw: string | null
  /** 阶段被跳过时引擎给的原因;没给时为 null。 */
  skippedReason: string | null
}

// 原因优先取引擎随 stage_metrics 下发的 error;旧引擎或引擎没给时,如实说「没有产出」。
const STAGE_NO_RESULT_REASON = '这一步没有产出可用结果'
// 旧引擎的 skipped 阶段 error 是 missing_transcript 这类原始错误码,不能原样给用户看。
const ENGINE_ERROR_CODE = /^[a-z][a-z0-9_]*$/i

/** skipped 阶段的原因是原始错误码:认得出的按失败文案说明,认不出的只说没有执行,原码收进「原始信息」。 */
function SkippedCodeReason({ raw }: { raw: string }) {
  return (
    <div className="vk-task-detail-step-reason is-skipped">
      {describeVkFailure(raw).kind !== 'unknown'
        ? <VkFailureNote raw={raw} />
        : <>已跳过：这一步没有执行<VkRawInfo raw={raw} /></>}
    </div>
  )
}

/** 阶段失败原文的展示:认得出的翻成人话,原文放进 title;认不出的走通用失败说明。 */
function StageFailureReason({ raw }: { raw: string }) {
  const note = vkStageFailureNote(raw)
  if (note) return <span className="vk-task-detail-step-reason" title={note.title}>{note.text}</span>
  return <div className="vk-task-detail-step-reason"><VkFailureNote raw={raw} /></div>
}

/**
 * 只返回后端已经触及的阶段。阶段列表不是预先绘制的计划清单：
 * completed_stages、当前阶段、阶段指标和模型调用记录中的任一项，才足以让阶段出现在 UI。
 */
function stageDisplayEntries(job: VkJobView, explicitPhases?: readonly TaskPhase[]): StageDisplay[] {
  const progress = job.progress
  const completedStages = new Set(
    (Array.isArray(progress?.completed_stages) ? progress.completed_stages : [])
      .filter((stage): stage is string => typeof stage === 'string' && stage.length > 0),
  )
  const metrics = stageMetricsOf(job)
  const metricGroups = groupStageMetrics(metrics)
  const groupOf = (stage: string) => metricGroups.get(stage) ?? []

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
  const phases = explicitPhases ?? (!sawFullAnalysis && quickRequested ? QUICK_SUMMARY_PHASES : FULL_ANALYSIS_PHASES)
  const phaseOrder = phases.flatMap((phase) => phase.stages)
  // 配图在 note 之前运行。旧引擎没有这一阶段,放进进度分组会让分组永远完不成,所以只在显示顺序上排到 note 前。
  const noteAt = phaseOrder.indexOf('note')
  if (noteAt >= 0) phaseOrder.splice(noteAt, 0, 'illustrate')
  const orderedStages = [
    ...phaseOrder.filter((stage) => observed.has(stage)),
    ...[...observed].filter((stage) => !phaseOrder.includes(stage)),
  ]
  const latestMetricStage = metrics.at(-1)?.stage
  const latestAttemptStage = progress?.model_attempts?.at(-1)?.stage
  const isCompleted = (stage: string) => stageFinished(
    stage,
    completedStages.has(stage) || DONE_METRIC_STATUS.test(groupOf(stage).at(-1)?.status ?? ''),
    groupOf(stage),
    currentStage,
  )
  const unfinishedStages = orderedStages.filter((stage) => !isCompleted(stage))
  const latestStage = [currentStage, latestAttemptStage, latestMetricStage]
    .find((stage) => stage && !isCompleted(stage)) ?? unfinishedStages.at(-1)
  const status = job.status.toLowerCase()
  const attempts = progress?.model_attempts ?? []

  return orderedStages.map((stage) => {
    const group = groupOf(stage)
    const metric = group.at(-1) ?? null
    const skipped = stageSkipped(stage, group, currentStage)
    let state: StageDisplay['state'] = skipped ? 'skipped' : isCompleted(stage) ? 'completed' : 'recorded'
    let failureReason: string | null = null
    let failureRaw: string | null = null
    // 被隔离/失败的阶段不论是不是最后一个、任务整体算不算失败(partial 任务就带着
    // 一个被隔离的阶段),都要显示成失败,否则只会落成一个看不出含义的序号。
    if (state !== 'completed' && metric && isFailedMetric(metric)) {
      state = 'failed'
      failureRaw = metric.error?.trim() || null
      failureReason = failureRaw ?? STAGE_NO_RESULT_REASON
    } else if (stage === latestStage && state !== 'completed') {
      if (ACTIVE_STATUSES.has(status)) state = 'active'
      else if (INTERRUPTED_STATUSES.has(status)) state = 'interrupted'
      else if (batchState(status) === 'failed') state = 'failed'
    }
    const elapsed = group.flatMap((item) => typeof item.elapsed_s === 'number' ? [item.elapsed_s] : [])
    const attempt = attempts.filter((item) => item?.stage === stage).at(-1)
    return {
      stage,
      state,
      count: Math.max(group.length, 1),
      failedCount: group.filter(isFailedMetric).length,
      firstFailureRaw: group.find(isFailedMetric)?.error?.trim() || null,
      elapsedS: elapsed.length > 0 ? elapsed.reduce((sum, value) => sum + value, 0) : null,
      model: (attempt?.model_reported || attempt?.model_requested || '').trim() || null,
      failureReason,
      failureRaw,
      skippedReason: skipped ? metric?.error?.trim() || null : null,
    }
  })
}

function configuredModelName(job: VkJobView, settings: VkProviderSettings | null): string {
  const actualRoutes = [...new Set(
    (job.progress?.model_attempts ?? [])
      .filter((attempt) => attempt.api_style !== JEV_API_STYLE)
      .map((attempt) => attempt.provider_route),
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
          {children ? (
          <motion.div
            key="task-disclosure"
            className="vk-task-detail-task-disclosure"
            aria-hidden={!expanded}
            style={{ pointerEvents: expanded ? 'auto' : 'none' }}
            initial={false}
            animate={expanded ? { gridTemplateRows: '1fr', opacity: 1, y: 0 } : { gridTemplateRows: '0fr', opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="vk-task-detail-task-disclosure-inner">
              {children}
            </div>
          </motion.div>
          ) : null}
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
  job, progress, phases,
}: {
  job: VkJobView
  progress: ReturnType<typeof stageProgress>
  /** 不传时按单视频任务的快速/完整阶段分组。 */
  phases?: readonly TaskPhase[]
}) {
  const entries = stageDisplayEntries(job, phases)
  const queued = entries.length === 0 && batchState(job.status) === 'queued'
  const stageCountLabel = ACTIVE_STATUSES.has(job.status)
    ? `阶段 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}`
    : `${entries.length} 个阶段已记录`

  return (
    <div
      className="vk-task-detail-stage-details"
      data-testid="vk-task-detail-stage-details"
      data-stage-count={entries.length}
    >
      {!queued && (
        <div className="vk-task-detail-stage-progress-meta">
          <span>{progress.currentLabel}</span>
          <strong>{stageCountLabel}</strong>
        </div>
      )}
      {entries.length > 0 ? (
        <ol className="vk-task-detail-steps" aria-label="解析阶段">
          {entries.map((entry, index) => {
            const elapsed = entry.state === 'active'
              ? entry.elapsedS == null ? '进行中' : `${vkDurationLabel(entry.elapsedS)} · 进行中`
              : entry.elapsedS == null
                ? '未记录'
                : vkDurationLabel(entry.elapsedS)
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
                  : entry.state === 'skipped' ? <Minus size={13} aria-label="已跳过" />
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
                <strong>
                  {stageLabel(entry.stage)}
                  {entry.count > 1 && ` ×${entry.count}`}
                  {entry.model && <span className="vk-task-detail-step-model"> · {entry.model}</span>}
                </strong>
                <span>{elapsed}</span>
              </div>
              {entry.state === 'skipped'
                ? entry.skippedReason && ENGINE_ERROR_CODE.test(entry.skippedReason)
                  ? <SkippedCodeReason raw={entry.skippedReason} />
                  : (
                    <span className="vk-task-detail-step-reason is-skipped">
                      {entry.skippedReason ? `已跳过：${entry.skippedReason}` : '已跳过'}
                    </span>
                  )
                : entry.failureRaw
                  ? <StageFailureReason raw={entry.failureRaw} />
                  : entry.failureReason && <span className="vk-task-detail-step-reason">{entry.failureReason}</span>}
              {entry.count > 1 && entry.failedCount > 0 && (
                <>
                  <span className="vk-task-detail-step-reason">其中 {entry.failedCount} 次失败</span>
                  {entry.firstFailureRaw && entry.firstFailureRaw !== entry.failureRaw && <StageFailureReason raw={entry.firstFailureRaw} />}
                </>
              )}
            </li>
            )
          })}
        </ol>
      ) : (
        <p className="vk-task-detail-stage-empty">
          {queued ? '排队中，等待空闲名额' : ACTIVE_STATUSES.has(job.status) ? '等待阶段数据' : '尚未返回阶段数据'}
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
  const currentJobRef = useRef(currentJob)
  const [retryVersion, setRetryVersion] = useState(0)
  const wasExpandedRef = useRef(pollingEnabled)

  useEffect(() => {
    if (pollingEnabled && !wasExpandedRef.current && error) {
      setRetryVersion((version) => version + 1)
    }
    wasExpandedRef.current = pollingEnabled
  }, [pollingEnabled, error])

  useEffect(() => {
    currentJobRef.current = currentJob
    if (currentJob?.job_id === jobId) setMemberJob(currentJob)
  }, [currentJob, jobId])

  useEffect(() => {
    const seed = currentJobRef.current
    if (seed?.job_id === jobId) return undefined
    let disposed = false
    setError(null)
    void fetchVkJob(jobId, baseUrl).then((nextJob) => {
      if (disposed) return
      setMemberJob(nextJob)
      setError(null)
    }).catch((loadError) => {
      if (!disposed) setError(detailError(loadError))
    })
    return () => { disposed = true }
  }, [jobId, baseUrl, retryVersion])

  const active = !!memberJob && ACTIVE_STATUSES.has(memberJob.status)
  useEffect(() => {
    if (!pollingEnabled || !active) return undefined
    let disposed = false
    let loading = false
    const load = async () => {
      if (loading || disposed) return
      loading = true
      try {
        const nextJob = await fetchVkJob(jobId, baseUrl)
        if (disposed) return
        setMemberJob(nextJob)
        setError(null)
      } catch (loadError) {
        if (!disposed) setError(detailError(loadError))
      } finally {
        loading = false
      }
    }
    const timer = window.setInterval(load, 1500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [jobId, baseUrl, pollingEnabled, active])

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

const MemoTaskMemberProgress = memo(TaskMemberProgress)

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
  // 操作结果(重跑选中的失败清单,停止、重试、再次提交的失败)不放进 error:load() 读成功就清 error,
  // 切到新任务和执行中的轮询都会把它冲掉。用户关掉或开始下一次操作才清。
  const [actionNotice, setActionNotice] = useState<{ title: string; failures: string[] } | null>(null)
  const [actionPending, setActionPending] = useState<'cancel' | 'retry' | 'resubmit' | 'batch' | null>(null)
  const [submitHovered, setSubmitHovered] = useState(false)
  // 会再计费的重提先在触发按钮旁确认;确认后才真正发请求。
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
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
  const batchSettledCount = batchMembers.filter((member) => !memberInFlight(member.state)).length
  const isBatch = batchMembers.length > 1
  const inFlightCount = batchMembers.length - batchSettledCount
  const currentSource = batchMembers.find((member) => member.job_id === jobId)?.source
    ?? sourceItems(job)[0]
    ?? ''
  // 排队或还在跑的不参与重跑:它本来就要跑,再点一次只会白花一次额度。
  const rerunable = useMemo(
    () => batchMembers.filter((member) => !memberInFlight(member.state)),
    [batchMembers],
  )
  const failedIds = useMemo(
    () => rerunable.filter((member) => member.state === 'failed').map((member) => member.job_id),
    [rerunable],
  )
  const batchTerminal = batchMembers.length > 1 && batchMembers.every((member) => !memberInFlight(member.state))
  // 悬停展开,但**不只靠悬停**:纯 hover 菜单键盘用不了,鼠标移向菜单项的途中也容易掠出
  // 容器把菜单收掉(实测就是这么翻的)。点箭头可以「钉住」,钉住后移开不收。
  const [rerunMenuOpen, setRerunMenuOpen] = useState(false)
  const [rerunMenuPinned, setRerunMenuPinned] = useState(false)
  const rerunMenuPinnedRef = useRef(false)
  const rerunMenuRef = useRef<HTMLDivElement | null>(null)
  const rerunSurfaceRef = useRef<HTMLDivElement | null>(null)
  const rerunMenuCloseTimer = useRef<number | null>(null)
  const rerunMenuHoverTimer = useRef<number | null>(null)
  // 菜单节点还在树上(含收起动画期间)就保持玻璃材质,否则收起一开始材质先退回普通模糊,看着一跳。
  const [rerunMenuMounted, setRerunMenuMounted] = useState(false)
  const [rerunMenuPosition, setRerunMenuPosition] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const [rerunPicked, setRerunPicked] = useState<Set<string> | null>(null)
  // 确认气泡里的内容是按点击当时的勾选算的,气泡打开期间菜单整个锁住:所有打开入口和勾选都看这一个状态。
  const confirmOpen = confirm !== null
  const confirmOpenRef = useRef(false)
  confirmOpenRef.current = confirmOpen
  const skipFocusOpenRef = useRef(false)
  const caretPressedInConfirmRef = useRef(false)
  useGlassMenuSurface(rerunSurfaceRef, rerunMenuMounted)
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
    setConfirm(null)
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
    const width = Math.min(Math.max(anchor.width, 360), Math.max(220, window.innerWidth - margin * 2))
    const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - margin - width))
    const bottom = Math.max(margin, window.innerHeight - anchor.top + 6)
    setRerunMenuPosition({ left, bottom, width })
  }, [])

  const clearRerunMenuHover = useCallback(() => {
    if (rerunMenuHoverTimer.current !== null) {
      window.clearTimeout(rerunMenuHoverTimer.current)
      rerunMenuHoverTimer.current = null
    }
  }, [])

  const openRerunMenu = useCallback(() => {
    if (confirmOpenRef.current) return
    clearRerunMenuClose()
    clearRerunMenuHover()
    updateRerunMenuPosition()
    setRerunMenuMounted(true)
    setRerunMenuOpen(true)
  }, [clearRerunMenuClose, clearRerunMenuHover, updateRerunMenuPosition])

  // 悬停打开先等一小会儿,鼠标只是划过按钮时不闪一下;菜单已经开着(含收起前的延迟里)就只取消收起。
  const hoverOpenRerunMenu = () => {
    clearRerunMenuClose()
    if (rerunMenuOpen || confirmOpenRef.current || rerunMenuHoverTimer.current !== null) return
    rerunMenuHoverTimer.current = window.setTimeout(() => {
      rerunMenuHoverTimer.current = null
      openRerunMenu()
    }, 100)
  }

  const scheduleRerunMenuClose = useCallback(() => {
    clearRerunMenuHover()
    if (rerunMenuPinnedRef.current) return
    clearRerunMenuClose()
    rerunMenuCloseTimer.current = window.setTimeout(() => {
      setRerunMenuOpen(false)
      rerunMenuCloseTimer.current = null
    }, 160)
  }, [clearRerunMenuClose, clearRerunMenuHover])

  useEffect(() => () => {
    clearRerunMenuClose()
    clearRerunMenuHover()
  }, [clearRerunMenuClose, clearRerunMenuHover])

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
  const rebillCount = rerunable.filter((member) => selection.has(member.job_id) && producedResult(member.state)).length
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
    const batchActive = batchMembers.some((member) => memberInFlight(member.state))
    if (!job || (!ACTIVE_STATUSES.has(job.status) && !batchActive)) return
    const timer = window.setInterval(load, 1500)
    return () => window.clearInterval(timer)
  }, [batchMembers, job, load])

  const sources = useMemo(() => sourceItems(job), [job])
  const active = !!job && ACTIVE_STATUSES.has(job.status)
  const interrupted = !!job && INTERRUPTED_STATUSES.has(job.status)
  const completedSuccessfully = !!job && SUCCESS_STATUSES.has(job.status)
  const partial = job?.status === 'partial'
  const failed = !!job && (FAILED_STATUSES.has(job.status) || (!active && !interrupted && !completedSuccessfully))
  const stopping = job?.status === 'cancel_requested'
  const showStop = isBatch ? inFlightCount > 0 : active
  const stopBusy = isBatch
    ? batchMembers.every((member) => !memberInFlight(member.state) || member.status === 'cancel_requested')
    : stopping
  const rerunning = active && !!job && (!!job.parent_job_id || isVkJobRerun(job.job_id))
  // 批次的顶部状态汇总全部成员,不看打开的这一条:批里第一个小任务跑完时整批还在跑,
  // 顶部不能先说「已完成」。停止按钮同理:批量任务停的是整批在跑的小任务,不要求打开的这一条
  // 在跑,重提并入分体按钮;单视频任务的停止、重试、再次提交只作用于它自己,按它的状态显隐。
  const badge = batchMembers.length > 1
    ? batchBadge(batchMembers)
    : {
      className: failed ? 'is-failed' : interrupted ? 'is-interrupted' : rerunning ? 'is-rerunning' : active ? 'is-running' : partial ? 'is-partial' : 'is-completed',
      label: failed ? '失败' : interrupted ? '已中断' : stopping ? '正在停止' : rerunning ? '重跑中' : active ? '正在执行' : partial ? '部分完成' : '已完成',
    }
  const progress = job
    ? stageProgress(job, completedSuccessfully)
    : { completed: 0, total: 4, percent: 0, currentLabel: '准备处理' }

  const runAction = async (action: 'cancel' | 'retry' | 'resubmit') => {
    if (!jobId || !job) return
    setActionPending(action)
    setError(null)
    setActionNotice(null)
    try {
      if (action === 'cancel') {
        if (isBatch && job.batch_id) {
          const { cancelled } = await postVkBatchCancel(job.batch_id, baseUrl)
          if (cancelled.length === 0) {
            setActionNotice({ title: '没有可以停止的小任务', failures: ['可能已经结束或刚重启过'] })
          }
        } else {
          await postVkJobAction(jobId, 'cancel', baseUrl)
        }
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
      setActionNotice({ title: ACTION_FAILURE_TITLES[action], failures: [detailError(actionError)] })
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
    setActionNotice(null)
    const failures: string[] = []
    let attempted = 0
    let firstNewJobId: string | null = null
    for (const member of batchMembers) {
      if (!selection.has(member.job_id)) continue
      if (memberInFlight(member.state)) continue    // 排队或还在跑的没什么可重跑的
      attempted += 1
      try {
        // 两条路都走 job action,**都会把 parent_job_id 指回被重跑的那条**:
        //   失败/中断 → retry(沿用请求,走缓存)
        //   已完成   → refresh(同一请求,显式绕过缓存——重跑一条已完成的,要的就是重算)
        // 原先"已完成"那支是 postVkJob 另开一条新任务:batch_id 虽然带上了,但**没有
        // parent**,于是前端按重试链折叠时认不出它是同一个视频的又一次尝试,小任务
        // 列表就一次比一次长(用户看到 2 条变 3 条、3 条变 4 条)。
        const result = await postVkJobAction(
          member.job_id, producedResult(member.state) ? 'refresh' : 'retry', baseUrl,
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
    if (firstNewJobId) {
      onJobChange?.(firstNewJobId)
      onJobRefresh?.()
    }
    else await load()
    // 部分失败要说清是哪几条,否则用户只知道"没全跑起来"却不知道差在哪。
    if (failures.length > 0) {
      const title = failures.length === attempted ? '所选视频都未能重跑' : '部分视频未能重跑'
      setActionNotice({ title, failures })
    }
  }

  /** 批量主按钮:所选里有已有结果的成员会走 refresh 再计费,先确认;只有失败或中断的直接提交。 */
  const requestRerun = (anchor: HTMLElement) => {
    clearRerunMenuHover()
    if (rebillCount === 0) {
      void rerunSelected(selection)
      return
    }
    const picked = rerunable.filter((member) => selection.has(member.job_id))
    const rebilled = picked.filter((member) => producedResult(member.state))
    const resumeCount = picked.length - rebilled.length
    setRerunMenuOpen(false)
    setRerunMenuPinned(false)
    rerunMenuPinnedRef.current = false
    setConfirm({
      anchor,
      title: `重新提交 ${picked.length} 个小任务？`,
      body: [
        `${rebilled.length} 个已有结果，会重新解析并再计费：${rebilled.map((member) => `小任务${batchMembers.indexOf(member) + 1}`).join('、')}`,
        ...(resumeCount > 0 ? [`${resumeCount} 个失败或中断的，会从中断处接着跑`] : []),
      ],
      confirmLabel: '确认重新提交',
      onConfirm: () => { void rerunSelected(selection) },
    })
  }

  // 气泡关闭(取消、Esc、点外部、确认)时 ConfirmPopover 先把焦点还给主按钮;点在空白处的话,
  // 浏览器会把焦点挪走,它再在下一拍补一次。补的那一次发生在气泡已经卸掉之后,不能当成用户聚焦
  // 去弹菜单,所以让 onFocus 跳过一次。标记在那一拍之后清掉:焦点若去了别处,不会残留到下次真聚焦。
  const closeConfirm = () => {
    skipFocusOpenRef.current = true
    window.setTimeout(() => { skipFocusOpenRef.current = false }, 0)
    setConfirm(null)
  }

  /** 单视频「再次提交任务」:done 与 partial 走 refresh 会再计费,先确认;中断的走 retry,直接提交。 */
  const requestResubmit = (anchor: HTMLElement) => {
    if (!completedSuccessfully) {
      void runAction('resubmit')
      return
    }
    setConfirm({
      anchor,
      title: '再次提交这个任务？',
      body: ['已有结果，会重新解析并再计费'],
      confirmLabel: '确认再次提交',
      onConfirm: () => { void runAction('resubmit') },
    })
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
          <AppNotificationStack onOverflow={(count) => setCopyNotices((notices) => notices.slice(0, Math.max(1, notices.length - count)))}>
            {copyNotices.map((id) => <AppAlert
              key={id}
              testId="vk-copy-notice"
              tone="success"
              title="已复制链接"
              durationMs={1_000}
              onExpire={() => setCopyNotices((notices) => notices.filter((notice) => notice !== id))}
            />)}
          </AppNotificationStack>
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

      {actionNotice && (
        <AppAlert
          testId="vk-task-detail-action-notice"
          tone="error"
          className="vk-task-detail-action-notice"
          title={actionNotice.title}
          description={actionNotice.failures.join('\n')}
          onClose={() => setActionNotice(null)}
          closeLabel="关闭提示"
        />
      )}
      {error && <div className="vk-task-detail-error" role="alert">{error}</div>}
      {!job && !error && <div className="vk-task-detail-loading">正在读取任务详情…</div>}

      {job && (
        <div className="vk-task-detail-body">
          <div className="vk-task-detail-summary">
            <span role="status" aria-live="polite" className={`vk-task-detail-badge ${badge.className}`}>
              {badge.label}
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
                    elapsed={elapsedLabel(member.state, member.submitted_at, member.finished_at)}
                    current={member.job_id === jobId}
                    expanded={expandedTaskIds.has(member.job_id)}
                    onToggle={() => toggleTask(member.job_id)}
                    onCopy={copyLink}
                    contentVersion={member.job_id === jobId ? job : baseUrl}
                  >
                    <MemoTaskMemberProgress jobId={member.job_id} baseUrl={baseUrl} currentJob={member.job_id === jobId ? job : null} />
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
                        elapsed={elapsedLabel(batchState(job.status), job.submitted_at, job.finished_at)}
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

          {batchMembers.length > 1 && job.batch_id && (
            <VkStorylineSection
              key={job.batch_id}
              batchId={job.batch_id}
              baseUrl={baseUrl}
              parsedCount={batchMembers.filter((member) => producedResult(member.state)).length}
              renderRunProgress={(run) => (
                <TaskProgressDetails
                  job={run}
                  phases={STORYLINE_PHASES}
                  progress={stageProgress(run, SUCCESS_STATUSES.has(run.status), STORYLINE_PHASES, '串联完成')}
                />
              )}
              onView={() => {
                window.dispatchEvent(new CustomEvent(VK_OPEN_OUTPUT_EVENT, {
                  detail: { jobId, title: '解析结果', storyline: true },
                }))
              }}
            />
          )}

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

          {job.error && <div className="vk-task-detail-error"><VkFailureNote raw={job.error} /></div>}

          <div className="vk-task-detail-actions">
            {/* 整批重跑。放在最前:从批量行点进来的人,想要的多半是"这一批再来一次",
                而不是只重跑落在眼前的这一条。条数写在按钮上,因为已完成的批量重跑会
                再花一次额度——那是明知的取舍(整批失败时需要一键重来),但不能让人误点。 */}
            {isBatch && rerunable.length >= 1 && (
              <div
                className="vk-task-batch-rerun"
                data-terminal-batch={batchTerminal || undefined}
                ref={rerunMenuRef}
                onMouseEnter={hoverOpenRerunMenu}
                onMouseLeave={scheduleRerunMenuClose}
              >
                {rerunMenuPosition && typeof document !== 'undefined' && createPortal(
                  <AnimatePresence onExitComplete={() => setRerunMenuMounted(false)}>
                  {rerunMenuOpen && <motion.div
                    ref={rerunSurfaceRef}
                    key="rerun-menu"
                    className="vk-task-operation-menu vk-task-batch-rerun-menu glass-menu-effect"
                    role="menu"
                    style={{ ...rerunMenuPosition, originY: 1 }}
                    onMouseEnter={openRerunMenu}
                    onMouseLeave={scheduleRerunMenuClose}
                    {...glassPopMotion(reduceMotion)}
                  >
                    <div className="vk-task-batch-rerun-list scroll-fade">
                      {batchMembers.map((member, index) => {
                        const disabled = memberInFlight(member.state)
                        const checked = selection.has(member.job_id)
                        const source = member.source || member.job_id
                        return (
                          <button
                            key={member.job_id}
                            type="button"
                            role="menuitemcheckbox"
                            className={`vk-task-batch-rerun-option is-${member.state}`}
                            data-state={member.state}
                            data-color={BATCH_STATE_COLORS[member.state]}
                            aria-checked={checked}
                            disabled={disabled}
                            title={source}
                            onClick={() => {
                              if (confirmOpenRef.current) return
                              const next = new Set(selection)
                              if (next.has(member.job_id)) next.delete(member.job_id)
                              else next.add(member.job_id)
                              setRerunPicked(next)
                            }}
                          >
                            {checked ? <Check size={15} aria-hidden="true" /> : <span className="vk-task-batch-rerun-blank" />}
                            <b>小任务{index + 1}</b>
                            <span className="vk-task-batch-rerun-source">{compactSource(source)}</span>
                            <span className={`vk-task-detail-batch-status is-${member.state}`} data-state={member.state}>
                              {BATCH_STATE_LABELS[member.state]}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="vk-task-batch-rerun-footer">
                      <button
                        type="button"
                        role="menuitem"
                        className="vk-task-batch-rerun-all"
                        onClick={() => {
                          if (confirmOpenRef.current) return
                          setRerunPicked(
                            selectedCount === rerunable.length
                              ? new Set(failedIds)
                              : new Set(rerunable.map((member) => member.job_id)),
                          )
                        }}
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                        <span>{selectedCount === rerunable.length ? '只选失败的' : '全选'}</span>
                      </button>
                      {/* 重跑已有结果的小任务会再花一次额度,选之前得看得见;提示随勾选实时变化 */}
                      {rebillCount > 0 && (
                        <span className="vk-task-batch-rerun-hint">其中 {rebillCount} 个已有结果，重跑会再计费</span>
                      )}
                    </div>
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
                  onFocus={() => {
                    if (skipFocusOpenRef.current) {
                      skipFocusOpenRef.current = false
                      return
                    }
                    openRerunMenu()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRerunMenuOpen(false)
                    if (event.key === 'ArrowUp') { event.preventDefault(); openRerunMenu() }
                  }}
                  onClick={(event) => requestRerun(event.currentTarget)}
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
                  disabled={actionPending !== null || confirmOpen}
                  onPointerDown={() => { caretPressedInConfirmRef.current = confirmOpenRef.current }}
                  onClick={() => {
                    // 确认期间按下小箭头:这一下落在气泡外面,会先把气泡收掉、小箭头随即恢复可点,
                    // 随后的 click 不能再当成展开菜单。
                    if (caretPressedInConfirmRef.current) {
                      caretPressedInConfirmRef.current = false
                      return
                    }
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
            {showStop && (
              <button type="button" className="vk-task-stop-button" disabled={stopBusy || actionPending !== null} onClick={() => { void runAction('cancel') }}>
                <Square size={13} fill="currentColor" aria-hidden="true" />
                <span>
                  {stopBusy || actionPending === 'cancel'
                    ? '正在停止…'
                    : isBatch ? `停止全部（${inFlightCount} 个进行中）` : '停止任务'}
                </span>
              </button>
            )}
            {!isBatch && failed && (
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
            {!isBatch && (completedSuccessfully || interrupted) && (
              <motion.button
                type="button"
                className="vk-task-submit-again-button"
                disabled={actionPending !== null}
                onMouseEnter={() => setSubmitHovered(true)}
                onMouseLeave={() => setSubmitHovered(false)}
                onClick={(event) => requestResubmit(event.currentTarget)}
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
      <AnimatePresence>
        {confirm && (
          <ConfirmPopover
            key="confirm"
            anchor={confirm.anchor}
            title={confirm.title}
            body={confirm.body}
            confirmLabel={confirm.confirmLabel}
            onCancel={closeConfirm}
            onConfirm={() => {
              closeConfirm()
              confirm.onConfirm()
            }}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

export default VkTaskDetailSidebar
