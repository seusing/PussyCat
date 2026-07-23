import AppShell from './components/AppShell'

export default function App() {
  return (
    <div data-testid="app-root" className="h-full">
      <AppShell
        nav={<div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>导航</div>}
        config={<div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>从左侧选择一个服务和命令</div>}
        runs={<div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>}
      />
    </div>
  )
}
