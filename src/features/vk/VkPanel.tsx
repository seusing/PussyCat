// 「视频解析」整页模块(vk-shell-v1 契约消费端)。
//
// 边界:React 只访问 Node 的 /vk/v1/* 代理,永不直连 Python、永不接触 sidecar
// token。进度只显示真实状态/已耗时/实际费用,不造百分比(拍板 4)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BorderBeam } from 'border-beam'
import { Check, Copy, Download, LoaderCircle, RefreshCw, Upload } from 'lucide-react'
import Markdown from 'react-markdown'
import { useAppStore } from '../../store/appStore'
import { AppAlert, type AppAlertTone } from '../../components/AppAlert'
import { HostRequestError } from '../../host/errors'
import {
  fetchVkHealth,
  fetchVkJob,
  fetchVkJobs,
  fetchVkOutputText,
  fetchVkRuntimeStatus,
  postVkRuntimeAdopt,
  postVkRuntimeDetect,
  postVkJob,
  postVkJobAction,
  postVkPreview,
  postVkQuery,
  postVkRuntimeInstall,
  fetchVkProviderSettings,
  testVkProvider,
} from '../../host/vkClient'
import type {
  VkHealth,
  VkJobRow,
  VkJobView,
  VkPreviewProjection,
  VkQueryAnswer,
  VkRuntimeStatus,
  VkRuntimeCandidate,
} from '../../host/vkClient'
import { BorderGlow } from '../../components/BorderGlow'
import { runtimeToAdopt } from './runtimePick'
import { VkCapabilityPacksPanel } from './VkCapabilityPacksPanel'
import { VideoSourceCoverFlow } from './VideoSourceCoverFlow'
import { VkTaskTable } from './VkTaskTable'
import { copyText } from '../../lib/clipboard'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { isVkJobRerun, VK_OPEN_OUTPUT_EVENT } from './taskUiState'
import './VkPanel.css'

const PRESETS = ['quick-summary', 'course-learning', 'interview-analysis', 'science-explainer']
const CONTENT_TYPES = ['auto', 'course_lecture', 'interview_podcast', 'science_explainer', 'tutorial', 'other_knowledge', 'generic_knowledge']
const MEDIA_POLICIES = ['subtitle_only', 'audio_transcript', 'low_res_visual', 'video_required']
const BUDGET_PROFILES = ['economy', 'standard', 'quality']
const CAPABILITIES = ['word_timestamps', 'speaker_diarization', 'visual_evidence', 'query_ready']

const PRESET_LABELS: Record<string, string> = {
  'quick-summary': '快速总结',
  'course-learning': '课程学习笔记',
  'interview-analysis': '访谈观点分析',
  'science-explainer': '科普知识梳理',
}
const PRESET_DESCRIPTIONS: Record<string, string> = {
  'quick-summary': '先看重点，通常最快',
  'course-learning': '整理概念、步骤、例子和复习问题',
  'interview-analysis': '区分观点、共识、分歧和关键引语',
  'science-explainer': '解释原理、因果、适用边界和常见误区',
}
const CONTENT_TYPE_LABELS: Record<string, string> = {
  auto: '自动判断', course_lecture: '课程/讲座', interview_podcast: '访谈/播客',
  science_explainer: '科普讲解', tutorial: '教程', other_knowledge: '其他知识内容', generic_knowledge: '通用知识内容',
}
const MEDIA_POLICY_LABELS: Record<string, string> = {
  subtitle_only: '仅使用平台字幕', audio_transcript: '字幕缺失时转写音频',
  low_res_visual: '加入低清视觉证据', video_required: '下载完整视频并分析画面',
}
const BUDGET_LABELS: Record<string, string> = { economy: '经济', standard: '标准', quality: '质量优先' }
const CAPABILITY_LABELS: Record<string, string> = {
  word_timestamps: '精确到词的时间点', speaker_diarization: '区分不同说话人',
  visual_evidence: '结合画面理解', query_ready: '保存到知识库并可检索',
}
const AUTO_ROUTE_LABELS: Record<string, string> = {
  text_fast: '快速文本整理',
  visual_assisted: '画面辅助解析',
  speaker_attribution: '说话人归属整理',
  evidence_grounded: '证据核验整理',
  generic_fallback: '通用整理',
}
const AUTO_ROUTE_REASON_LABELS: Record<string, string> = {
  asr_quality_passed: '语音转写质量良好',
  captions_available: '已找到可用字幕',
  text_first: '采用文本优先路径',
  visual_required: '内容依赖画面',
  speaker_required: '需要区分说话人',
  precision_risk: '采用更严格的核对路径',
  low_confidence: '信息不足，使用稳妥方案',
}

function autoRouteReasonText(reasonCodes: string[] | undefined) {
  return [...new Set((reasonCodes ?? []).map((code) => AUTO_ROUTE_REASON_LABELS[code]).filter(Boolean))].join(' · ')
}
const ACTIVE_STATUSES = new Set([
  'queued', 'running', 'cancel_requested', 'submitted', 'processing',
  'retry_requested', 'retrying', 'rerunning',
])
const SUCCESS_STATUSES = new Set(['done', 'partial'])
const INTERRUPTED_STATUSES = new Set(['cancelled', 'completed_after_cancel_request', 'interrupted'])
const TASK_BANNER_DURATION_MS = 3_000
const VK_JOB_DETAIL_TERMINAL_EVENT = 'vk:job-detail-terminal'
const VK_JOB_TERMINAL_EVENT = 'vk:job-terminal'
const VK_JOB_RETRY_SUBMITTED_EVENT = 'vk:job-retry-submitted'
const VK_NOTIFICATIONS_KEY = 'opencli-app:vk-task-notifications:v1'
const VK_HIDDEN_JOBS_KEY = 'opencli-app:vk-hidden-jobs:v1'
const VK_TASK_NUMBERS_KEY = 'opencli-app:vk-task-numbers:v1'

function loadBooleanRecord(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.entries(parsed).reduce<Record<string, boolean>>((result, [entryKey, value]) => {
      if (typeof value === 'boolean') result[entryKey] = value
      return result
    }, {})
  } catch {
    return {}
  }
}

function saveBooleanRecord(key: string, value: Record<string, boolean>): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* UI preference remains in memory */ }
}

function loadNumberRecord(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.entries(parsed).reduce<Record<string, number>>((result, [entryKey, value]) => {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) result[entryKey] = value
      return result
    }, {})
  } catch {
    return {}
  }
}

function saveNumberRecord(key: string, value: Record<string, number>): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* UI preference remains in memory */ }
}

function taskNumberKey(row: VkJobRow): string {
  return `${row.job_id}|${row.submitted_at}`
}

function attachLogicalTaskIds(rows: VkJobRow[]): VkJobRow[] {
  const byId = new Map(rows.map((row) => [row.job_id, row]))
  const rootFor = (row: VkJobRow): VkJobRow => {
    let current = row
    const seen = new Set<string>()
    while (current.parent_job_id && !seen.has(current.job_id)) {
      seen.add(current.job_id)
      const parent = byId.get(current.parent_job_id)
      if (!parent) break
      current = parent
    }
    return current
  }
  return rows.map((row) => ({ ...row, logicalTaskId: rootFor(row).job_id }))
}

