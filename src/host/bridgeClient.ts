// /browser-bridge/* 的类型化客户端。判定逻辑全在 Host(server/browser-bridge-*.mjs),
// 前端只取结论、只渲染,不再解释 reasonCode 之外的东西。
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

// Host 投影后的桥接健康结构(server/browser-bridge-health.mjs)。
export type BridgeHealth = {
  checkedAt: number
  daemon: 'running' | 'stopped' | 'unreachable' | 'error'
  daemonVersion?: string
  extension: 'connected' | 'disconnected' | 'unknown'
  extensionVersion?: string
  profile: 'ready' | 'required' | 'disconnected' | 'unknown'
  profileCount: number
  opencliVersion?: string
  retryable: boolean
  reasonCode: string
  summary: string
}

export type RepairResult = {
  steps: { action: string; outcome: string; detail?: string }[]
  health: BridgeHealth
  repaired: boolean
  alreadyOk?: boolean
  needsProfileChoice?: boolean
  nextStep?: string
}

export type BridgeProfile = { name: string; isDefault: boolean; extensionVersion?: string }

type Outcome = { ok: boolean; reasonCode?: string }

export const CHROME_NOT_FOUND_TEXT = '没找到 Chrome，请先安装 Chrome'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export async function fetchBridgeHealth(baseUrl = DEFAULT_BASE_URL, signal?: AbortSignal): Promise<BridgeHealth> {
  return readJson<BridgeHealth>(await fetch(`${baseUrl}/browser-bridge/health`, { signal }))
}

export async function repairBridge(baseUrl = DEFAULT_BASE_URL, signal?: AbortSignal): Promise<RepairResult> {
  return readJson<RepairResult>(await fetch(`${baseUrl}/browser-bridge/repair`, { method: 'POST', signal }))
}

/** 在 Chrome 里打开扩展的应用店页面(地址由 Host 写死)。 */
export async function openExtensionPage(baseUrl = DEFAULT_BASE_URL): Promise<Outcome> {
  return readJson<Outcome>(await fetch(`${baseUrl}/browser-bridge/open-extension-page`, { method: 'POST' }))
}

/** 「安装扩展」没成功时给用户看的话。 */
export function extensionPageFailureText(reasonCode: string | undefined): string {
  return reasonCode === 'chrome-not-found' ? CHROME_NOT_FOUND_TEXT : '没能打开 Chrome，请手动打开 Chrome 应用店搜索 OpenCLI'
}

export async function fetchBridgeProfiles(
  baseUrl = DEFAULT_BASE_URL,
): Promise<{ ok: true; profiles: BridgeProfile[] } | { ok: false; reasonCode?: string }> {
  return readJson(await fetch(`${baseUrl}/browser-bridge/profiles`))
}

export async function useBridgeProfile(name: string, baseUrl = DEFAULT_BASE_URL): Promise<Outcome> {
  return readJson<Outcome>(await fetch(`${baseUrl}/browser-bridge/profiles/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias: name }),
  }))
}
