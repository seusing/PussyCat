import { createMockHost } from './mockHost'
import { createNodeBridgeHost, DEFAULT_BASE_URL } from './nodeBridgeHost'
import { liveCatalogSource, snapshotCatalogSource, type CatalogSource } from './catalogSource'
import type { HostBridge } from './types'

export * from './types'
export * from './errors'      // HostRequestError 是 Host 公共错误契约(spec §6.1)
export * from './mockHost'
export * from './nodeBridgeHost'
export * from './catalogSource'

export type HostEnvironment = Record<string, string | undefined>
// Tauri 就绪后经 window.__OPENCLI_BOOT__ 注入(见 src-tauri/src/lib.rs、src/vite-env.d.ts);
// baseUrl 单一事实源起点(spec §6)——覆盖随机端口,消灭"目录能加载、顶栏却显示离线"的假离线。
export type HostBoot = { baseUrl?: string }
export type HostSelection = {
  host: HostBridge
  catalogSource: CatalogSource
  mode: 'demo' | 'connected'
  baseUrl: string
}

export function createHostSelection({ search = '', env = {}, boot }: { search?: string; env?: HostEnvironment; boot?: HostBoot } = {}): HostSelection {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const selected = query.get('host') ?? env.VITE_HOST_MODE ?? 'mock'
  // baseUrl 优先级:boot(Tauri 注入的真实随机端口) > env(VITE_NODE_HOST_URL) > 默认 43117(spec §6)。
  // mode 优先级:boot 存在即视为已连接(无视 query/env);否则沿用既有 query > env > 'mock' 顺序不变。
  const baseUrl = boot?.baseUrl ?? env.VITE_NODE_HOST_URL ?? DEFAULT_BASE_URL
  const wantsNode = Boolean(boot?.baseUrl) || selected.toLowerCase() === 'node'
  if (wantsNode) {
    return {
      host: createNodeBridgeHost({ baseUrl }),
      catalogSource: liveCatalogSource(baseUrl),
      mode: 'connected',
      baseUrl,
    }
  }
  // demo 模式 baseUrl 仍回落默认值:HealthPill 在 demo 下不 ping,值本身不被使用,但 HostSelection.baseUrl 契约在全场景下都非空。
  return { host: createMockHost(), catalogSource: snapshotCatalogSource(), mode: 'demo', baseUrl }
}