/** The sidecar exposes pipeline runs for historical inspection. They are not
 * additional user submissions, so hide a run row when its request row is
 * present in the same polling snapshot. */
function collapseInternalRunRows(rows: VkJobRow[]): VkJobRow[] {
  const requests = rows.filter((row) => row.kind !== 'run')
  if (requests.length === 0) return rows
  return rows.filter((row) => {
    if (row.kind !== 'run') return true
    return !requests.some((request) => {
      if (request.run_id && row.run_id && request.run_id === row.run_id) return true
      const requestTime = Date.parse(request.submitted_at)
      const runTime = Date.parse(row.submitted_at)
      const startedTogether = Number.isFinite(requestTime)
        && Number.isFinite(runTime)
        && Math.abs(requestTime - runTime) <= 2000
      if (!startedTogether) return false
      if (ACTIVE_STATUSES.has(request.status) && ACTIVE_STATUSES.has(row.status)) return true
      if (request.status !== row.status || !request.finished_at || !row.finished_at) return false
      const requestFinished = Date.parse(request.finished_at)
      const runFinished = Date.parse(row.finished_at)
      return Number.isFinite(requestFinished)
        && Number.isFinite(runFinished)
        && Math.abs(requestFinished - runFinished) <= 2000
    })
  })
}

function latestLogicalTasks(rows: VkJobRow[]): VkJobRow[] {
  const latest = new Map<string, VkJobRow>()
  for (const row of rows) {
    const key = row.logicalTaskId ?? row.job_id
    const previous = latest.get(key)
    if (!previous || Date.parse(row.submitted_at) > Date.parse(previous.submitted_at)) latest.set(key, row)
  }
  return [...latest.values()].sort((left, right) => Date.parse(right.submitted_at) - Date.parse(left.submitted_at))
}

function primaryOutput(job: VkJobView): { id: string; title: string } | null {
  if (job.outputs?.note_path) return { id: job.outputs.note_path, title: '知识笔记' }
  const product = job.outputs?.product_artifacts?.[0]
  if (product?.markdown) return { id: product.markdown, title: `${product.preset} MD` }
  if (job.outputs?.audit_path) return { id: job.outputs.audit_path, title: '证据审计' }
  return null
}

function outputFileName(outputId: string): string {
  const name = outputId.split(/[\\/]/).filter(Boolean).at(-1)
  return name || '视频解析结果.md'
}

function sourceLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
}

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
  cancel_requested: '正在停止',
  cancelled: '已中断',
  completed_after_cancel_request: '已中断',
  failed: '失败',
  done: '已完成',
  partial: '部分完成',
  quarantined: '已隔离',
  interrupted: '已中断',
  submitted: '已提交',
}

/**
 * 安装期给健康条套一圈流光。**只在 installing 时套**——那一段要跑好几分钟,而且我们的
 * 文案明说了「可以先去做别的」,用户不会盯着屏幕,需要的是一个余光扫得到的信号,不是
 * 一行要凑近读的字。其余状态一律原样返回:常驻的动效就是背景噪音,反而抬不起真正
 * 需要注意的那一刻。
 *
 * 配色选 ocean(蓝紫)而不是默认的 colorful(全彩虹):本应用是克制的深色盘,
 * 彩虹会把这条本该次要的状态条抢成全屏视觉焦点。
 */
