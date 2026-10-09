// 灵感库在宿主上的文件存储客户端(server/inspiration-store.mjs)。渲染进程只跟本机 Host 说话。
import { HostRequestError } from '../../host/errors'
import type { InspirationPersistence } from './inspirationLibrary'

async function call(url: string, init?: RequestInit): Promise<{ exists?: unknown; library?: unknown }> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch {
    throw new HostRequestError('无法连接爪爪本地服务，请稍后重试')
  }
  const body = await response.json().catch(() => null) as { error?: unknown; reasonCode?: unknown; exists?: unknown; library?: unknown } | null
  if (!response.ok) {
    throw new HostRequestError(
      typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`,
      undefined,
      response.status,
      typeof body?.reasonCode === 'string' ? body.reasonCode : undefined,
    )
  }
  return body ?? {}
}

export function createHostInspirationPersistence(baseUrl: string): InspirationPersistence {
  const url = `${baseUrl.replace(/\/$/, '')}/inspiration/library`
  return {
    async load() {
      const body = await call(url)
      return { exists: body.exists === true, library: body.library }
    },
    async save(library) {
      await call(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(library),
      })
    },
  }
}
