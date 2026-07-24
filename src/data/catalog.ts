import type { CommandManifest, CatalogSnapshot } from './types'
import { assertCatalogCommands } from './catalogSchema'

export class CatalogError extends Error {}

export function assertSnapshot(x: unknown): CatalogSnapshot {
  const s = x as any
  if (s?.schemaVersion !== 1) throw new CatalogError(`schemaVersion 不支持：${s?.schemaVersion}`)
  try {
    assertCatalogCommands(s.commands)
  } catch (e) {
    throw new CatalogError(e instanceof Error ? e.message : String(e))   // 保持对外契约仍抛 CatalogError
  }
  return s as CatalogSnapshot
}

export async function loadCatalog(opts: { cache?: RequestCache; fetchImpl?: typeof fetch } = {}): Promise<CatalogSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl('/catalog.snapshot.json', opts.cache ? { cache: opts.cache } : undefined)
  if (!res.ok) throw new CatalogError(`加载 catalog 失败：${res.status}`)
  return assertSnapshot(await res.json())
}

export function groupBySite(cmds: CommandManifest[]): Array<{ site: string; commands: CommandManifest[] }> {
  const map = new Map<string, CommandManifest[]>()
  for (const cmd of cmds) {
    const list = map.get(cmd.site) ?? []
    list.push(cmd)
    map.set(cmd.site, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([site, commands]) => ({ site, commands }))
}

export function searchCommands(cmds: CommandManifest[], q: string): CommandManifest[] {
  const query = q.trim().toLowerCase()
  if (!query) return cmds
  return cmds.filter((cmd) => {
    const hay = [
      cmd.site, cmd.name, cmd.description, cmd.domain ?? '',
      ...(cmd.aliases ?? []),
    ].join(' ').toLowerCase()
    return hay.includes(query)
  })
}
