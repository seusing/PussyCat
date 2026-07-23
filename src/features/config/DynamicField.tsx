import type { ManifestArg } from '../../data/types'
import { inputKind } from '../../data/inputKind'

export function DynamicField({ arg, value, error, onChange }: {
  arg: ManifestArg; value: unknown; error?: string; onChange: (v: unknown) => void
}) {
  const kind = inputKind(arg)
  const base = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
  const style = { background: 'var(--color-canvas)', border: `1px solid ${error ? 'var(--color-danger)' : 'var(--color-line)'}`, color: 'var(--color-fg)' }
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-sm">{arg.name}{arg.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</span>
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
      {arg.help && <span className="mt-1 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>{arg.help}</span>}
      {error && <span data-testid={`error-${arg.name}`} className="mt-1 block text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  )
}
