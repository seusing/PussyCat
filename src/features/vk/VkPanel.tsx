// 「视频解析」整页模块(vk-shell-v1 契约消费端)。
//
// 边界:React 只访问 Node 的 /vk/v1/* 代理,永不直连 Python、永不接触 sidecar
// token。进度只显示真实状态/已耗时/实际费用,不造百分比(拍板 4)。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { HostRequestError } from '../../host/errors'
import {
  downloadVkOutput,
  fetchVkDiagnostic,
  fetchVkHealth,
  fetchVkJob,
  fetchVkJobs,
  fetchVkRuntimeStatus,
  postVkRuntimeAdopt,
  postVkRuntimeDetect,
  postVkJob,
  postVkJobAction,
  postVkPreview,
  postVkQuery,
  postVkRuntimeInstall,
} from '../../host/vkClient'
import type {
  VkHealth,
  VkJobRow,
  VkJobView,
  VkPreviewProjection,
  VkProcessingRequest,
  VkQueryAnswer,
  VkRuntimeStatus,
  VkRuntimeCandidate,
} from '../../host/vkClient'
import { estimateForPreset, formatEstimate } from './vkEstimates'
import { VkCostConfirmDialog, type PendingVkSubmit } from './VkCostConfirmDialog'

const PRESETS = ['quick-summary', 'course-learning', 'interview-analysis', 'science-explainer']
const CONTENT_TYPES = ['auto', 'course_lecture', 'interview_podcast', 'science_explainer', 'tutorial', 'other_knowledge', 'generic_knowledge']
const MEDIA_POLICIES = ['subtitle_only', 'audio_transcript', 'low_res_visual', 'video_required']
const QUALITY_PROFILES = ['fast', 'balanced', 'thorough']
const BUDGET_PROFILES = ['economy', 'standard', 'quality']
const CAPABILITIES = ['word_timestamps', 'speaker_diarization', 'visual_evidence', 'query_ready']

