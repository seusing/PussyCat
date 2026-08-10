import type { ManifestArg } from '../../data/types'
import { inputKind } from '../../data/inputKind'
import { argHelp } from '../../data/zhCopy'

export function DynamicField({ arg, value, error, onChange, commandKey }: {
  arg: ManifestArg; value: unknown; error?: string; onChange: (v: unknown) => void; commandKey?: string
}) {
  const kind = inputKind(arg)
  // 参数说明**逐参数**回落:一条命令译了 description 不代表每个参数都译了(见 data/zhCopy.ts)。
  // commandKey 缺省时直接用原文——本组件也被无上下文地单独渲染过。
  const help = commandKey ? argHelp(commandKey, arg.name, arg.help) : arg.help
  const base = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
  const style = { background: 'var(--color-canvas)', border: `1px solid ${error ? 'var(--color-danger)' : 'var(--color-line)'}`, color: 'var(--color-fg)' }
  return (
    <label className="mb-3 block">
      <span data-testid={`field-label-${arg.name}`} className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span>{arg.name}{arg.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</span>
        {help && <span data-testid={`field-help-${arg.name}`} className="min-w-0 text-xs" style={{ color: 'var(--color-fg-dim)', overflowWrap: 'anywhere' }}>{help}</span>}
      </span>
      {kind === 'switch' ? (
        <input data-testid={`field-${arg.name}`} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      ) : kind === 'select' ? (
        <select data-testid={`field-${arg.name}`} className={base} style={style} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="" />
          {(arg.choices ?? []).map((ch) => {
            const val = typeof ch === 'string' ? ch : ch.value
            const label = typeof ch === 'string' ? ch : ch.label
            return <option key={val} value={val}>{label}</option>
          })}
        </select>
      ) : (
        <input data-testid={`field-${arg.name}`} className={base} style={style}
          type={kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
      )}
      {error && <span data-testid={`error-${arg.name}`} className="mt-1 block text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  )
}
