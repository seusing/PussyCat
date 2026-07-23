import type { CommandManifest } from './types'

export type RawManifestCmd = {
  site: string
  name: string
  navigateBefore?: boolean | string
  defaultWindowMode?: string
  type?: string
  modulePath?: string
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function mergeManifestFields(
  list: CommandManifest[],
  manifest: RawManifestCmd[],
): CommandManifest[] {
  const byKey = new Map<string, RawManifestCmd>()
  for (const m of manifest) byKey.set(`${m.site}/${m.name}`, m)
  return list.map((cmd) => {
    const m = byKey.get(`${cmd.site}/${cmd.name}`)
    if (!m) return cmd
    return {
      ...cmd,
      navigateBefore: cmd.navigateBefore ?? m.navigateBefore,
      defaultWindowMode: cmd.defaultWindowMode ?? m.defaultWindowMode,
      type: cmd.type ?? m.type,
      modulePath: cmd.modulePath ?? m.modulePath,
    }
  })
}
