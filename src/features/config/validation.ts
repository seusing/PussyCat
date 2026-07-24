import type { CommandManifest } from '../../data/types'

export function validate(cmd: CommandManifest, values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const a of cmd.args) {
    const v = values[a.name]
    const empty = v === undefined || v === null || v === ''
    if (a.required && empty) { errors[a.name] = '此字段必填'; continue }
    if (!empty && (a.type === 'int' || a.type === 'number' || a.type === 'float') && Number.isNaN(Number(v))) {
      errors[a.name] = '请输入数字'
    }
  }

  const pos = cmd.args.filter((a) => a.positional)
  for (let i = 0; i < pos.length; i++) {
    const empty = (v: unknown) => v === undefined || v === null || v === ''
    if (empty(values[pos[i].name]) && pos.slice(i + 1).some((p) => !empty(values[p.name]))) {
      errors[pos[i].name] = '位置参数不能跳过：填了后面的就必须先填它'
    }
  }

  return errors
}
