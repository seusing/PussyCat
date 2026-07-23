import type { OutputEvent } from '../../host/types'

export function StreamLog({ lines }: { lines: OutputEvent[] }) {
  return (
    <div data-testid="stream-log" className="max-h-64 overflow-auto rounded-lg p-2 font-mono text-xs" style={{ background: 'var(--color-canvas)' }}>
      {lines.map((l) => (
        <div key={l.seq} style={{ color: l.stream === 'stderr' ? 'var(--color-danger)' : 'var(--color-fg)' }}>{l.text}</div>
      ))}
      {lines.length === 0 && <div style={{ color: 'var(--color-fg-dim)' }}>暂无输出</div>}
    </div>
  )
}