function InstallingBeam({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return <>{children}</>
  return <BorderBeam size="pulse-inner" colorVariant="ocean" theme="dark">{children}</BorderBeam>
}

type TaskBannerTone = 'info' | 'success' | 'danger' | 'warning' | 'rerun'
type TaskBanner = {
  id: string
  message: string
  tone: TaskBannerTone
  createdAt: number
}

function TaskBannerNotice({ banner, onDismiss }: {
  banner: TaskBanner
  onDismiss: (id: string) => void
}) {
  const [modelValue, setModelValue] = useState(100)
  const alertTone: AppAlertTone = banner.tone === 'danger' ? 'error' : banner.tone

  useEffect(() => {
    const updateProgress = () => {
      const elapsed = Date.now() - banner.createdAt
      setModelValue(Math.max(0, 100 - (elapsed / TASK_BANNER_DURATION_MS) * 100))
    }
    updateProgress()
    const interval = setInterval(updateProgress, 50)
    const timeout = setTimeout(() => {
      setModelValue(0)
      onDismiss(banner.id)
    }, Math.max(0, TASK_BANNER_DURATION_MS - (Date.now() - banner.createdAt)))
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [banner.createdAt, banner.id, onDismiss])

  return (
    <AppAlert
      testId="vk-task-banner"
      dataTone={banner.tone}
      tone={alertTone}
      title={banner.message}
      className={`vk-task-banner is-${banner.tone}`}
      role="status"
      onClose={() => onDismiss(banner.id)}
      closeLabel="关闭任务提醒"
      progress={modelValue}
      progressTestId="vk-task-banner-progress"
      progressLabel="提醒剩余时间"
      progressClassName={`is-${banner.tone}`}
    />
  )
}

const fieldClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
const fieldStyle = { background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const
const outlineButton = 'rounded-lg px-2 py-1 text-xs disabled:opacity-50'
const outlineStyle = { border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const

export function VkPanel({ baseUrl, selectedJobId, onSelectJob, refreshToken }: {
  baseUrl?: string
  selectedJobId?: string | null
  onSelectJob?: (jobId: string | null) => void
  refreshToken?: number
}) {
  const base = baseUrl
  // —— 健康(BrowserBridgeStatus 姿势:进入时查一次 + 手动重检;前端只渲染不解释)——
  const [health, setHealth] = useState<VkHealth | null>(null)
  const [healthChecked, setHealthChecked] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const healthGen = useRef(0)
  const checkHealth = useCallback(async ({ manageBusy = true }: { manageBusy?: boolean } = {}) => {
    const gen = ++healthGen.current
    if (manageBusy) setHealthChecking(true)
    try {
      const result = await fetchVkHealth(base)
      if (gen === healthGen.current) {
        setHealth(result)
        setHealthChecked(true)
      }
    } catch {
      if (gen === healthGen.current) {
        setHealth(null)
        setHealthChecked(true)
      }
    } finally {
      if (manageBusy && gen === healthGen.current) setHealthChecking(false)
    }
  }, [base])
  useEffect(() => { void checkHealth() }, [checkHealth])

  // —— 首启 runtime 安装(v2 阶段3):sidecar 未安装时给安装卡;
  //    installing 期间 2s 轮询真实安装输出(不造百分比)——
  const [runtime, setRuntime] = useState<VkRuntimeStatus | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const previousRuntimeState = useRef<string | null>(null)
  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await fetchVkRuntimeStatus(base))
    } catch {
      setRuntime(null)
    }
  }, [base])
  const refreshRuntimeCandidates = useCallback(async () => {
    try {
      return await postVkRuntimeDetect(base)
    } catch {
      return null
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
  // —— 自动体检:进入面板就把环境查清楚并挑最强的,不让用户去点「检测」再去「选」 ——
  // 用户的原话是"能自动获取就自动获取"。检测本身零副作用;挑出来的若不是当前环境
  // 才 adopt(runtimeToAdopt 已经把"已经最强了"过滤掉了,避免无谓地重启 sidecar)。
  // autoPickedRef 保证每次会话只自动切一次:之后用户在开发者信息里手动指定的环境,
  // 不该被下一次自动体检推翻。
  // —— 模型通道:装机版没有 providers.local.toml,不配就一定会在最后一步 401 ——
  // 所以这件事必须在**提交之前**说出来,而不是等用户跑满 7 分半下载转写。
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null)
  const [costTracking, setCostTracking] = useState<boolean | null>(null)
  const [capabilityPacksOpen, setCapabilityPacksOpen] = useState(false)
  const [taskReasoningEfforts, setTaskReasoningEfforts] = useState<string[]>([])
  const [reasoningDiscovery, setReasoningDiscovery] = useState<string | null>(null)
  const [reasoningDiscovering, setReasoningDiscovering] = useState(false)
  const refreshProviders = useCallback(async () => {
    try {
      const settings = await fetchVkProviderSettings(base)
      setProviderConfigured(settings.configured)
      setCostTracking(settings.cost_tracking ?? false)
    } catch {
      setProviderConfigured(null)   // 问不到就别下结论,不冒充已配置
      setCostTracking(null)
    }
  }, [base])
  useEffect(() => { void refreshProviders() }, [refreshProviders])

  const refreshEngineStatus = useCallback(async () => {
    setHealthChecking(true)
    try {
      await Promise.all([
        checkHealth({ manageBusy: false }),
        refreshRuntime(),
        refreshProviders(),
        refreshRuntimeCandidates(),
      ])
    } finally {
      setHealthChecking(false)
    }
  }, [checkHealth, refreshProviders, refreshRuntime, refreshRuntimeCandidates])

  const discoverTaskReasoningEfforts = async () => {
    setReasoningDiscovering(true)
    setReasoningDiscovery(null)
    try {
      const settings = await fetchVkProviderSettings(base)
      const channelIds = new Set(Object.values(settings.roles).filter((value): value is string => !!value))
      const channels = settings.channels.filter((channel) => channelIds.has(channel.id))
      const discovered = await Promise.all(channels.map(async (channel) => {
        const result = await testVkProvider({
          base_url: channel.base_url,
          key_env: channel.key_env,
          api_style: channel.api_style,
        }, base)
        return result.reasoning_efforts?.[channel.model_id] ?? []
      }))
      const known = discovered.filter((items) => items.length > 0)
      const intersection = known.length > 0
        ? known.slice(1).reduce((items, next) => items.filter((item) => next.includes(item)), [...known[0]])
        : []
      setTaskReasoningEfforts(intersection)
      setReasoningDiscovery(intersection.length > 0
        ? `已从当前任务使用的模型通道读取 ${intersection.length} 个共同档位`
        : '接口未返回可枚举档位；仍可输入中转站支持的值，任务会原样注入 reasoning.effort')
    } catch (error) {
      setReasoningDiscovery(errorText(error, '读取推理档位失败；可以保持自动或手动输入'))
    } finally {
      setReasoningDiscovering(false)
    }
  }

  const autoPickedRef = useRef(false)
  useEffect(() => {
    if (runtime?.state !== 'installed' || autoPickedRef.current) return
    autoPickedRef.current = true
    void (async () => {
      try {
        const result = await refreshRuntimeCandidates()
        if (!result) return
        const target = runtimeToAdopt(result.candidates)
        if (target) await adoptRuntime(target)
      } catch {
        // 自动体检失败不打扰用户:界面照常按当前状态渲染,开发者信息里有手动入口。
      }
    })()
  }, [runtime?.state, refreshRuntimeCandidates])   // eslint-disable-line react-hooks/exhaustive-deps

  const startInstall = async ({ rebuild = false }: { rebuild?: boolean } = {}) => {
    setInstallError(null)
    try {
      // 已装状态下不带 rebuild 的话 Host 会按幂等直接返回现状 —— 按钮就成了空转。
      setRuntime(await postVkRuntimeInstall(base, { rebuild }))
    } catch (error) {
      setInstallError(errorText(error, '安装启动失败'))
    }
  }
  const adoptRuntime = async (candidate: VkRuntimeCandidate) => {
    try {
      const adopted = await postVkRuntimeAdopt(candidate.pythonPath, base)
      setRuntime(adopted)
      await checkHealth()
    } catch { /* 自动接入失败时保留当前环境，由健康结论显示真实可用状态。 */ }
  }

  // —— 表单(组件本地;store 只承担跨模块 handoff)——
  const [source, setSource] = useState('')
  const [userGoal, setUserGoal] = useState('')
  const [preset, setPreset] = useState('quick-summary')
  const [contentType, setContentType] = useState('')
  const [mediaPolicy, setMediaPolicy] = useState('')
  const [budgetProfile, setBudgetProfile] = useState('')
  const [caps, setCaps] = useState<string[]>([])
  const [audit, setAudit] = useState(false)
  const [maxCost, setMaxCost] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [provenance, setProvenance] = useState<{ commandKey: string; collectedAt: number } | null>(null)
  const sourceFileInputRef = useRef<HTMLInputElement>(null)
  const hasManualOverrides = preset !== 'quick-summary'
    || contentType !== ''
    || mediaPolicy !== ''
    || budgetProfile !== ''
    || caps.length > 0
    || audit
    || maxCost !== ''
    || reasoningEffort !== ''
  const resetSmartDefaults = () => {
    setPreset('quick-summary')
    setContentType('')
    setMediaPolicy('')
    setBudgetProfile('')
    setCaps([])
    setAudit(false)
    setMaxCost('')
    setReasoningEffort('')
  }

  const handoff = useAppStore((s) => s.vkHandoff)
  useEffect(() => {
    if (!handoff) return
    setSource(handoff.url)
    setProvenance({ commandKey: handoff.commandKey, collectedAt: handoff.collectedAt })
    useAppStore.getState().clearVkHandoff()
  }, [handoff])

  const importSourceFile = async (file: File | undefined) => {
    if (!file) return
    setSubmitError(null)
    try {
      const text = typeof file.text === 'function'
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? ''))
          reader.onerror = () => reject(reader.error)
          reader.readAsText(file)
        })
      setSource((current) => sourceLines(`${current}\n${text}`).join('\n'))
    } catch (error) {
      setSubmitError(errorText(error, '链接文件读取失败'))
    }
  }

  // —— 预检 → 费用确认 → 提交 ——
  const [previewing, setPreviewing] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [taskBanners, setTaskBanners] = useState<TaskBanner[]>([])
  const submitInFlight = useRef(false)
  const dismissTaskBanner = useCallback((id: string) => {
    setTaskBanners((current) => current.filter((item) => item.id !== id))
  }, [])
  const addTaskBanners = useCallback((banners: TaskBanner[]) => {
    setTaskBanners((current) => [
      ...current,
      ...banners.filter((banner) => !current.some((item) => item.id === banner.id)),
    ])
  }, [])

  // preview 只负责校验并生成费用确认信息；真正提交仍使用原始投影，不能把脱敏回显当载荷。
  const buildProjection = (sourceValue = source.trim()): VkPreviewProjection => {
    const userMetadata = {
      processing_strategy: 'auto',
      ...(userGoal.trim() ? { user_goal: userGoal.trim() } : {}),
      ...(provenance
        ? {
            origin: 'opencli-result',
            source_command: provenance.commandKey,
            collected_at: new Date(provenance.collectedAt).toISOString(),
          }
        : {}),
    }
    return {
      source: sourceValue,
      preset,
      ...(contentType ? { content_type: contentType } : {}),
      ...(mediaPolicy ? { media_policy: mediaPolicy } : {}),
      // The backend keeps the resolved depth internal. Omitting it here lets
      // the future scout stage choose the cheapest sufficient route.
      ...(budgetProfile ? { budget_profile: budgetProfile } : {}),
      ...(caps.length ? { capabilities: caps } : {}),
      ...(audit ? { audit: true } : {}),
      ...(maxCost.trim() ? { max_cost_cny: Number(maxCost) } : {}),
      ...(reasoningEffort.trim() ? { reasoning_effort: reasoningEffort.trim() } : {}),
      ...(Object.keys(userMetadata).length ? { user_metadata: userMetadata } : {}),
    }
  }

  const requestSubmit = async () => {
    if (submitInFlight.current) return
    const sources = sourceLines(source)
    if (sources.length === 0) return
    if (providerConfigured === false) {
      addTaskBanners([{
        id: `provider-required:${crypto.randomUUID()}`,
        message: '请先完成模型配置选择',
        tone: 'warning',
        createdAt: Date.now(),
      }])
      return
    }
    submitInFlight.current = true
    setSubmitError(null)
    setPreviewing(true)
    const submissionNoticeId = `submitted:${crypto.randomUUID()}`
    let submittedAny = false
    try {
      for (const sourceValue of sources) {
        const previewedRequest = await postVkPreview(buildProjection(sourceValue), base)
        const request = { ...previewedRequest, source: sourceValue }
        await postVkJob({
          request,
          idempotency_key: crypto.randomUUID(),
          client_job_id: crypto.randomUUID(),
        }, base)
        if (!submittedAny) {
          submittedAny = true
          addTaskBanners([{
            id: submissionNoticeId,
            message: '\u4efb\u52a1\u5df2\u63d0\u4ea4',
            tone: 'info',
            createdAt: Date.now(),
          }])
        }
      }
      await refreshJobs()
    } catch (error) {
      setSubmitError(errorText(error, '任务提交失败'))
    } finally {
      submitInFlight.current = false
      setPreviewing(false)
    }
  }

  // —— 任务列表与详情(vk.db 真源;轮询只在有活跃任务时)——
  const [jobs, setJobs] = useState<VkJobRow[]>([])
  const [jobsRefreshing, setJobsRefreshing] = useState(false)
  const [taskNumbers, setTaskNumbers] = useState<Record<string, number>>(() => loadNumberRecord(VK_TASK_NUMBERS_KEY))
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [selectedJob, setSelectedJob] = useState<VkJobView | null>(null)
  const [notifications, setNotifications] = useState<Record<string, boolean>>(() => loadBooleanRecord(VK_NOTIFICATIONS_KEY))
  const [hiddenJobs, setHiddenJobs] = useState<Record<string, boolean>>(() => loadBooleanRecord(VK_HIDDEN_JOBS_KEY))
  const [actionError, setActionError] = useState<string | null>(null)
  const [openingOutput, setOpeningOutput] = useState<string | null>(null)
  const [outputViewer, setOutputViewer] = useState<{ id: string; title: string; content: string } | null>(null)
  const [outputCopied, setOutputCopied] = useState(false)
  const [outputDownloadProgress, setOutputDownloadProgress] = useState<number | null>(null)
  const [outputDownloadDone, setOutputDownloadDone] = useState(false)
  const [outputDownloadHovered, setOutputDownloadHovered] = useState(false)
  const outputDownloadController = useRef<AbortController | null>(null)
  const outputDownloadResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jobsGen = useRef(0)
  const notificationPrefsRef = useRef(notifications)
  const previousStatusesRef = useRef<Map<string, string> | null>(null)
  const taskNumbersRef = useRef(taskNumbers)
  useEffect(() => { notificationPrefsRef.current = notifications }, [notifications])
  useEffect(() => { taskNumbersRef.current = taskNumbers }, [taskNumbers])

  const attachTaskNumbers = useCallback((rows: VkJobRow[]): VkJobRow[] => {
    const logicalRows = attachLogicalTaskIds(rows)
    const byId = new Map(logicalRows.map((row) => [row.job_id, row]))
    const nextNumbers = { ...taskNumbersRef.current }
    let next = Math.max(0, ...Object.values(nextNumbers)) + 1
    let changed = false
    const numbered = logicalRows.map((row) => {
      const root = byId.get(row.logicalTaskId ?? row.job_id) ?? row
      const key = taskNumberKey(root)
      let taskNumber = nextNumbers[key]
      if (taskNumber == null) {
        taskNumber = next++
        nextNumbers[key] = taskNumber
        changed = true
      }
      return { ...row, taskNumber, isRerun: isVkJobRerun(row.job_id) }
    })
    if (changed) {
      taskNumbersRef.current = nextNumbers
      setTaskNumbers(nextNumbers)
      saveNumberRecord(VK_TASK_NUMBERS_KEY, nextNumbers)
    }
    return numbered
  }, [])

  const refreshJobs = useCallback(async (options: { manual?: boolean } = {}) => {
    const { manual = false } = options
    if (manual) setJobsRefreshing(true)
    const gen = ++jobsGen.current
    try {
      const rows = attachTaskNumbers(collapseInternalRunRows(await fetchVkJobs(base)))
      if (gen === jobsGen.current) {
        const previous = previousStatusesRef.current
        const terminalTransitions = previous
          ? rows.filter((row) => {
              const before = previous.get(row.job_id)
              return !!before && ACTIVE_STATUSES.has(before) && !ACTIVE_STATUSES.has(row.status)
            })
          : []
        const selectedId = selectedJobId ?? selectedJob?.job_id ?? null
        let selectedTerminalDetail: VkJobView | null = null
        if (selectedId && terminalTransitions.some((row) => row.job_id === selectedId)) {
          try {
            selectedTerminalDetail = await fetchVkJob(selectedId, base)
          } catch {
            // The list remains authoritative even if this one detail read races sidecar shutdown.
          }
        }
        if (gen !== jobsGen.current) return
        if (previous) {
          const notices = rows.flatMap((row) => {
            const before = previous.get(row.job_id)
            if (!before || !ACTIVE_STATUSES.has(before) || ACTIVE_STATUSES.has(row.status)) return []
            if (notificationPrefsRef.current[row.job_id] === false) return []
            const success = SUCCESS_STATUSES.has(row.status)
            const interrupted = INTERRUPTED_STATUSES.has(row.status)
            return [{
              id: `${row.job_id}:${row.finished_at ?? row.status}`,
              message: success ? `任务${row.taskNumber}已完成` : `任务${row.taskNumber}遇到了些问题`,
              tone: success ? 'success' as const : 'danger' as const,
              createdAt: Date.now(),
              ...(interrupted ? {
                message: `\u4efb\u52a1${row.taskNumber}\u5df2\u4e2d\u65ad`,
                tone: 'warning' as const,
              } : {}),
            }]
          })
          if (notices.length) {
            setTaskBanners((current) => [
              ...current,
              ...notices.filter((notice) => !current.some((item) => item.id === notice.id)),
            ])
          }
        }
        previousStatusesRef.current = new Map(rows.map((row) => [row.job_id, row.status]))
        setJobs(rows)
        if (selectedTerminalDetail) setSelectedJob(selectedTerminalDetail)
        setJobsError(null)
        if (selectedId && terminalTransitions.some((row) => row.job_id === selectedId)) {
          window.dispatchEvent(new CustomEvent(VK_JOB_TERMINAL_EVENT, {
            detail: { jobId: selectedId },
          }))
        }
      }
    } catch (error) {
      if (gen === jobsGen.current) setJobsError(errorText(error, '任务列表获取失败'))
    } finally {
      if (manual) setJobsRefreshing(false)
    }
  }, [attachTaskNumbers, base, selectedJob?.job_id, selectedJobId])
  useEffect(() => { void refreshJobs() }, [refreshJobs, refreshToken])
  useEffect(() => {
    if (!jobs.some((row) => ACTIVE_STATUSES.has(row.status))) return
    const timer = setInterval(() => { void refreshJobs() }, 15_000)
    return () => clearInterval(timer)
  }, [jobs, refreshJobs])
  useEffect(() => {
    const refreshFromDetail = () => { void refreshJobs() }
    const notifyRetrySubmitted = (event: Event) => {
      const jobId = (event as CustomEvent<{ jobId?: string }>).detail?.jobId
      if (!jobId) return
      addTaskBanners([{
        id: `retry-submitted:${jobId}`,
        message: '\u4efb\u52a1\u5df2\u91cd\u65b0\u63d0\u4ea4\uff0c\u6b63\u5728\u91cd\u8dd1',
        tone: 'rerun',
        createdAt: Date.now(),
      }])
    }
    window.addEventListener(VK_JOB_DETAIL_TERMINAL_EVENT, refreshFromDetail)
    window.addEventListener(VK_JOB_RETRY_SUBMITTED_EVENT, notifyRetrySubmitted)
    return () => {
      window.removeEventListener(VK_JOB_DETAIL_TERMINAL_EVENT, refreshFromDetail)
      window.removeEventListener(VK_JOB_RETRY_SUBMITTED_EVENT, notifyRetrySubmitted)
    }
  }, [addTaskBanners, refreshJobs])

  const openJob = async (jobId: string) => {
    setActionError(null)
    try {
      setSelectedJob(await fetchVkJob(jobId, base))
      onSelectJob?.(jobId)
    } catch (error) {
      setActionError(errorText(error, '任务详情获取失败'))
    }
  }

  const jobAction = async (jobId: string, action: 'cancel' | 'retry') => {
    setActionError(null)
    try {
      const result = await postVkJobAction(jobId, action, base)
      if (action === 'retry') {
        const retryJobId = typeof result.job_id === 'string' ? result.job_id : jobId
        addTaskBanners([{
          id: `retry-submitted:${retryJobId}`,
          message: '\u4efb\u52a1\u5df2\u91cd\u65b0\u63d0\u4ea4\uff0c\u6b63\u5728\u91cd\u8dd1',
          tone: 'rerun',
          createdAt: Date.now(),
        }])
      }
      await refreshJobs()
      await openJob(jobId)
    } catch (error) {
      setActionError(errorText(error, '任务操作失败'))
    }
  }

  const resetOutputDownload = useCallback(() => {
    outputDownloadController.current?.abort()
    outputDownloadController.current = null
    if (outputDownloadResetTimer.current) clearTimeout(outputDownloadResetTimer.current)
    outputDownloadResetTimer.current = null
    setOutputDownloadProgress(null)
    setOutputDownloadDone(false)
    setOutputDownloadHovered(false)
  }, [])

  const closeOutputViewer = useCallback(() => {
    resetOutputDownload()
    setOutputViewer(null)
  }, [resetOutputDownload])

  const openOutput = useCallback(async (outputId: string, title: string) => {
    setActionError(null)
    setOpeningOutput(outputId)
    setOutputCopied(false)
    resetOutputDownload()
    try {
      setOutputViewer({ id: outputId, title, content: await fetchVkOutputText(outputId, base) })
    } catch (error) {
      setActionError(errorText(error, '结果读取失败'))
    } finally {
      setOpeningOutput(null)
    }
  }, [base, resetOutputDownload])

  const downloadOutput = useCallback(async () => {
    if (!outputViewer) return
    if (outputDownloadController.current) {
      resetOutputDownload()
      return
    }

    const controller = new AbortController()
    outputDownloadController.current = controller
    setOutputDownloadDone(false)
    setOutputDownloadProgress(0)
    setActionError(null)
    try {
      const saved = await saveTextFileAs(outputFileName(outputViewer.id), outputViewer.content, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (outputDownloadController.current === controller) setOutputDownloadProgress(progress)
        },
      })
      if (controller.signal.aborted) return
      setOutputDownloadProgress(null)
      if (saved) {
        setOutputDownloadDone(true)
        outputDownloadResetTimer.current = setTimeout(() => {
          setOutputDownloadDone(false)
          outputDownloadResetTimer.current = null
        }, 1_200)
      }
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorText(error, '保存失败'))
      setOutputDownloadProgress(null)
    } finally {
      if (outputDownloadController.current === controller) outputDownloadController.current = null
    }
  }, [outputViewer, resetOutputDownload])

  useEffect(() => {
    const openRequestedOutput = (event: Event) => {
      const detail = (event as CustomEvent<{ outputId?: string; title?: string }>).detail
      if (detail?.outputId) void openOutput(detail.outputId, detail.title || '解析结果')
    }
    window.addEventListener(VK_OPEN_OUTPUT_EVENT, openRequestedOutput)
    return () => window.removeEventListener(VK_OPEN_OUTPUT_EVENT, openRequestedOutput)
  }, [openOutput])

  const openTaskResult = async (row: VkJobRow) => {
    setActionError(null)
    try {
      const detail = await fetchVkJob(row.job_id, base)
      if (!SUCCESS_STATUSES.has(detail.status)) throw new Error('任务尚未生成可用结果')
      setSelectedJob(detail)
      onSelectJob?.(row.job_id)
      const output = primaryOutput(detail)
      if (output) await openOutput(output.id, output.title)
    } catch (error) {
      setActionError(errorText(error, '结果读取失败'))
    }
  }

  const saveTaskOutput = async (row: VkJobRow) => {
    setActionError(null)
    try {
      const detail = await fetchVkJob(row.job_id, base)
      const output = primaryOutput(detail)
      if (!output) throw new Error('任务尚未生成可用结果')
      const content = await fetchVkOutputText(output.id, base)
      await saveTextFileAs(outputFileName(output.id), content)
    } catch (error) {
      setActionError(errorText(error, '保存失败'))
    }
  }

  const toggleTaskNotification = (jobId: string, enabled: boolean) => {
    setNotifications((current) => {
      const next = { ...current, [jobId]: enabled }
      notificationPrefsRef.current = next
      saveBooleanRecord(VK_NOTIFICATIONS_KEY, next)
      return next
    })
  }

  const hideTaskRecord = (row: VkJobRow) => {
    setHiddenJobs((current) => {
      const next = { ...current, [row.job_id]: true }
      saveBooleanRecord(VK_HIDDEN_JOBS_KEY, next)
      return next
    })
    if ((selectedJobId ?? selectedJob?.job_id) === row.job_id) {
      setSelectedJob(null)
      onSelectJob?.(null)
    }
    setTaskBanners((current) => current.filter((item) => !item.id.startsWith(`${row.job_id}:`)))
  }

  useEffect(() => {
    if (!outputViewer) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOutputViewer()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeOutputViewer, outputViewer])

  useEffect(() => () => {
    outputDownloadController.current?.abort()
    if (outputDownloadResetTimer.current) clearTimeout(outputDownloadResetTimer.current)
  }, [])

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

  const visibleJobs = latestLogicalTasks(jobs).filter((row) => !hiddenJobs[row.job_id])
  const tableNotifications = Object.fromEntries(
    visibleJobs.map((row) => [row.job_id, notifications[row.job_id] ?? true]),
  )
  const selectedAutoRouteReason = autoRouteReasonText(selectedJob?.auto_route?.reason_codes)

  const verdict: { text: string; color: string; note?: string; action?: { label: string; run: () => void } } | null =
    runtime?.state === 'not-available'
      ? { text: '解析引擎不可用', color: 'var(--color-danger)', note: runtime.summary ?? '缺少随应用分发的安装件,请重新安装爪爪。' }
      : runtime?.state === 'installing'
        ? { text: '正在准备解析环境…', color: 'var(--color-fg-dim)', note: '首次准备需要几分钟,可以先去做别的。' }
        : runtime?.state === 'failed'
          ? {
            text: '解析环境没装成功', color: 'var(--color-danger)',
            note: installError ?? runtime.summary ?? undefined,
            action: { label: '重试', run: () => { void startInstall({ rebuild: false }) } },
          }
          : runtime?.state === 'not-installed'
            ? {
              text: '解析引擎还没准备好', color: 'var(--color-warning)',
              note: installError ?? '缺少本机解析运行环境，需要先完成一次准备。',
              action: { label: '一键准备', run: () => { void startInstall({ rebuild: false }) } },
            }
          : healthChecked && (!health || !['ok', 'ready'].includes(health.status))
              ? {
                text: '解析引擎没有响应', color: 'var(--color-warning)',
                note: health?.summary ?? '暂时联系不上解析引擎。',
                action: { label: '重新检测', run: () => { void refreshEngineStatus() } },
              }
              : healthChecked && providerConfigured === false
                ? {
                  // 通道不通要在**第 1 秒**说,不是第 7.5 分钟。按钮已经说清了下一步,
                  // 再补一段解释后果的话只是噪声 —— 结论 + 动作,到此为止。
                   text: '请完成模型配置选择', color: 'var(--color-warning)',
                  note: '请选择基础处理和深度分析使用的模型配置。',
                  action: { label: '去配置', run: () => useAppStore.getState().setActiveModule('providers') },
                }
                : null

  return (
    <div className="mx-auto max-w-5xl p-3 sm:p-6" data-testid="vk-panel">
      {taskBanners.length > 0 && (
        <div className="vk-task-banners" aria-live="polite">
          {taskBanners.map((banner) => (
            <TaskBannerNotice key={banner.id} banner={banner} onDismiss={dismissTaskBanner} />
          ))}
        </div>
      )}
      {verdict && (
        <InstallingBeam on={runtime?.state === 'installing'}>
          <div className="mb-4 flex flex-col gap-2 rounded-lg p-3 sm:flex-row sm:items-center sm:gap-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
            <div className="min-w-0 flex-1">
              <span data-testid="vk-verdict" className="text-sm font-medium" style={{ color: verdict.color }}>
                {verdict.text}
              </span>
              {verdict.note && (
                <span data-testid="vk-verdict-note" className="ml-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                  {verdict.note}
                </span>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              {verdict.action && (
                <button
                  type="button"
                  data-testid="vk-verdict-action"
                  onClick={verdict.action.run}
                  disabled={healthChecking && verdict.action.label === '重新检测'}
                  aria-busy={healthChecking && verdict.action.label === '重新检测'}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm font-medium disabled:opacity-50"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
                >
                  {healthChecking && verdict.action.label === '重新检测' && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
                  <span>{verdict.action.label}</span>
                </button>
              )}
              <button
                type="button"
                data-testid="vk-refresh"
                onClick={() => { void refreshEngineStatus() }}
                disabled={healthChecking}
                aria-busy={healthChecking}
                aria-label="重新检测"
                title="重新检测解析引擎状态"
                className="rounded px-1.5 py-0.5 text-xs disabled:opacity-40"
                style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg-dim)' }}
              >
                <RefreshCw size={14} className={healthChecking ? 'animate-spin' : undefined} aria-hidden="true" />
              </button>
            </div>
          </div>
        </InstallingBeam>
      )}
      {/* 开发者信息:默认折叠。路径、api/schema、逐项能力、环境列表与手动切换、
          重建、会话诊断、安装日志 —— 排障时全在这儿,平时一个字都不占版面。 */}
      <div className="mb-4">
        <button
          type="button"
          data-testid="vk-capability-toggle"
          aria-expanded={capabilityPacksOpen}
          onClick={() => setCapabilityPacksOpen((open) => !open)}
          className="ml-2 rounded-lg px-3 py-1.5 text-sm font-medium"
          style={{
            background: 'var(--color-hover)',
            border: '1px solid var(--color-line)',
            color: 'var(--color-fg)',
          }}
        >
          {capabilityPacksOpen ? '收起能力中心' : '能力中心'}
        </button>
        {capabilityPacksOpen && (
          <VkCapabilityPacksPanel
            baseUrl={base}
            onRuntimeChanged={() => { void refreshEngineStatus() }}
          />
        )}
      </div>

      {/* 提交表单 */}
      <div className="mb-4 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        {provenance && (
          <div data-testid="vk-provenance" className="mb-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            来自采集结果:{provenance.commandKey}
          </div>
        )}
        <div className="mb-2">
          <BorderGlow className="vk-source-border-glow" testId="vk-source-border-glow">
            <div className="vk-source-input-shell">
              <textarea
                id="vk-source-input"
                data-testid="vk-source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={'每行一个视频链接\nhttps://…'}
                rows={6}
                className={fieldClass}
                style={fieldStyle}
              />
              <VideoSourceCoverFlow source={source} />
              <button
                type="button"
                className="vk-source-file-input"
                title="导入链接文件"
                data-tooltip="导入链接文件"
                aria-label="导入链接文件"
                onClick={() => sourceFileInputRef.current?.click()}
              >
                <Upload size={16} aria-hidden="true" />
              </button>
              <input
                ref={sourceFileInputRef}
                data-testid="vk-source-file"
                className="vk-source-file-picker"
                type="file"
                accept=".txt,.csv,.md,text/plain,text/csv"
                onChange={(event) => {
                  void importSourceFile(event.target.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </div>
          </BorderGlow>
        </div>
        <label className="mb-2 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          你想重点了解什么（选填）
          <textarea
            data-testid="vk-user-goal"
            value={userGoal}
            onChange={(event) => setUserGoal(event.target.value)}
            placeholder="例如：重点比较价格、耗电和适用人群"
            rows={2}
            maxLength={1000}
            className={`${fieldClass} mt-1 resize-y`}
            style={fieldStyle}
          />
          <span className="mt-1 block text-[11px]">不用填写也可以，爪爪会自动判断内容和最快可靠的处理方式。</span>
        </label>
        <div data-testid="vk-smart-mode" className="vk-smart-mode text-xs">
          <div className="vk-smart-mode-heading">
            <strong>智能处理已开启</strong>
            <span>一般无需修改设置</span>
          </div>
          <p>自动判断内容类型、字幕或语音质量、是否需要画面，以及处理深度。</p>
        </div>
        <details data-testid="vk-advanced-settings" className="vk-manual-settings mb-3 text-xs">
          <summary className="vk-settings-summary">手动调整（一般无需修改）</summary>
          <div className="vk-manual-settings-body">
            <div className="vk-preset-settings">
              <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                <span>你想得到什么</span>
                <select data-testid="vk-preset" value={preset} onChange={(e) => setPreset(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                  {PRESETS.map((value) => <option key={value} value={value}>{PRESET_LABELS[value]}</option>)}
                </select>
              </label>
              <p data-testid="vk-preset-description" className="vk-preset-description">{PRESET_DESCRIPTIONS[preset]}</p>
            </div>
            {hasManualOverrides && (
              <button type="button" data-testid="vk-reset-smart-defaults" onClick={resetSmartDefaults} className="vk-reset-smart-defaults" style={outlineStyle}>
                恢复智能默认
              </button>
            )}
            <details data-testid="vk-developer-settings" className="vk-developer-settings">
              <summary className="vk-settings-summary">开发者选项（原始参数）</summary>
              <p className="vk-developer-settings-note">这些参数会覆盖智能判断，仅在调试或明确知道后果时修改。</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                  强制内容类型
                  <select data-testid="vk-content-type" value={contentType} onChange={(e) => setContentType(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                    <option value="">跟随处理目的</option>
                    {CONTENT_TYPES.map((value) => <option key={value} value={value}>{CONTENT_TYPE_LABELS[value]}</option>)}
                  </select>
                </label>
                <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                  强制媒体路径
                  <select data-testid="vk-media-policy" value={mediaPolicy} onChange={(e) => setMediaPolicy(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                    <option value="">跟随处理目的</option>
                    {MEDIA_POLICIES.map((value) => <option key={value} value={value}>{MEDIA_POLICY_LABELS[value]}</option>)}
                  </select>
                </label>
                <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                  模型成本倾向
                  <select data-testid="vk-budget-profile" value={budgetProfile} onChange={(e) => setBudgetProfile(e.target.value)} className={`${fieldClass} mt-1`} style={fieldStyle}>
                    <option value="">跟随处理目的</option>
                    {BUDGET_PROFILES.map((value) => <option key={value} value={value}>{BUDGET_LABELS[value]}</option>)}
                  </select>
                </label>
                <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                  最高费用（¥）
                  <input data-testid="vk-max-cost" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} inputMode="decimal" placeholder={costTracking === false ? '当前通道无可信价格' : '不设置上限'} disabled={costTracking === false} className={`${fieldClass} mt-1 disabled:cursor-not-allowed disabled:opacity-55`} style={fieldStyle} />
                  {costTracking === false && (
                    <span className="mt-1 block text-[11px]">当前通道未配置可靠单价，不能使用人民币费用上限</span>
                  )}
                </label>
                <label className="block" style={{ color: 'var(--color-fg-dim)' }}>
                  覆盖模型推理强度
                  <div className="mt-1 flex gap-1.5">
                    <input
                      data-testid="vk-reasoning-effort"
                      list="vk-task-reasoning-options"
                      value={reasoningEffort}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                      placeholder="自动（跟随通道）"
                      className={fieldClass}
                      style={fieldStyle}
                    />
                    <datalist id="vk-task-reasoning-options">
                      {taskReasoningEfforts.map((effort) => <option key={effort} value={effort} />)}
                    </datalist>
                    <button
                      type="button"
                      data-testid="vk-reasoning-refresh"
                      onClick={() => { void discoverTaskReasoningEfforts() }}
                      disabled={reasoningDiscovering}
                      className="shrink-0 rounded-lg px-2 text-xs disabled:opacity-50"
                      style={outlineStyle}
                    >
                      {reasoningDiscovering ? '读取中…' : '读取档位'}
                    </button>
                  </div>
                  <span className="mt-1 block text-[11px]" style={{ color: 'var(--color-fg-dim)' }}>
                    单条与批量任务共用这一档；留空时沿用模型通道设置。
                    {reasoningDiscovery ? ` ${reasoningDiscovery}` : ''}
                  </span>
                </label>
              </div>
              <fieldset className="mt-3 rounded-lg p-2" style={{ border: '1px solid var(--color-line)' }}>
                <legend style={{ color: 'var(--color-fg-dim)' }}>强制附加能力</legend>
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
                    生成可核查报告
                  </label>
                </div>
              </fieldset>
            </details>
          </div>
        </details>
        <div data-testid="vk-third-party-data-notice" className="mb-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg-dim)' }}>
          为完成解析，视频中提取的字幕或语音转写会发送到你在“模型配置”中选择的第三方模型服务；爪爪不会替该服务改变其数据处理规则。
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="vk-submit-button"
            disabled={!source.trim() || previewing}
            onClick={() => { void requestSubmit() }}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            {previewing ? '正在准备…' : '开始解析'}
          </button>
        </div>
        {submitError && <div data-testid="vk-submit-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{submitError}</div>}
      </div>

      {/* 任务列表 */}
      <div className="mb-4 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">任务</span>
          <motion.button
            type="button"
            data-testid="vk-jobs-refresh"
            onClick={() => { void refreshJobs({ manual: true }) }}
            disabled={jobsRefreshing}
            aria-busy={jobsRefreshing}
            className={`${outlineButton} vk-jobs-refresh-button${jobsRefreshing ? ' is-refreshing' : ''}`}
            style={outlineStyle}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{jobsRefreshing ? '刷新中…' : '刷新'}</span>
          </motion.button>
        </div>
        {jobsError && <div className="mb-2 text-xs" style={{ color: 'var(--color-danger)' }}>{jobsError}</div>}
        <VkTaskTable
          jobs={visibleJobs}
          loading={jobsRefreshing}
          selectedJobId={selectedJobId ?? selectedJob?.job_id}
          notifications={tableNotifications}
          onSelect={(row) => { void openJob(row.job_id) }}
          onOpen={(row) => { void openTaskResult(row) }}
          onToggleNotification={toggleTaskNotification}
          onSave={(row) => { void saveTaskOutput(row) }}
          onDelete={hideTaskRecord}
        />
      </div>

      {/* 任务详情 */}
      {selectedJob && !onSelectJob && (
        <div data-testid="vk-job-detail" className="mb-4 rounded-lg p-3 text-xs" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">{STATUS_LABELS[selectedJob.status] ?? selectedJob.status}</span>
            <span style={{ color: 'var(--color-fg-dim)' }}>已耗时 {elapsedLabel(selectedJob)}</span>
            {selectedJob.progress?.model_calls != null && <span style={{ color: 'var(--color-fg-dim)' }}>模型调用 {selectedJob.progress.model_calls} 次</span>}
            <span className="ml-auto" />
            <button type="button" data-testid="vk-job-retry" onClick={() => { void jobAction(selectedJob.job_id, 'retry') }} className={outlineButton} style={outlineStyle}>重试</button>
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
          {selectedJob.auto_route?.route && (
            <div data-testid="vk-auto-route" className="mb-2" style={{ color: 'var(--color-fg-dim)' }}>
              自动方案:{AUTO_ROUTE_LABELS[selectedJob.auto_route.route] ?? selectedJob.auto_route.route}
              {typeof selectedJob.auto_route.confidence === 'number' && `（置信度 ${Math.round(selectedJob.auto_route.confidence * 100)}%）`}
              {selectedAutoRouteReason && (
                <div className="mt-1">{selectedAutoRouteReason}</div>
              )}
            </div>
          )}
          {selectedJob.capabilities && selectedJob.capabilities.length > 0 && (
            <div data-testid="vk-evidence-coverage" className="mb-2" style={{ color: 'var(--color-fg-dim)' }}>
              证据覆盖:{selectedJob.capabilities.map((item) => `${item.capability}=${item.state}${item.reason ? `(${item.reason})` : ''}`).join('、')}
            </div>
          )}
          {SUCCESS_STATUSES.has(selectedJob.status) && <div className="flex flex-wrap gap-2">
            {selectedJob.outputs?.note_path && (
              <button type="button" data-testid="vk-output-note" disabled={openingOutput !== null} onClick={() => { void openOutput(selectedJob.outputs!.note_path!, '知识笔记') }} className={outlineButton} style={outlineStyle}>笔记</button>
            )}
            {selectedJob.outputs?.audit_path && (
              <button type="button" data-testid="vk-output-audit" disabled={openingOutput !== null} onClick={() => { void openOutput(selectedJob.outputs!.audit_path!, '证据审计') }} className={outlineButton} style={outlineStyle}>Audit</button>
            )}
            {(selectedJob.outputs?.product_artifacts ?? []).map((artifact, index) => (
              <span key={artifact.sha256} className="flex gap-1">
                <button type="button" data-testid={`vk-output-product-json-${index}`} disabled={openingOutput !== null} onClick={() => { void openOutput(artifact.json, `${artifact.preset} JSON`) }} className={outlineButton} style={outlineStyle}>{artifact.preset} JSON</button>
                <button type="button" data-testid={`vk-output-product-md-${index}`} disabled={openingOutput !== null} onClick={() => { void openOutput(artifact.markdown, `${artifact.preset} MD`) }} className={outlineButton} style={outlineStyle}>{artifact.preset} MD</button>
              </span>
            ))}
          </div>}
        </div>
      )}
      {actionError && <div data-testid="vk-action-error" className="mb-4 text-xs" style={{ color: 'var(--color-danger)' }}>{actionError}</div>}

      {/* 知识库查询 */}
      <div className="rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-2 text-sm font-medium">知识库查询</div>
        {/* 按钮那侧要 shrink-0:输入框带 w-full,在 flex 里会一路挤压兄弟节点,
            按钮被压到只剩一个字宽,「检索」两字竖排成一列(打包版实测)。 */}
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
            className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
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

      {outputViewer && (
        <div
          data-testid="vk-output-viewer"
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          style={{ background: 'rgba(0, 0, 0, 0.68)' }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeOutputViewer()
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="vk-output-viewer-title"
            className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg"
            style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
          >
            <header className="flex shrink-0 items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--color-line)' }}>
              <h2 id="vk-output-viewer-title" className="min-w-0 flex-1 truncate text-sm font-medium">{outputViewer.title}</h2>
              <button
                type="button"
                data-testid="vk-output-viewer-copy"
                onClick={() => {
                  void copyText(outputViewer.content).then((copied) => {
                    if (copied) setOutputCopied(true)
                    else setActionError('复制内容失败')
                  })
                }}
                className="vk-output-copy-button"
              >
                <Copy size={14} aria-hidden="true" />
                <span>{outputCopied ? '已复制' : '复制内容'}</span>
              </button>
              <motion.button
                type="button"
                data-testid="vk-output-viewer-download"
                data-state={outputDownloadProgress !== null ? 'downloading' : outputDownloadDone ? 'done' : 'idle'}
                onClick={() => { void downloadOutput() }}
                onMouseEnter={() => setOutputDownloadHovered(true)}
                onMouseLeave={() => setOutputDownloadHovered(false)}
                aria-label={outputDownloadProgress !== null ? '取消下载' : '下载至本地'}
                aria-busy={outputDownloadProgress !== null}
                className="vk-output-download-button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 600, damping: 25 }}
              >
                {outputDownloadProgress !== null && (
                  <span
                    data-testid="vk-output-download-progress"
                    className="vk-output-download-progress"
                    style={{ width: `${outputDownloadProgress}%` }}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(outputDownloadProgress)}
                  />
                )}
                <span className="vk-output-download-content">
                  {outputDownloadProgress !== null ? (
                    <span>{Math.round(outputDownloadProgress)}% · 点击取消</span>
                  ) : (
                    <>
                      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                        <AnimatePresence mode="popLayout" initial={false}>
                          <motion.span
                            key={outputDownloadDone || outputDownloadHovered ? 'check' : 'download'}
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.5, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
                            className="absolute inset-0 flex items-center justify-center"
                          >
                            {outputDownloadDone || outputDownloadHovered
                              ? <Check className="h-4 w-4" />
                              : <Download className="h-4 w-4" />}
                          </motion.span>
                        </AnimatePresence>
                      </span>
                      <span>{outputDownloadDone ? '已保存' : '下载至本地'}</span>
                    </>
                  )}
                </span>
              </motion.button>
              <button
                type="button"
                data-testid="vk-output-viewer-close"
                onClick={closeOutputViewer}
                aria-label="关闭结果"
                title="关闭"
                className="rounded px-2 py-1 text-lg leading-none"
                style={{ color: 'var(--color-fg-dim)' }}
              >
                ×
              </button>
            </header>
            <div data-testid="vk-output-viewer-content" className="vk-output-viewer-content min-h-0 flex-1 overflow-auto p-4">
              <Markdown>{outputViewer.content}</Markdown>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
