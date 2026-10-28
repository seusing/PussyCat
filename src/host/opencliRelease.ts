// /opencli/release 与 /opencli/update 的类型化客户端。版本比较、npm 查询与安装流程都在 Host
// (server/opencli-release.mjs 等),前端只取结论、只渲染。
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

export type OpencliRelease = {
  checkedAt: number
  /** 当前生效的版本,等于 active。 */
  current: string
  latest: string
  updateAvailable: boolean
  releaseUrl: string
  /** 当前生效的 OpenCLI 版本。 */
  active: string
  /** 安装包内置的版本;active 与它不同说明已经应用内更新过。 */
  bundled: string
}

export type OpencliUpdateStage = 'resolve' | 'download' | 'install' | 'native' | 'prune' | 'verify' | 'switch' | 'done'

export type OpencliUpdateJob = {
  id: string
  version: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage: OpencliUpdateStage
  receivedBytes: number
  totalBytes: number | null
  /** Host 算好的 0-100 总进度,界面直接用。 */
  percent: number
  /** 只在 failed 时有。 */
  error?: { summary: string; detail?: string }
  warnings: Array<{ code: string; message: string }>
  startedAt: number
  finishedAt: number | null
}

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  return new Error(typeof body?.error === 'string' && body.error ? body.error : `HTTP ${response.status}`)
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw await failure(response)
  return response.json() as Promise<T>
}

// Host 的 POST 一律要求 application/json,没有参数的接口也发空对象。
const post = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchOpencliRelease(baseUrl = DEFAULT_BASE_URL, signal?: AbortSignal): Promise<OpencliRelease> {
  return request(baseUrl, '/opencli/release', { signal })
}

export async function startOpencliUpdate(version: string, baseUrl = DEFAULT_BASE_URL): Promise<OpencliUpdateJob> {
  return (await request<{ job: OpencliUpdateJob }>(baseUrl, '/opencli/update', post({ version }))).job
}

export async function fetchOpencliUpdate(baseUrl = DEFAULT_BASE_URL, signal?: AbortSignal): Promise<OpencliUpdateJob | null> {
  return (await request<{ job: OpencliUpdateJob | null }>(baseUrl, '/opencli/update', { signal })).job
}

export async function cancelOpencliUpdate(baseUrl = DEFAULT_BASE_URL): Promise<OpencliUpdateJob> {
  return (await request<{ job: OpencliUpdateJob }>(baseUrl, '/opencli/update/cancel', post())).job
}

/** 退回安装包内置版本。 */
export async function rollbackOpencliRelease(baseUrl = DEFAULT_BASE_URL): Promise<void> {
  await request<{ active: null }>(baseUrl, '/opencli/rollback', post())
}