const PRESET_LABELS: Record<string, string> = {
  'quick-summary': '快速总结',
  'course-learning': '课程学习笔记',
  'interview-analysis': '访谈观点分析',
  'science-explainer': '科普知识梳理',
}
const CONTENT_TYPE_LABELS: Record<string, string> = {
  auto: '自动判断', course_lecture: '课程/讲座', interview_podcast: '访谈/播客',
  science_explainer: '科普讲解', tutorial: '教程', other_knowledge: '其他知识内容', generic_knowledge: '通用知识内容',
}
const MEDIA_POLICY_LABELS: Record<string, string> = {
  subtitle_only: '仅使用平台字幕', audio_transcript: '字幕缺失时转写音频',
  low_res_visual: '加入低清视觉证据', video_required: '下载完整视频并分析画面',
}
const QUALITY_LABELS: Record<string, string> = { fast: '快速', balanced: '均衡', thorough: '深入' }
const BUDGET_LABELS: Record<string, string> = { economy: '经济', standard: '标准', quality: '质量优先' }
const CAPABILITY_LABELS: Record<string, string> = {
  word_timestamps: '词级时间定位', speaker_diarization: '区分说话人',
  visual_evidence: '提取视觉证据', query_ready: '加入知识库检索',
}
const OUTPUT_LABELS: Record<string, string> = {
  markdown_note: '知识笔记', quick_summary: '快速摘要', concept_cards: '概念卡片',
  qa_cards: '问答卡片', interview_analysis: '访谈观点', science_explainer: '科普梳理',
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancel_requested'])

function errorText(error: unknown, fallback: string): string {
  if (error instanceof HostRequestError) {
    return error.reasonCode ? `${error.summary}(${error.reasonCode})` : error.summary
  }
  if (error instanceof Error) return error.message || fallback
  return fallback
}

function elapsedLabel(row: { submitted_at: string; finished_at: string | null }): string {
  const start = Date.parse(row.submitted_at)
  if (Number.isNaN(start)) return '—'
  const end = row.finished_at ? Date.parse(row.finished_at) : Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  cancel_requested: '取消请求已发出',
  cancelled: '已取消',
  completed_after_cancel_request: '取消前已完成',
  failed: '失败',
  done: '已完成',
  partial: '部分完成',
  quarantined: '已隔离',
  interrupted: '已中断(重启回收)',
  submitted: '已提交',
}

const fieldClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
const fieldStyle = { background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const
const outlineButton = 'rounded-lg px-2 py-1 text-xs disabled:opacity-50'
const outlineStyle = { border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const

export function VkPanel({ baseUrl }: { baseUrl?: string }) {
  const base = baseUrl
  // —— 健康(BrowserBridgeStatus 姿势:进入时查一次 + 手动重检;前端只渲染不解释)——
  const [health, setHealth] = useState<VkHealth | null>(null)
  const [healthChecking, setHealthChecking] = useState(false)
  const healthGen = useRef(0)
  const checkHealth = useCallback(async () => {
    const gen = ++healthGen.current
    setHealthChecking(true)
    try {
      const result = await fetchVkHealth(base)
      if (gen === healthGen.current) setHealth(result)
    } catch {
      if (gen === healthGen.current) setHealth(null)
    } finally {
      if (gen === healthGen.current) setHealthChecking(false)
    }
  }, [base])
  useEffect(() => { void checkHealth() }, [checkHealth])

  // —— 首启 runtime 安装(v2 阶段3):sidecar 未安装时给安装卡;
  //    installing 期间 2s 轮询真实安装输出(不造百分比)——
  const [runtime, setRuntime] = useState<VkRuntimeStatus | null>(null)
  const [runtimeSource, setRuntimeSource] = useState<'dedicated' | 'external' | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [runtimeCandidates, setRuntimeCandidates] = useState<VkRuntimeCandidate[] | null>(null)
  const [runtimeDetecting, setRuntimeDetecting] = useState(false)
  const [runtimeDetectError, setRuntimeDetectError] = useState<string | null>(null)
  const [runtimeAdoptError, setRuntimeAdoptError] = useState<string | null>(null)
  const [runtimeAdoptingPath, setRuntimeAdoptingPath] = useState<string | null>(null)
  const [runtimeAdoptNotice, setRuntimeAdoptNotice] = useState<string | null>(null)
  const [showIncompatibleRuntimes, setShowIncompatibleRuntimes] = useState(false)
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false)
  const previousRuntimeState = useRef<string | null>(null)
  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await fetchVkRuntimeStatus(base))
    } catch {
      setRuntime(null)
    }
  }, [base])
  useEffect(() => {
    if (health) void refreshRuntime()
  }, [health, refreshRuntime])
  useEffect(() => {
    if (runtime?.state !== 'installing') return
    const timer = setInterval(() => { void refreshRuntime() }, 2000)
    return () => clearInterval(timer)
  }, [runtime?.state, refreshRuntime])
  useEffect(() => {
    const state = runtime?.state ?? null
    if (state === 'installed' && previousRuntimeState.current !== 'installed') void checkHealth()
    previousRuntimeState.current = state
  }, [runtime?.state, checkHealth])
  const startInstall = async () => {
    setInstallError(null)
    try {
      setRuntimeSource('dedicated')
      setRuntime(await postVkRuntimeInstall(base))
    } catch (error) {
      setInstallError(errorText(error, '安装启动失败'))
    }
  }
  const detectRuntime = async () => {
    setRuntimeDetecting(true)
    setRuntimeDetectError(null)
    try {
      const result = await postVkRuntimeDetect(base)
      setRuntimeCandidates(result.candidates)
      setRuntimeDetailsOpen(true)
    } catch (error) {
      setRuntimeDetectError(errorText(error, '已有环境检测失败'))
    } finally {
      setRuntimeDetecting(false)
    }
  }
  const adoptRuntime = async (candidate: VkRuntimeCandidate) => {
    setRuntimeAdoptError(null)
    setRuntimeAdoptNotice(null)
    setRuntimeAdoptingPath(candidate.pythonPath)
    try {
      const adopted = await postVkRuntimeAdopt(candidate.pythonPath, base)
      setRuntime(adopted)
      setRuntimeSource(adopted.source === 'app-owned' ? 'dedicated' : 'external')
      setRuntimeAdoptNotice(`已切换至 ${candidate.pythonPath}`)
      setRuntimeCandidates((items) => items?.map((item) => ({
        ...item,
        active: item.pythonPath === candidate.pythonPath,
      })) ?? null)
      await checkHealth()
    } catch (error) {
      setRuntimeAdoptError(errorText(error, '已有环境接入失败'))
    } finally {
      setRuntimeAdoptingPath(null)
    }
  }

  // —— 表单(组件本地;store 只承担跨模块 handoff)——
  const [source, setSource] = useState('')
  const [preset, setPreset] = useState('quick-summary')
  const [contentType, setContentType] = useState('')
  const [mediaPolicy, setMediaPolicy] = useState('')
  const [quality, setQuality] = useState('')
  const [budgetProfile, setBudgetProfile] = useState('')
  const [caps, setCaps] = useState<string[]>([])
  const [audit, setAudit] = useState(false)
  const [maxCost, setMaxCost] = useState('')
  const [provenance, setProvenance] = useState<{ commandKey: string; collectedAt: number } | null>(null)

  const handoff = useAppStore((s) => s.vkHandoff)
  useEffect(() => {
    if (!handoff) return
    setSource(handoff.url)
    setProvenance({ commandKey: handoff.commandKey, collectedAt: handoff.collectedAt })
    useAppStore.getState().clearVkHandoff()
  }, [handoff])

  // —— 预检 → 费用确认 → 提交 ——
  const [preview, setPreview] = useState<VkProcessingRequest | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingSubmit, setPendingSubmit] = useState<PendingVkSubmit | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 投影是唯一携带原始 URL 的通道(1.3.0 凭据边界):preview 用它取公开回显,
  // submit 用它执行——preview 响应是脱敏投影,不能作为提交载荷。
  const buildProjection = (): VkPreviewProjection => ({
    source: source.trim(),
    preset,
    ...(contentType ? { content_type: contentType } : {}),
    ...(mediaPolicy ? { media_policy: mediaPolicy } : {}),
    ...(quality ? { quality_profile: quality } : {}),
    ...(budgetProfile ? { budget_profile: budgetProfile } : {}),
    ...(caps.length ? { capabilities: caps } : {}),
    ...(audit ? { audit: true } : {}),
    ...(maxCost.trim() ? { max_cost_cny: Number(maxCost) } : {}),
    ...(provenance
      ? {
          user_metadata: {
            origin: 'opencli-result',
            source_command: provenance.commandKey,
            collected_at: new Date(provenance.collectedAt).toISOString(),
          },
        }
      : {}),
  })

  const doPreview = async () => {
    setPreviewError(null)
    setPreview(null)
    try {
      setPreview(await postVkPreview(buildProjection(), base))
    } catch (error) {
      setPreviewError(errorText(error, '预检失败'))
    }
  }

  const requestSubmit = () => {
    if (!preview) return
    setPendingSubmit({ request: preview, estimate: estimateForPreset(preview.preset) })
  }

  const confirmSubmit = async () => {
    if (!pendingSubmit) return
    setSubmitError(null)
    try {
      await postVkJob({
        ...buildProjection(),
        idempotency_key: crypto.randomUUID(),
        client_job_id: crypto.randomUUID(),
      }, base)
      setPendingSubmit(null)
      setPreview(null)
      await refreshJobs()
    } catch (error) {
      setPendingSubmit(null)
      setSubmitError(errorText(error, '任务提交失败'))
    }
  }

  // —— 任务列表与详情(vk.db 真源;轮询只在有活跃任务时)——
  const [jobs, setJobs] = useState<VkJobRow[]>([])
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [selectedJob, setSelectedJob] = useState<VkJobView | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const jobsGen = useRef(0)

  const refreshJobs = useCallback(async () => {
    const gen = ++jobsGen.current
    try {
      const rows = await fetchVkJobs(base)
      if (gen === jobsGen.current) {
        setJobs(rows)
        setJobsError(null)
      }
    } catch (error) {
      if (gen === jobsGen.current) setJobsError(errorText(error, '任务列表获取失败'))
    }
  }, [base])
  useEffect(() => { void refreshJobs() }, [refreshJobs])
  useEffect(() => {
    if (!jobs.some((row) => ACTIVE_STATUSES.has(row.status))) return
    const timer = setInterval(() => { void refreshJobs() }, 3000)
    return () => clearInterval(timer)
  }, [jobs, refreshJobs])

  const openJob = async (jobId: string) => {
    setActionError(null)
    try {
      setSelectedJob(await fetchVkJob(jobId, base))
    } catch (error) {
      setActionError(errorText(error, '任务详情获取失败'))
    }
  }

  const jobAction = async (jobId: string, action: 'cancel' | 'retry' | 'refresh') => {
    setActionError(null)
    try {
      await postVkJobAction(jobId, action, base)
      await refreshJobs()
      await openJob(jobId)
    } catch (error) {
      setActionError(errorText(error, '任务操作失败'))
    }
  }

  const showDiagnostic = async () => {
    try {
      setDiagnostic(JSON.stringify(await fetchVkDiagnostic(base), null, 2))
    } catch (error) {
      setDiagnostic(errorText(error, '诊断获取失败'))
    }
  }

  // —— 知识库查询 ——
  const [queryText, setQueryText] = useState('')
  const [queryAnswer, setQueryAnswer] = useState<VkQueryAnswer | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const runQuery = async () => {
    setQueryError(null)
    setQueryAnswer(null)
    try {
      setQueryAnswer(await postVkQuery(queryText, base))
    } catch (error) {
      setQueryError(errorText(error, '知识库查询失败'))
    }
  }

  const previewEstimate = preview ? formatEstimate(estimateForPreset(preview.preset)) : null

  return (
    <div className="mx-auto max-w-3xl p-3 sm:p-6" data-testid="vk-panel">
      {/* 健康条 */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <span className="text-sm font-medium">视频解析引擎</span>
        <span data-testid="vk-health-summary" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {healthChecking ? '检测中…' : health ? `${health.summary}${health.apiVersion ? `(api ${health.apiVersion})` : ''}` : 'Host 不可达'}
        </span>
        <button type="button" data-testid="vk-health-recheck" onClick={() => { void checkHealth() }} className={outlineButton} style={outlineStyle}>
          重新检测
        </button>
        <button type="button" data-testid="vk-diagnostic-button" onClick={() => { void showDiagnostic() }} className={outlineButton} style={outlineStyle}>
          会话诊断
        </button>
      </div>
      {diagnostic && (
        <pre data-testid="vk-diagnostic" className="mb-4 max-h-40 overflow-auto rounded-lg p-2 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{diagnostic}</pre>
      )}

      {/* 解析环境卡:专用 runtime、已有环境检测与能力管理 */}
      {runtime && (
        <div data-testid="vk-runtime-card" className="mb-4 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <div className="mb-1 text-sm font-medium">解析环境</div>
          <div data-testid="vk-runtime-summary" className="mb-2 text-xs" style={{ color: runtime.state === 'failed' ? 'var(--color-danger)' : 'var(--color-fg-dim)' }}>
            {runtime.summary}
            {runtime.reasonCode ? `(${runtime.reasonCode})` : ''}
          </div>
          {runtime.state !== 'installed' && <div className="mb-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            初始化爪爪专用解析环境（基础版）：复用本机 Python 3.12 与 uv 缓存。基础版含核心、字幕、下载，不含本地 ASR；安装会核验 SHA、创建独立环境并运行 smoke 检查。
          </div>}
          {runtime.state === 'installed' && <div className="mb-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            当前环境：{runtime.source ?? (runtimeSource === 'external' ? '已有环境（外部）' : '爪爪专用环境')}{runtime.pythonPath ? ` · ${runtime.pythonPath}` : ''}
            。重建按钮会重新创建爪爪专用环境，不会修改外部环境。
          </div>}
          {runtime.log.length > 0 && (
            <pre data-testid="vk-runtime-log" className="mb-2 max-h-40 overflow-auto rounded-lg p-2 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{runtime.log.join('\n')}</pre>
          )}
          {installError && <div className="mb-2 text-xs" style={{ color: 'var(--color-danger)' }}>{installError}</div>}
          {runtimeDetectError && <div data-testid="vk-runtime-detect-error" className="mb-2 text-xs" style={{ color: 'var(--color-danger)' }}>{runtimeDetectError}</div>}
          {runtimeAdoptError && <div data-testid="vk-runtime-adopt-error" className="mb-2 text-xs" style={{ color: 'var(--color-danger)' }}>{runtimeAdoptError}</div>}
          {runtimeAdoptNotice && <div data-testid="vk-runtime-adopt-notice" role="status" className="mb-2 text-xs" style={{ color: 'var(--color-success)' }}>{runtimeAdoptNotice}</div>}
          <div className="mb-2 flex flex-wrap gap-2">
            {runtime.state !== 'installing' && runtime.state !== 'not-available' && (
            <button
              type="button"
              data-testid="vk-runtime-install"
              onClick={() => { void startInstall() }}
              className="rounded-lg px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
            >
              {runtime.state === 'installed'
                ? '重建爪爪专用环境'
                : runtime.state === 'failed'
                  ? '重试安装：初始化爪爪专用解析环境（基础版）'
                  : '初始化爪爪专用解析环境（基础版）'}
            </button>
            )}
            {runtime.state !== 'not-available' && <button type="button" data-testid="vk-runtime-detect" onClick={() => { void detectRuntime() }} disabled={runtimeDetecting} className={outlineButton} style={outlineStyle}>
              {runtimeDetecting ? '检测中…' : '检测已有环境'}
            </button>}
            {runtime.state === 'installed' && <button type="button" data-testid="vk-runtime-details-toggle" onClick={() => setRuntimeDetailsOpen((open) => !open)} className={outlineButton} style={outlineStyle}>
              {runtimeDetailsOpen ? '收起环境与能力' : '环境与能力管理'}
            </button>}
          </div>
          {runtimeDetailsOpen && runtimeCandidates && <div data-testid="vk-runtime-candidates" className="mt-2 space-y-2 text-xs">
            {runtimeCandidates.filter((candidate) => candidate.compatible || showIncompatibleRuntimes).map((candidate) => {
              const index = runtimeCandidates.indexOf(candidate)
              const adopting = runtimeAdoptingPath === candidate.pythonPath
              return <div key={candidate.pythonPath} className="rounded-lg p-2" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <div className="font-medium">{candidate.source} · Python {candidate.version ?? '未知'}</div>
              <div>{candidate.pythonPath}</div>
              <div>{candidate.apiVersion ? `api ${candidate.apiVersion}` : 'API 未知'} · {candidate.schemaVersion ? `schema ${candidate.schemaVersion}` : 'schema 未知'}</div>
              <div data-testid="vk-runtime-capabilities">能力：{candidate.capabilities.length ? candidate.capabilities.map((cap) => `${cap.capability}=${cap.runtime}${cap.detail ? `(${cap.detail})` : ''}`).join('、') : '未返回能力'}</div>
              {!candidate.compatible && <div style={{ color: 'var(--color-danger)' }}>不兼容：{candidate.reason ?? '版本或契约不匹配'}</div>}
              <button type="button" data-testid={`vk-runtime-adopt-${index}`} disabled={!candidate.compatible || candidate.active || runtimeAdoptingPath !== null} onClick={() => { void adoptRuntime(candidate) }} className={outlineButton} style={outlineStyle}>
                {candidate.active ? '当前使用' : adopting ? '切换中…' : '使用此环境'}
              </button>
            </div>})}
            {runtimeCandidates.some((candidate) => !candidate.compatible) && <button type="button" data-testid="vk-runtime-incompatible-toggle" onClick={() => setShowIncompatibleRuntimes((show) => !show)} className={outlineButton} style={outlineStyle}>
              {showIncompatibleRuntimes ? '隐藏不兼容环境' : `查看 ${runtimeCandidates.filter((candidate) => !candidate.compatible).length} 个不兼容环境`}
            </button>}
            {!runtimeCandidates.length && <div>未发现可用的本机环境</div>}
          </div>}
        </div>
      )}

      {/* 提交表单 */}
      <div className="mb-4 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-2 text-sm font-medium">新解析任务</div>
        {provenance && (
          <div data-testid="vk-provenance" className="mb-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            来自采集结果:{provenance.commandKey}
          </div>
        )}
        <label className="mb-2 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          视频链接
          <input
            data-testid="vk-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://…"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </label>
        <label className="mb-2 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          处理目的
          <select data-testid="vk-preset" value={preset} onChange={(e) => setPreset(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
            {PRESETS.map((value) => <option key={value} value={value}>{PRESET_LABELS[value]}</option>)}
          </select>
        </label>
        <details data-testid="vk-advanced-settings" className="mb-3 rounded-lg p-2 text-xs" style={{ border: '1px solid var(--color-line)' }}>
          <summary className="cursor-pointer select-none" style={{ color: 'var(--color-fg-dim)' }}>高级设置</summary>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
              内容类型
              <select data-testid="vk-content-type" value={contentType} onChange={(e) => setContentType(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                <option value="">跟随处理目的</option>
                {CONTENT_TYPES.map((value) => <option key={value} value={value}>{CONTENT_TYPE_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
              媒体处理方式
              <select data-testid="vk-media-policy" value={mediaPolicy} onChange={(e) => setMediaPolicy(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                <option value="">跟随处理目的</option>
                {MEDIA_POLICIES.map((value) => <option key={value} value={value}>{MEDIA_POLICY_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
              处理深度
              <select data-testid="vk-quality" value={quality} onChange={(e) => setQuality(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                <option value="">跟随处理目的</option>
                {QUALITY_PROFILES.map((value) => <option key={value} value={value}>{QUALITY_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
              成本偏好
              <select data-testid="vk-budget-profile" value={budgetProfile} onChange={(e) => setBudgetProfile(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                <option value="">跟随处理目的</option>
                {BUDGET_PROFILES.map((value) => <option key={value} value={value}>{BUDGET_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
              最高费用（¥）
              <input data-testid="vk-max-cost" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} inputMode="decimal" placeholder="不设置上限" className={`${fieldClass} mt-1`} style={fieldStyle} />
            </label>
          </div>
          <fieldset className="mt-3 rounded-lg p-2" style={{ border: '1px solid var(--color-line)' }}>
            <legend style={{ color: 'var(--color-fg-dim)' }}>附加能力</legend>
            <div className="flex flex-wrap gap-3">
              {CAPABILITIES.map((value) => (
                <label key={value} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    data-testid={`vk-cap-${value}`}
                    checked={caps.includes(value)}
                    onChange={(e) => setCaps((current) => (
                      e.target.checked ? [...current, value] : current.filter((item) => item !== value)
                    ))}
                  />
                  {CAPABILITY_LABELS[value]}
                </label>
              ))}
              <label className="flex items-center gap-1">
                <input type="checkbox" data-testid="vk-audit" checked={audit} onChange={(e) => setAudit(e.target.checked)} />
                生成证据审计报告
              </label>
            </div>
          </fieldset>
        </details>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="vk-preview-button"
            disabled={!source.trim()}
            onClick={() => { void doPreview() }}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            查看处理方案
          </button>
          <button
            type="button"
            data-testid="vk-submit-button"
            disabled={!preview}
            onClick={requestSubmit}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            开始解析
          </button>
        </div>
        {previewError && <div data-testid="vk-preview-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{previewError}</div>}
        {submitError && <div data-testid="vk-submit-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{submitError}</div>}
        {preview && previewEstimate && (
          <div data-testid="vk-preview" className="mt-3 rounded-lg p-2 text-xs" style={{ background: 'var(--color-canvas)' }}>
            <div className="mb-1 font-medium" style={{ color: 'var(--color-fg)' }}>处理方案（已应用默认设置）</div>
            <div style={{ color: 'var(--color-fg-dim)' }}>
              目的：{PRESET_LABELS[preview.preset] ?? preview.preset} · 内容：{CONTENT_TYPE_LABELS[preview.content_type] ?? preview.content_type}
              {' · '}媒体：{MEDIA_POLICY_LABELS[preview.media_policy] ?? preview.media_policy}
              {' · '}深度：{QUALITY_LABELS[preview.quality_profile] ?? preview.quality_profile}
              {' · '}成本：{BUDGET_LABELS[preview.budget_profile] ?? preview.budget_profile}
            </div>
            <div style={{ color: 'var(--color-fg-dim)' }}>
              输出：{preview.output_targets.map((target) => OUTPUT_LABELS[target] ?? target).join('、')}
            </div>
            <div style={{ color: 'var(--color-fg-dim)' }}>
              增强能力：{preview.requested_capabilities.length ? preview.requested_capabilities.map((cap) => CAPABILITY_LABELS[cap] ?? cap).join('、') : '无'}
              {' · '}证据审计报告：{preview.audit_requested ? '生成' : '不生成'}
            </div>
            <div data-testid="vk-preview-estimates" style={{ color: 'var(--color-fg-dim)' }}>
              预估费用 {previewEstimate.cost} · 预估耗时 {previewEstimate.duration}
            </div>
            <div style={{ color: 'var(--color-fg-dim)' }}>
              费用硬上限:{preview.max_cost_cny != null ? `¥${preview.max_cost_cny}` : '未设置'}
            </div>
            {health && health.capabilities.length > 0 && (
              <div data-testid="vk-runtime-caps" style={{ color: 'var(--color-fg-dim)' }}>
                环境能力:{health.capabilities.map((item) => `${item.capability}=${item.runtime}`).join('、')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 任务列表 */}
      <div className="mb-4 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">任务</span>
          <button type="button" data-testid="vk-jobs-refresh" onClick={() => { void refreshJobs() }} className={outlineButton} style={outlineStyle}>刷新</button>
        </div>
        {jobsError && <div className="mb-2 text-xs" style={{ color: 'var(--color-danger)' }}>{jobsError}</div>}
        {jobs.length === 0 && !jobsError && (
          <div className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>
        )}
        {jobs.length > 0 && (
          <div className="rounded-lg" style={{ border: '1px solid var(--color-line)' }}>
            {jobs.map((row) => (
              <div key={row.job_id} data-testid="vk-job-row" className="flex items-center gap-3 border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: 'var(--color-line)' }}>
                <span className="min-w-20 font-medium">{STATUS_LABELS[row.status] ?? row.status}</span>
                <span style={{ color: 'var(--color-fg-dim)' }}>{row.kind}</span>
                <span style={{ color: 'var(--color-fg-dim)' }}>已耗时 {elapsedLabel(row)}</span>
                {row.cost_cny != null && <span style={{ color: 'var(--color-fg-dim)' }}>实际费用 ¥{row.cost_cny.toFixed(4)}</span>}
                <span className="ml-auto" />
                <button type="button" data-testid={`vk-job-open-${row.job_id}`} onClick={() => { void openJob(row.job_id) }} className={outlineButton} style={outlineStyle}>详情</button>
                {ACTIVE_STATUSES.has(row.status) && (
                  <button type="button" onClick={() => { void jobAction(row.job_id, 'cancel') }} className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-danger)' }}>取消</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 任务详情 */}
      {selectedJob && (
        <div data-testid="vk-job-detail" className="mb-4 rounded-lg p-3 text-xs" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">{STATUS_LABELS[selectedJob.status] ?? selectedJob.status}</span>
            <span style={{ color: 'var(--color-fg-dim)' }}>已耗时 {elapsedLabel(selectedJob)}</span>
            {selectedJob.cost_cny != null && <span style={{ color: 'var(--color-fg-dim)' }}>实际费用 ¥{selectedJob.cost_cny.toFixed(4)}</span>}
            <span className="ml-auto" />
            <button type="button" data-testid="vk-job-retry" onClick={() => { void jobAction(selectedJob.job_id, 'retry') }} className={outlineButton} style={outlineStyle}>重试</button>
            <button type="button" data-testid="vk-job-refresh" title="绕过来源版本缓存重新解析" onClick={() => { void jobAction(selectedJob.job_id, 'refresh') }} className={outlineButton} style={outlineStyle}>强制重跑</button>
            <button type="button" onClick={() => setSelectedJob(null)} className="rounded-lg px-2 py-1 text-sm leading-none" style={{ color: 'var(--color-fg-dim)' }}>×</button>
          </div>
          {selectedJob.error && <div className="mb-2" style={{ color: 'var(--color-danger)' }}>{selectedJob.error}</div>}
          {selectedJob.budget_stop && (
            <div data-testid="vk-budget-stop" className="mb-2 rounded-lg p-2" style={{ background: 'var(--color-canvas)', color: 'var(--color-warning)' }}>
              已按费用上限终止:{selectedJob.budget_stop.reason}
              (实际 ¥{selectedJob.budget_stop.actual_cost_cny ?? 0} / 上限 ¥{selectedJob.budget_stop.limit_cny ?? '—'},阶段 {selectedJob.budget_stop.stage ?? '—'})
            </div>
          )}
          {selectedJob.request?.source && (
            <div className="mb-2 break-all" style={{ color: 'var(--color-fg-dim)' }}>来源:{String(selectedJob.request.source)}</div>
          )}
          {selectedJob.capabilities && selectedJob.capabilities.length > 0 && (
            <div data-testid="vk-evidence-coverage" className="mb-2" style={{ color: 'var(--color-fg-dim)' }}>
              证据覆盖:{selectedJob.capabilities.map((item) => `${item.capability}=${item.state}${item.reason ? `(${item.reason})` : ''}`).join('、')}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {selectedJob.outputs?.note_path && (
              <button type="button" data-testid="vk-output-note" onClick={() => { void downloadVkOutput(selectedJob.outputs!.note_path!, base) }} className={outlineButton} style={outlineStyle}>笔记</button>
            )}
            {selectedJob.outputs?.audit_path && (
              <button type="button" data-testid="vk-output-audit" onClick={() => { void downloadVkOutput(selectedJob.outputs!.audit_path!, base) }} className={outlineButton} style={outlineStyle}>Audit</button>
            )}
            {(selectedJob.outputs?.product_artifacts ?? []).map((artifact, index) => (
              <span key={artifact.sha256} className="flex gap-1">
                <button type="button" data-testid={`vk-output-product-json-${index}`} onClick={() => { void downloadVkOutput(artifact.json, base) }} className={outlineButton} style={outlineStyle}>{artifact.preset} JSON</button>
                <button type="button" data-testid={`vk-output-product-md-${index}`} onClick={() => { void downloadVkOutput(artifact.markdown, base) }} className={outlineButton} style={outlineStyle}>{artifact.preset} MD</button>
              </span>
            ))}
          </div>
        </div>
      )}
      {actionError && <div data-testid="vk-action-error" className="mb-4 text-xs" style={{ color: 'var(--color-danger)' }}>{actionError}</div>}

      {/* 知识库查询 */}
      <div className="rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-2 text-sm font-medium">知识库查询</div>
        <div className="flex gap-2">
          <input
            data-testid="vk-query-input"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="问题或检索词"
            className={fieldClass}
            style={fieldStyle}
          />
          <button
            type="button"
            data-testid="vk-query-button"
            disabled={!queryText.trim()}
            onClick={() => { void runQuery() }}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            检索
          </button>
        </div>
        {queryError && <div className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{queryError}</div>}
        {queryAnswer && (
          <div data-testid="vk-query-answer" className="mt-3 rounded-lg p-2 text-xs" style={{ background: 'var(--color-canvas)' }}>
            <div className="mb-1" style={{ color: 'var(--color-fg)' }}>{queryAnswer.answer}</div>
            <div style={{ color: 'var(--color-fg-dim)' }}>状态:{queryAnswer.status}</div>
            {(queryAnswer.citations ?? []).map((citation) => (
              <div key={citation.document_id} data-testid="vk-query-citation" style={{ color: 'var(--color-fg-dim)' }}>
                引用 {citation.kind} · {citation.document_id.slice(0, 8)}… · revision {citation.source_revision_id.slice(0, 8)}…
              </div>
            ))}
          </div>
        )}
      </div>

      <VkCostConfirmDialog
        pending={pendingSubmit}
        onCancel={() => setPendingSubmit(null)}
        onConfirm={() => { void confirmSubmit() }}
      />
    </div>
  )
}
