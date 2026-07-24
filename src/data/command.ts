import type { CommandManifest, ManifestArg } from './types'

export type ArgToken = { kind: 'sub' | 'flag' | 'value'; text: string }
export const EXECUTION_FORMAT = 'json'

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}
function isBool(a: ManifestArg): boolean {
  return a.type === 'bool' || a.type === 'boolean'
}
function boolDefault(a: ManifestArg): boolean {
  return a.default === true || a.default === 'true'
}

export function buildTokens(cmd: CommandManifest, values: Record<string, unknown>): ArgToken[] {
  const toks: ArgToken[] = [
    { kind: 'sub', text: cmd.site },
    { kind: 'sub', text: cmd.name },
  ]
  const positional = cmd.args.filter((a) => a.positional)
  const flags = cmd.args.filter((a) => !a.positional)

  // positional：按声明顺序，非 bool，空则跳过（validation 已拦"中空+后有值"）
  for (const a of positional) {
    if (isBool(a)) continue
    if (!isEmpty(values[a.name])) toks.push({ kind: 'value', text: String(values[a.name]) })
  }
  // flags
  for (const a of flags) {
    if (isBool(a)) {
      // A missing key means the caller did not provide this flag at all;
      // do not materialize an implicit false merely to compare defaults.
      if (!Object.prototype.hasOwnProperty.call(values, a.name)) continue
      const desired = values[a.name] === true
      if (desired !== boolDefault(a)) {
        toks.push({ kind: 'flag', text: `--${a.name}` })
        toks.push({ kind: 'value', text: String(desired) })   // 显式 true|false
      }
      continue
    }
    if (isEmpty(values[a.name])) continue
    toks.push({ kind: 'flag', text: `--${a.name}` })
    toks.push({ kind: 'value', text: String(values[a.name]) })
  }
  // Preview and execution share this universal output flag. The real Host
  // parses stdout into DoneEvent.result and therefore requires stable JSON.
  toks.push({ kind: 'flag', text: '-f' })
  toks.push({ kind: 'value', text: EXECUTION_FORMAT })
  return toks
}

export function buildArgv(cmd: CommandManifest, values: Record<string, unknown>): string[] {
  return buildTokens(cmd, values).map((t) => t.text)
}

function quote(s: string): string {
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function commandPreview(cmd: CommandManifest, values: Record<string, unknown>): string {
  const toks = buildTokens(cmd, values)
  const body = toks.map((t) => (t.kind === 'flag' ? t.text : quote(t.text))).join(' ')
  return `opencli ${body}`
}
