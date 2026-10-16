// /opencli/release 的类型化客户端。版本比较与 npm 查询都在 Host(server/opencli-release.mjs),
// 前端只取结论、只渲染。
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

export type OpencliRelease = {
  checkedAt: number
  current: string
  latest: string
  updateAvailable: boolean
  releaseUrl: string
}

export async function fetchOpencliRelease(baseUrl = DEFAULT_BASE_URL, signal?: AbortSignal): Promise<OpencliRelease> {
  const response = await fetch(`${baseUrl}/opencli/release`, { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    throw new Error(typeof body?.error === 'string' && body.error ? body.error : `HTTP ${response.status}`)
  }
  return response.json() as Promise<OpencliRelease>
}
