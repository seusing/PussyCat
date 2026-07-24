import { createMockHost } from './mockHost'
import { createNodeBridgeHost, DEFAULT_BASE_URL } from './nodeBridgeHost'
import { liveCatalogSource, snapshotCatalogSource, type CatalogSource } from './catalogSource'
import type { HostBridge } from './types'

export * from './types'
export * from './mockHost'
export * from './nodeBridgeHost'
export * from './catalogSource'

export type HostEnvironment = Record<string, string | undefined>
export type HostSelection = {
  host: HostBridge
  catalogSource: CatalogSource
  mode: 'demo' | 'connected'
}

export function createHostSelection({ search = '', env = {} }: { search?: string; env?: HostEnvironment } = {}): HostSelection {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const selected = query.get('host') ?? env.VITE_HOST_MODE ?? 'mock'
  if (selected.toLowerCase() === 'node') {
    const baseUrl = env.VITE_NODE_HOST_URL ?? DEFAULT_BASE_URL
    return {
      host: createNodeBridgeHost({ baseUrl }),
      catalogSource: liveCatalogSource(baseUrl),
      mode: 'connected',
    }
  }
  return { host: createMockHost(), catalogSource: snapshotCatalogSource(), mode: 'demo' }
}
