import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import { validate } from './validation'
import { DynamicField } from './DynamicField'

export function CommandConfig({ onRun }: { onRun: () => void }) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!selected) return <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>从左侧选择一个服务和命令</div>

  const running = currentRun?.state === 'starting' || currentRun?.state === 'running' || currentRun?.state === 'cancelling'

  const handleRun = () => {
    const errs = validate(selected, values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      const first = selected.args.find((a) => errs[a.name])
      if (first) document.querySelector<HTMLElement>(`[data-testid="field-${first.name}"]`)?.focus()
      return
    }
    onRun()
  }

  return (
    <div>
      <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{selected.site} / {selected.name}</div>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{selected.name}</h2>
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
        {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
      </div>
      <p className="mb-4 text-sm" style={{ color: 'var(--color-fg-dim)' }}>{selected.description}</p>

      <div className="mb-4">
        {selected.args.map((arg) => (
          <DynamicField key={arg.name} arg={arg} value={values[arg.name]} error={errors[arg.name]}
            onChange={(v) => { setValue(arg.name, v); setErrors((e) => { const { [arg.name]: _drop, ...rest } = e; return rest }) }} />
        ))}
        {selected.args.length === 0 && <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>此命令无参数</div>}
      </div>

      <pre className="mb-4 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{commandPreview(selected, values)}</pre>

      <button data-testid="run-button" disabled={running} onClick={handleRun}
        className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--color-accent)', color: '#fff' }}>
        {running ? '运行中…' : '运行任务'}
      </button>
    </div>
  )
}
