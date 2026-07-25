export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function mergeManifestFields(list, manifest) {
  const byKey = new Map()
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
