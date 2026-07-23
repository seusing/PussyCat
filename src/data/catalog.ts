import type { CommandManifest, CatalogSnapshot } from './types'

export async function loadCatalog(): Promise<CatalogSnapshot> {
  const res = await fetch('/catalog.snapshot.json')
  if (!res.ok) throw new Error(`加载 catalog 失败：${res.status}`)
  return (await res.json()) as CatalogSnapshot
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
