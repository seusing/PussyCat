import type { ReactNode } from 'react'
import { HealthPill } from './HealthPill'

export default function AppShell({ nav, config, runs, catalogStatus, catalogError, onRetryCatalog, headerActions, baseUrl }: {
  nav: ReactNode
  config: ReactNode
  runs: ReactNode
  catalogStatus: 'loading' | 'ready' | 'error'
  catalogError?: string
  onRetryCatalog: () => void
  headerActions?: ReactNode
  baseUrl?: string
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="font-semibold">OpenCLI App</div>
        <div className="flex items-center gap-3">
          {headerActions}
          <HealthPill baseUrl={baseUrl} />
        </div>
      </header>

      {catalogStatus === 'loading' && (
        <div data-testid="catalog-loading" className="flex flex-1 items-center justify-center text-sm" style={{ color: 'var(--color-fg-dim)' }}>
          正在加载命令目录…
        </div>
      )}

      {catalogStatus === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <div style={{ color: 'var(--color-danger)' }}>{catalogError ?? '加载命令目录失败'}</div>
          <button
            data-testid="catalog-retry"
            onClick={onRetryCatalog}
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            重试
          </button>
        </div>
      )}

      {catalogStatus === 'ready' && (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '280px minmax(520px, 1fr) 360px' }}>
          <aside data-testid="col-nav" className="min-h-0 overflow-auto border-r" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{nav}</aside>
          <main data-testid="col-config" className="min-h-0 overflow-auto p-4">{config}</main>
          <section data-testid="col-runs" className="min-h-0 overflow-auto border-l" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{runs}</section>
        </div>
      )}
    </div>
  )
}
