import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { StreamLog } from './StreamLog'
import { ResultsTable } from './ResultsTable'

export function RunPanel({ onCancel }: { onCancel: () => void }) {
  const run = useAppStore((s) => s.currentRun)
  const [tab, setTab] = useState<'result' | 'log'>('log')
  const [collapsed, setCollapsed] = useState(false)   // ⑦b 纯视图 flag，与 run.state 无关；不调 cancel、不改状态机
  if (!run) return <div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>

  const active = run.state === 'starting' || run.state === 'running' || run.state === 'cancelling'
  const columns = run.command.columns ?? []
  const showTable = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) > 0

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span data-testid="run-state" className="text-sm font-medium">{stateLabel(run.state)}</span>
        <div className="flex items-center gap-2">
          {active && (
            <button data-testid="cancel-button" onClick={onCancel} disabled={run.state === 'cancelling'}
              className="rounded-lg px-3 py-1 text-sm disabled:opacity-50" style={{ background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>
              {run.state === 'cancelling' ? '正在取消…' : '取消执行'}
            </button>
          )}
          <button data-testid="collapse-panel" onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? '展开面板' : '收起面板'}
            className="rounded-lg px-2 py-1 text-sm leading-none" style={{ color: 'var(--color-fg-dim)' }}>
            {collapsed ? '▾' : '×'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {run.error && <div className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'var(--color-canvas)', color: 'var(--color-danger)' }}>{run.error.summary}</div>}

          {showTable && (
            <div className="mb-2 flex gap-2 text-xs">
              <button onClick={() => setTab('result')} style={{ color: tab === 'result' ? 'var(--color-accent)' : 'var(--color-fg-dim)' }}>表格结果</button>
              <button onClick={() => setTab('log')} style={{ color: tab === 'log' ? 'var(--color-accent)' : 'var(--color-fg-dim)' }}>完整日志</button>
            </div>
          )}

          {showTable && tab === 'result'
            ? <ResultsTable columns={columns} rows={run.result ?? []} />
            : <StreamLog lines={run.lines} />}
        </>
      )}
    </div>
  )
}

function stateLabel(s: string): string {
  return ({ starting: '正在启动…', running: '运行中…', cancelling: '正在取消…', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[s] ?? s
}
