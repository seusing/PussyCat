// /vk/v1/* 的类型化客户端。React 永不直连 Python、永不接触 sidecar token——
// 一切经 Node Host 白名单代理(认证由 Node 注入)。错误映射沿用 HostRequestError。
import { HostRequestError } from './errors'
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

export interface VkHealth {
  status: string
  reasonCode: string
  summary: string
  detail?: string
  apiVersion: string | null
  packageVersion: string | null
  capabilities: VkRuntimeCapability[]
  checkedAt: string
  retryable: boolean
}

export interface VkRuntimeCapability {
  capability: string
  runtime: string
  detail: string | null
}

export interface VkProcessingRequest {
  schema_version: string
  source: string
  intent: string
  preset: string
  preset_version: string
  content_type: string
  media_policy: string
  output_targets: string[]
  language: string
  quality_profile: string
  budget_profile: string
  provider_profile: string
  audit_requested: boolean
  requested_capabilities: string[]
  user_metadata: Record<string, unknown>
  max_cost_cny: number | null
}

export interface VkPreviewProjection {
  source: string
  preset: string
  content_type?: string
  media_policy?: string
  quality_profile?: string
  budget_profile?: string
  audit?: boolean
  capabilities?: string[]
  max_cost_cny?: number
  user_metadata?: Record<string, unknown>
}

export interface VkJobRow {
  job_id: string
  kind: string
  status: string
  submitted_at: string
  finished_at: string | null
  parent_job_id: string | null
  cache_bypass: boolean
  run_id?: string
  cost_cny?: number
}

export interface VkProductArtifact {
  preset: string
  schema_name: string
  sha256: string
  json: string
  markdown: string
}

export interface VkJobOutputs {
  note_path: string | null
  request_path: string | null
  audit_path: string | null
  product_artifacts: VkProductArtifact[]
}

export interface VkCapabilityResult {
  capability: string
  state: string
  reason: string | null
  artifact_ids?: string[]
  evidence_refs?: string[]
  schema_version?: string
}

export interface VkBudgetStop {
  reason: string
  stage?: string
  route?: string
  limit_cny: number | null
  actual_cost_cny: number | null
  estimated_next_call_cny?: number | null
}

export interface VkJobView {
  job_id: string
  kind: string
  status: string
  submitted_at: string
  finished_at: string | null
  cancel_requested?: boolean
  error?: string | null
  parent_job_id: string | null
  cache_bypass: boolean
  run_id?: string
  cost_cny?: number
  request_fingerprint?: string | null
  budget_stop?: VkBudgetStop | null
  capabilities?: VkCapabilityResult[]
  request?: { source?: string; preset?: string } & Record<string, unknown>
  outputs?: Partial<VkJobOutputs>
}

export interface VkQueryCitation {
  document_id: string
  source_revision_id: string
  kind: string
  artifact_sha256: string
  [key: string]: unknown
}

export interface VkQueryAnswer {
  status: string
  answer: string
  citations?: VkQueryCitation[]
  [key: string]: unknown
}

// 1.3.0 契约:投影提交(全字段+原始 source)是正路;{"request": …} 保留给
// 干净源/upload: 的程序化通道。二者都必须携带幂等键与 client_job_id。
export type VkSubmitPayload = Record<string, unknown> & {
  idempotency_key: string
  client_job_id: string
}

// 历史任务 id 形如 `run:<run_id>`;冒号是 URL path 的合法字符(RFC 3986 pchar),
// encodeURIComponent 会把它变成 %3A 并被代理原样转发,vk 端就查无此 job 了。
function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':')
}

async function parseVkResponse<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; detail?: unknown; reasonCode?: unknown }
    const summary = typeof record.error === 'string' ? record.error : fallback
    throw new HostRequestError(
      summary,
      typeof record.detail === 'string' ? record.detail : undefined,
      response.status,
      typeof record.reasonCode === 'string' ? record.reasonCode : undefined,
    )
  }
  return body as T
}

