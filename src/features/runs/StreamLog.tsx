import type { OutputEvent } from '../../host/types'

export function StreamLog({ lines }: { lines: OutputEvent[] }) {
  return (
    <div data-testid="stream-log" className="run-log">
      {lines.map((l) => (
        <div key={l.seq} className={l.stream === 'stderr' ? 'is-stderr' : undefined}>{l.text}</div>
      ))}
      {lines.length === 0 && <div className="run-log-empty">暂无输出</div>}
    </div>
  )
}
