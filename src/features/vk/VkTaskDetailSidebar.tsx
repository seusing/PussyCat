import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ExternalLink, RefreshCw, Send, Square, X } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  downloadVkOutput,
  fetchVkJob,
  fetchVkProviderSettings,
  postVkJob,
  postVkJobAction,
} from '../../host/vkClient'
import type { VkJobView, VkProviderSettings } from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'
import { isVkJobRerun, markVkJobAsRerun } from './taskUiState'
import './VkTaskDetailSidebar.css'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancel_requested', 'submitted', 'processing'])
const FAILED_STATUSES = new Set(['failed', 'quarantined', 'error'])
const INTERRUPTED_STATUSES = new Set(['cancelled', 'interrupted', 'completed_after_cancel_request'])
const SUCCESS_STATUSES = new Set(['done', 'partial'])

function detailError(error: unknown): string {
  if (error instanceof HostRequestError) return error.summary
  if (error instanceof Error) return error.message
  return '任务详情获取失败'
}

function numericProgress(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function sourceItems(job: VkJobView | null): string[] {
  const source = job?.request?.source
  if (typeof source !== 'string') return []
  return [...new Set(source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
}

function primaryOutputs(job: VkJobView): Array<{ id: string; label: string }> {
  const outputs: Array<{ id: string; label: string }> = []
  if (job.outputs?.note_path) outputs.push({ id: job.outputs.note_path, label: '知识笔记' })
  if (job.outputs?.audit_path) outputs.push({ id: job.outputs.audit_path, label: '证据审计' })
  for (const artifact of job.outputs?.product_artifacts ?? []) {
    if (artifact.markdown) outputs.push({ id: artifact.markdown, label: `${artifact.preset} MD` })
  }
  return outputs
}

function configuredModelName(job: VkJobView, settings: VkProviderSettings | null): string {
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

  const load = useCallback(async () => {
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
      setJob(nextJob)
      setProviders(nextProviders)
      setError(null)
    } catch (loadError) {
      setError(detailError(loadError))
    }
  }, [jobId, baseUrl])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return
    const timer = window.setInterval(() => { void load() }, 1500)
    return () => window.clearInterval(timer)
  }, [job, load])

  const sources = useMemo(() => sourceItems(job), [job])
  const active = !!job && ACTIVE_STATUSES.has(job.status)
  const interrupted = !!job && INTERRUPTED_STATUSES.has(job.status)
  const completedSuccessfully = !!job && SUCCESS_STATUSES.has(job.status)
  const failed = !!job && (FAILED_STATUSES.has(job.status) || (!active && !interrupted && !completedSuccessfully))
  const stopping = job?.status === 'cancel_requested'
  const rerunning = active && !!job && (!!job.parent_job_id || isVkJobRerun(job.job_id))
  const total = job
    ? Math.max(1, numericProgress(job.progress?.total_links) ?? (sources.length || 1))
    : 1
  const completed = job
    ? Math.min(total, numericProgress(job.progress?.completed_links) ?? (active ? 0 : completedSuccessfully ? total : 0))
    : 0
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

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
        if (nextJobId) onJobChange?.(nextJobId)
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
            <span className={`vk-task-detail-badge ${failed ? 'is-failed' : interrupted ? 'is-interrupted' : rerunning ? 'is-rerunning' : active ? 'is-running' : 'is-completed'}`}>
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
                <strong>{completed} / {total}</strong>
                <span>链接已完成</span>
              </div>
            </div>
          )}

          <div className="vk-task-progress-meta">
            <span>处理进度</span>
            <strong>{percent}%</strong>
          </div>
          <div
            className="vk-task-progress-track"
            role="progressbar"
            aria-label="链接处理进度"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={completed}
          >
            <span style={{ width: `${percent}%` }} />
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

          {completedSuccessfully && primaryOutputs(job).length > 0 && (
            <div className="vk-task-detail-section">
              <h3>解析结果</h3>
              <div className="vk-task-output-list">
                {primaryOutputs(job).map((output) => (
                  <button key={output.id} type="button" onClick={() => { void downloadVkOutput(output.id, baseUrl) }}>
                    <span>{output.label}</span>
                    <ExternalLink size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default VkTaskDetailSidebar