function jsonInit(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

export async function fetchVkHealth(baseUrl = DEFAULT_BASE_URL): Promise<VkHealth> {
  const response = await fetch(`${baseUrl}/vk/v1/health`)
  return parseVkResponse<VkHealth>(response, '视频解析健康检查失败')
}

export async function postVkPreview(
  projection: VkPreviewProjection,
  baseUrl = DEFAULT_BASE_URL,
): Promise<VkProcessingRequest> {
  const response = await fetch(`${baseUrl}/vk/v1/preview`, jsonInit(projection))
  return parseVkResponse<VkProcessingRequest>(response, '预检失败')
}

export async function postVkJob(
  payload: VkSubmitPayload,
  baseUrl = DEFAULT_BASE_URL,
): Promise<{ job_id: string; kind: string }> {
  const response = await fetch(`${baseUrl}/vk/v1/jobs`, jsonInit(payload))
  return parseVkResponse(response, '任务提交失败')
}

export async function fetchVkJobs(baseUrl = DEFAULT_BASE_URL): Promise<VkJobRow[]> {
  const response = await fetch(`${baseUrl}/vk/v1/jobs`)
  return parseVkResponse<VkJobRow[]>(response, '任务列表获取失败')
}

export async function fetchVkJob(jobId: string, baseUrl = DEFAULT_BASE_URL): Promise<VkJobView> {
  const response = await fetch(`${baseUrl}/vk/v1/jobs/${encodePathSegment(jobId)}`)
  return parseVkResponse<VkJobView>(response, '任务详情获取失败')
}

export async function postVkJobAction(
  jobId: string,
  action: 'cancel' | 'retry' | 'refresh',
  baseUrl = DEFAULT_BASE_URL,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${baseUrl}/vk/v1/jobs/${encodePathSegment(jobId)}/${action}`,
    jsonInit({}),
  )
  return parseVkResponse(response, '任务操作失败')
}

export async function fetchVkDiagnostic(baseUrl = DEFAULT_BASE_URL): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/vk/v1/diagnostic`)
  return parseVkResponse(response, '诊断获取失败')
}

export async function postVkQuery(text: string, baseUrl = DEFAULT_BASE_URL): Promise<VkQueryAnswer> {
  const response = await fetch(`${baseUrl}/vk/v1/query`, jsonInit({ query: text }))
  return parseVkResponse<VkQueryAnswer>(response, '知识库查询失败')
}

export interface VkRuntimeStatus {
  state: string
  version: string | null
  reasonCode: string | null
  summary: string
  log: string[]
  checkedAt: string
  source?: string | null
  pythonPath?: string | null
  capabilities?: VkRuntimeCapability[]
}

export interface VkRuntimeCandidate {
  pythonPath: string
  source: string
  version: string | null
  apiVersion: string | null
  schemaVersion: string | null
  capabilities: VkRuntimeCapability[]
  compatible: boolean
  reason: string | null
  active?: boolean
}

export interface VkRuntimeDetectResponse {
  candidates: VkRuntimeCandidate[]
  checkedAt: string
}

export async function fetchVkRuntimeStatus(baseUrl = DEFAULT_BASE_URL): Promise<VkRuntimeStatus> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/status`)
  return parseVkResponse<VkRuntimeStatus>(response, '解析引擎状态获取失败')
}

/** rebuild=true 才会在**已装**状态下真正重建;否则 Host 按幂等处理、直接返回现状。 */
export async function postVkRuntimeInstall(
  baseUrl = DEFAULT_BASE_URL,
  { rebuild = false }: { rebuild?: boolean } = {},
): Promise<VkRuntimeStatus> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/install`, jsonInit({ rebuild }))
  return parseVkResponse<VkRuntimeStatus>(response, '解析引擎安装启动失败')
}

export async function postVkRuntimeDetect(baseUrl = DEFAULT_BASE_URL): Promise<VkRuntimeDetectResponse> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/detect`, jsonInit({}))
  return parseVkResponse<VkRuntimeDetectResponse>(response, '已有环境检测失败')
}

export async function postVkRuntimeAdopt(pythonPath: string, baseUrl = DEFAULT_BASE_URL): Promise<VkRuntimeStatus> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/adopt`, jsonInit({ pythonPath }))
  return parseVkResponse<VkRuntimeStatus>(response, '已有环境接入失败')
}

export function vkOutputPath(outputId: string): string {
  return `/vk/v1/outputs/${encodeURIComponent(outputId)}`
}

