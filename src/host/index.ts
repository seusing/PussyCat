import { createMockHost } from './mockHost'
import { createNodeBridgeHost } from './nodeBridgeHost'
import type { HostBridge } from './types'

export * from './types'
export * from './mockHost'
export * from './nodeBridgeHost'

export type HostEnvironment = Record<string, string | undefined>
export type HostSelection = {
  host: HostBridge
  mode: 'demo' | 'connected'
}

export function createHostSelection({ search = '', env = {} }: { search?: string; env?: HostEnvironment } = {}): HostSelection {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const selected = query.get('host') ?? env.VITE_HOST_MODE ?? 'mock'
  if (selected.toLowerCase() === 'node') {
    return {
      host: createNodeBridgeHost({ baseUrl: env.VITE_NODE_HOST_URL }),
      mode: 'connected',
    }
  }
  return { host: createMockHost(), mode: 'demo' }
}
