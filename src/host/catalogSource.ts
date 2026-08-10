import { loadCatalog, assertSnapshot, CatalogError } from '../data/catalog'
import type { CatalogSnapshot } from '../data/types'
import type { PolicyDecision } from '../data/policy'

export type CatalogLoadResult = { snapshot: CatalogSnapshot; degraded?: string; decisions?: PolicyDecision[] }
export type CatalogLoadOptions = { refresh?: boolean }
export type CatalogSource = {
  kind: 'snapshot' | 'live'
  load(options?: CatalogLoadOptions): Promise<CatalogLoadResult>
}

export function snapshotCatalogSource(fetchImpl?: typeof fetch): CatalogSource {
  return {
    kind: 'snapshot',
    async load() {
      // fetchImpl 未注入时不在构造期捕获全局 fetch——传 undefined 给 loadCatalog,
      // 由它在每次调用时解析当前全局(修复默认参数早绑定:测试挂载后换桩读不到)
      // demo 模式没有 Host——不下发 decisions,前端整体标「未连接」而非编造判决(I-P1)
      return { snapshot: await loadCatalog({ cache: 'no-store', fetchImpl }) }
    },
  }
}

// live 拉取 /catalog/effective:snapshot 与 Host 判决同一个 envelope 下发(I-P4)。
// 失败自动降级 snapshot(决策⑥),degraded 带原因供 UI 区分「真刷新成功」与「降级」——
// 降级路径不下发 decisions、绝不构造 decision:前端不是执行准入的权威(I-P1)。
export function liveCatalogSource(baseUrl: string, fetchImpl?: typeof fetch): CatalogSource {
  const base = baseUrl.replace(/\/$/, '')
  return {
    kind: 'live',
    async load(options = {}) {
      const f = fetchImpl ?? fetch   // 调用时才解析全局,同上
      try {
        const suffix = options.refresh ? '?refresh=1' : ''
        const res = await f(`${base}/catalog/effective${suffix}`)
        if (!res.ok) throw new CatalogError(`刷新目录失败：HTTP ${res.status}`)
        const body = await res.json()
        const snapshot = assertSnapshot(body?.snapshot)
        const decisions = body?.policy?.decisions
        if (!Array.isArray(decisions)) throw new CatalogError('目录判决格式无效：decisions 不是数组')
        return { snapshot, decisions }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const snapshot = await loadCatalog({ cache: 'no-store', fetchImpl })   // 双败则整体抛出(仍不带 decisions)
        return { snapshot, degraded: `Host 目录不可达，已降级本地快照：${reason}` }
      }
    },
  }
}
