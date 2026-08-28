import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Eye, RefreshCw, Send, Square, X } from 'lucide-react'
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
import { isVkJobRerun, markVkJobAsRerun, vkTaskNumberFor, VK_OPEN_OUTPUT_EVENT } from './taskUiState'
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

/** 批量成员的来源:公开请求里的 source(一条 job 一个视频),取不到就退回 job_id。 */
function memberSource(row: { request?: { source?: string } }): string {
  const source = row.request?.source
  return typeof source === 'string' ? source.split(/\r?\n/)[0].trim() : ''
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
  const [actionPending, setActionPending] = useState<'cancel' | 'retry' | 'resubmit' | null>(null)
  const [submitHovered, setSubmitHovered] = useState(false)
  const [batchMembers, setBatchMembers] = useState<
    { job_id: string; source: string; state: BatchState }[]
  >([])
  const taskNumber = useMemo(() => vkTaskNumberFor(jobId), [jobId])
  const batchDoneCount = batchMembers.filter((member) => member.state !== 'running').length
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
        setBatchMembers(
          siblings
            .filter((row) => row.batch_id === nextJob.batch_id)
            .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at))
            .map((row) => ({
              job_id: row.job_id,
              source: memberSource(row as { request?: { source?: string } }),
              state: batchState(row.status),
            })),
        )
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
      }, baseUrl)
      markVkJobAsRerun(result.job_id)
      onJobChange?.(result.job_id)
    } catch (actionError) {
      setError(detailError(actionError))
    } finally {
      setActionPending(null)
    }
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
          {/* 列表上认的是编号，详情页原先只给 UUID，两边对不上号。编号在前，UUID 退成
              次要信息——它仍要留着，排查问题时日志里只有 UUID。 */}
          {taskNumber === null
            ? <strong>{job?.job_id ?? jobId}</strong>
            : (
              <>
                <strong data-testid="vk-task-detail-number">任务 {taskNumber}</strong>
                <code className="vk-task-detail-job-id">{job?.job_id ?? jobId}</code>
              </>
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
                  {' '}共 {batchMembers.length} 个视频 · 已完成 {batchDoneCount}/{batchMembers.length}
                </span>
              )}
            </h3>
            {batchMembers.length > 1
              ? (
                <ol className="vk-task-detail-batch-list">
                  {batchMembers.map((member) => (
                    <li key={member.job_id}>
                      <button
                        type="button"
                        data-current={member.job_id === jobId || undefined}
                        onClick={() => onJobChange?.(member.job_id)}
                      >
                        <span className="vk-task-detail-batch-source">{member.source || member.job_id}</span>
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
