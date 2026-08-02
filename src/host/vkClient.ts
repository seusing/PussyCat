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
}

export interface VkRuntimeDetectResponse {
  candidates: VkRuntimeCandidate[]
  checkedAt: string
}

export async function fetchVkRuntimeStatus(baseUrl = DEFAULT_BASE_URL): Promise<VkRuntimeStatus> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/status`)
  return parseVkResponse<VkRuntimeStatus>(response, '解析引擎状态获取失败')
}

export async function postVkRuntimeInstall(baseUrl = DEFAULT_BASE_URL): Promise<VkRuntimeStatus> {
  const response = await fetch(`${baseUrl}/vk/v1/runtime/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
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
