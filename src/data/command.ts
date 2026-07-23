import type { CommandManifest, ManifestArg } from './types'

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

export function buildArgv(cmd: CommandManifest, values: Record<string, unknown>): string[] {
  const argv: string[] = [cmd.site, cmd.name]
  const positional = cmd.args.filter((a) => a.positional)
  const flags = cmd.args.filter((a) => !a.positional)

  const pushValue = (a: ManifestArg) => {
    const v = values[a.name]
    if (a.type === 'bool' || a.type === 'boolean') {
      if (v === true) argv.push(`--${a.name}`)
      return
    }
    if (isEmpty(v)) return
    if (a.positional) argv.push(String(v))
    else argv.push(`--${a.name}`, String(v))
  }

  for (const a of positional) {
    if (a.type === 'bool' || a.type === 'boolean') continue
    if (!isEmpty(values[a.name])) argv.push(String(values[a.name]))
  }
  for (const a of flags) pushValue(a)
  return argv
}

function quote(s: string): string {
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function commandPreview(cmd: CommandManifest, values: Record<string, unknown>): string {
  const [site, name, ...rest] = buildArgv(cmd, values)
  const tail = rest.map((tok) => (tok.startsWith('--') ? tok : quote(tok))).join(' ')
  return `opencli ${site} ${name}${tail ? ' ' + tail : ''}`
}
