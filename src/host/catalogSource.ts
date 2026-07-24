import { loadCatalog, assertSnapshot, CatalogError } from '../data/catalog'
import type { CatalogSnapshot } from '../data/types'

export type CatalogLoadResult = { snapshot: CatalogSnapshot; degraded?: string }
export type CatalogSource = {
  kind: 'snapshot' | 'live'
  load(): Promise<CatalogLoadResult>
}

export function snapshotCatalogSource(fetchImpl?: typeof fetch): CatalogSource {
  return {
    kind: 'snapshot',
    async load() {
      // fetchImpl 未注入时不在构造期捕获全局 fetch——传 undefined 给 loadCatalog,
      // 由它在每次调用时解析当前全局(修复默认参数早绑定:测试挂载后换桩读不到)
      return { snapshot: await loadCatalog({ cache: 'no-store', fetchImpl }) }
    },
  }
}

// live 失败自动降级 snapshot(决策⑥),degraded 带原因供 UI 区分「真刷新成功」与「降级」
export function liveCatalogSource(baseUrl: string, fetchImpl?: typeof fetch): CatalogSource {
  const base = baseUrl.replace(/\/$/, '')
  return {
    kind: 'live',
    async load() {
      const f = fetchImpl ?? fetch   // 调用时才解析全局,同上
      try {
        const res = await f(`${base}/catalog`)
        if (!res.ok) throw new CatalogError(`刷新目录失败：HTTP ${res.status}`)
        return { snapshot: assertSnapshot(await res.json()) }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const snapshot = await loadCatalog({ cache: 'no-store', fetchImpl })   // 双败则整体抛出
        return { snapshot, degraded: `Host 目录不可达，已降级本地快照：${reason}` }
      }
    },
  }
}
