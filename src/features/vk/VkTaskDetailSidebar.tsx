import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Eye, RefreshCw, Send, Square, X } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  fetchVkJob,
  fetchVkProviderSettings,
  postVkJob,
  postVkJobAction,
} from '../../host/vkClient'
import type { VkJobView, VkProviderSettings } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { isVkJobRerun, markVkJobAsRerun, VK_OPEN_OUTPUT_EVENT } from './taskUiState'
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

function stageProgress(job: VkJobView, successful: boolean): {
  completed: number
  total: number
  percent: number
  currentLabel: string
} {
  const phases = job.request?.preset === 'quick-summary' ? QUICK_SUMMARY_PHASES : FULL_ANALYSIS_PHASES
  const rawCompleted = Array.isArray(job.progress?.completed_stages) ? job.progress.completed_stages : []
  const completedStages = new Set(rawCompleted.filter((stage): stage is string => typeof stage === 'string'))
  let completed = 0
  if (successful) completed = phases.length
  else {
    for (const phase of phases) {
      if (!phase.stages.every((stage) => completedStages.has(stage))) break
      completed += 1
    }
  }
  const current = phases[Math.min(completed, phases.length - 1)]
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
          <strong>{job?.job_id ?? jobId}</strong>
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
                    <p>{attempt.stage} · {attempt.model_reported || attempt.model_requested} · {Math.max(0, attempt.latency_ms)} ms</p>
                    {attempt.switch_reason === 'previous_route_transient_error' && (
                      <p className="vk-model-switch-reason">上一通道发生临时故障，已按你的备用顺序切换</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="vk-task-detail-section">
            <h3>提交内容</h3>
            {sources.length > 0
              ? <ol>{sources.map((source) => <li key={source}>{source}</li>)}</ol>
              : <p>未返回来源信息</p>}
          </div>

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
                whileTap={{ scale: 0.96 }}
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
                whileTap={{ scale: 0.96 }}
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
          </div>

          {completedSuccessfully && primaryOutput(job) && (
            <div className="vk-task-detail-section">
              <h3>解析结果</h3>
              <div className="vk-task-output-list">
                <button type="button" onClick={() => {
                  const output = primaryOutput(job)
                  if (output) window.dispatchEvent(new CustomEvent(VK_OPEN_OUTPUT_EVENT, {
                    detail: { outputId: output.id, title: '解析结果' },
                  }))
                }}>
                  <span>{primaryOutput(job)?.label}</span>
                  <Eye size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default VkTaskDetailSidebar