// 产物下载:fetch(带 Origin,过 Host 白名单)→ blob → 对象 URL 新开页。
// window.open 直链不带 fetch 语义,统一走这里。
export async function downloadVkOutput(outputId: string, baseUrl = DEFAULT_BASE_URL): Promise<void> {
  const response = await fetch(`${baseUrl}${vkOutputPath(outputId)}`)
  if (!response.ok) throw new HostRequestError('产物下载失败', undefined, response.status)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// —— 模型通道配置(sidecar api 1.5.0)——
// 前端**不持有** key:读回来的只有「有没有、从哪来」。明文只在用户点「显示」时
// 单独取一次(revealVkProviderKey),不入 store、不落 localStorage。

export interface VkChannel {
  id: string
  name: string
  base_url: string
  model_id: string
  key_env: string
  /** 接口风格 —— 决定打 /chat/completions 还是 /responses,以及用哪种认证头。 */
  api_style: string
  /** 有可用 key(应用内存过 或 环境变量里有);永远不是 key 本身。 */
  key_stored: boolean
  /** 存过的 key 的打码值(sk-xxx••••••xxxx)。空输入框会被当成"没设过",所以要看得见。 */
  key_masked: string
  /** 来自系统环境变量 —— 它优先级更高,用户要改得去环境变量而不是这张表单。 */
  key_from_environment: boolean
  reasoning_effort: string
  reasoning_effort_explicit: boolean
  extra_headers: Record<string, string>
}

export interface VkImportableChannel {
  id: string
  name: string
  base_url: string
  model_id: string
  key_env: string
  key_stored: boolean
}

/** cc-switch 里的一条中转站配置。**只有打码 key** —— 明文得单独按 ref 取一次。 */
export interface VkCcSwitchCandidate {
  ref: string
  name: string
  /** codex / claude —— 决定了它的接口风格,界面上顺带说明来源。 */
  app_type: string
  base_url: string
  model_id: string
  api_style: string
  /** cc-switch 里当前正在用的那条。 */
  is_current: boolean
  masked_key: string
  website_url: string
}

export interface VkCcSwitchScan {
  available: boolean
  path: string
  /** 读不到时的人话原因(没装 / 正被锁住)。 */
  reason: string
  /** 认得出但导不了的,附原因 —— 比让它凭空消失强。 */
  skipped: string[]
  candidates: VkCcSwitchCandidate[]
}

export interface VkCcSwitchImportResult {
  channel: {
    id: string
    name: string
    base_url: string
    model_id: string
    key_env: string
    api_style: string
    extra_headers: Record<string, string>
  }
  api_key: string
}

export interface VkProviderSettings {
  channels: VkChannel[]
  /** 角色 → 实际生效的通道 id(未显式指派时是默认通道)。 */
  roles: Record<string, string | null>
  /** 只含**显式**指派 —— 界面据此区分「指定了」与「跟随默认」。 */
  role_assignments: Record<string, string>
  role_labels: Record<string, string>
  role_hints: Record<string, string>
  /** 还没指到通道的角色 —— 界面据此点名,而不是笼统说"没配好"。 */
  unassigned_roles: string[]
  api_styles: { id: string; label: string }[]
  importable: VkImportableChannel[]
  cc_switch: VkCcSwitchScan
  configured: boolean
}

export interface VkProviderTestResult {
  ok: boolean
  reason_code: string
  message: string
  fix_hint?: string | null
  retryable?: boolean
  detail?: string | null
  models?: string[]
  base_url?: string
  normalization_notes?: string[]
  key_stored?: boolean
}

export interface VkProviderSaveResult {
  saved: boolean
  normalization_notes: string[]
  keys_written: string[]
  keys_injected: string[]
  configured: boolean
}

/** 每条通道可带 api_key:**不传该字段 = 不改动已存的那把**;传空串 = 清除。 */
export interface VkChannelPayload {
  id: string
  name: string
  base_url: string
  model_id: string
  key_env: string
  api_style?: string
  reasoning_effort?: string | null
  extra_headers?: Record<string, string>
  api_key?: string
}

export interface VkRevealResult {
  key_env: string
  found: boolean
  api_key?: string
  source: 'stored' | 'environment' | null
}

export async function fetchVkProviderSettings(baseUrl = DEFAULT_BASE_URL): Promise<VkProviderSettings> {
  const response = await fetch(`${baseUrl}/vk/v1/providers`)
  return parseVkResponse<VkProviderSettings>(response, '模型配置读取失败')
}

export async function saveVkProviderSettings(
  payload: { channels: VkChannelPayload[]; roles?: Record<string, string> },
  baseUrl = DEFAULT_BASE_URL,
): Promise<VkProviderSaveResult> {
  const response = await fetch(`${baseUrl}/vk/v1/providers`, jsonInit(payload))
  return parseVkResponse<VkProviderSaveResult>(response, '模型配置保存失败')
}

export async function testVkProvider(
  payload: { base_url: string; key_env?: string; api_key?: string; api_style?: string },
  baseUrl = DEFAULT_BASE_URL,
): Promise<VkProviderTestResult> {
  const response = await fetch(`${baseUrl}/vk/v1/providers/test`, jsonInit(payload))
  return parseVkResponse<VkProviderTestResult>(response, '连接测试失败')
}

/** 明文 key 的**唯一**取处 —— 只在用户点「显示」时调用。 */
export async function revealVkProviderKey(
  keyEnv: string, baseUrl = DEFAULT_BASE_URL,
): Promise<VkRevealResult> {
  const response = await fetch(`${baseUrl}/vk/v1/providers/reveal`, jsonInit({ key_env: keyEnv }))
  return parseVkResponse<VkRevealResult>(response, '读取 key 失败')
}

/** 按 ref 取一条 cc-switch 配置(含明文 key)填进表单。仍需用户按「保存」才落盘。 */
export async function importVkCcSwitchChannel(
  ref: string, takenIds: string[] = [], baseUrl = DEFAULT_BASE_URL,
): Promise<VkCcSwitchImportResult> {
  const response = await fetch(
    `${baseUrl}/vk/v1/providers/cc-switch`, jsonInit({ ref, taken_ids: takenIds }),
  )
  return parseVkResponse<VkCcSwitchImportResult>(response, '从 cc-switch 导入失败')
}
