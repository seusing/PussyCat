import { useAppStore } from '../store/appStore'

export function HealthPill() {
  const mode = useAppStore((s) => s.mode)
  const demo = mode === 'demo'
  return (
    <span
      data-testid="health-pill"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm"
      style={{ background: 'var(--color-panel)', color: demo ? 'var(--color-warning)' : 'var(--color-success)' }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 8, background: 'currentColor' }} />
      {demo ? '演示模式' : '已连接'}
    </span>
  )
}
