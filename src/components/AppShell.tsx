import type { ReactNode } from 'react'
import { HealthPill } from './HealthPill'

export default function AppShell({ nav, config, runs }: { nav: ReactNode; config: ReactNode; runs: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="font-semibold">OpenCLI App</div>
        <HealthPill />
      </header>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '280px minmax(520px, 1fr) 360px' }}>
        <aside data-testid="col-nav" className="min-h-0 overflow-auto border-r" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{nav}</aside>
        <main data-testid="col-config" className="min-h-0 overflow-auto p-4">{config}</main>
        <section data-testid="col-runs" className="min-h-0 overflow-auto border-l" style={{ borderColor: 'var(--color-line)', background: 'var(--color-panel)' }}>{runs}</section>
      </div>
    </div>
  )
}
