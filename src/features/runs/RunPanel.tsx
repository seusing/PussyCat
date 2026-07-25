import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { StreamLog } from './StreamLog'
import { ResultsTable } from './ResultsTable'
import { copyPayloadFor } from '../../data/copyPayload'
import { CopyButton } from '../../components/CopyButton'
import { validate } from '../config/validation'

export function RunPanel({ onCancel, onRerun }: { onCancel: () => void; onRerun: () => void }) {
  const run = useAppStore((s) => s.currentRun)
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const [tab, setTab] = useState<'result' | 'log'>('log')
  const collapsed = useAppStore((s) => s.runPanelCollapsed)
  const setCollapsed = useAppStore((s) => s.setRunPanelCollapsed)
  const [detailOpen, setDetailOpen] = useState(false)
  useEffect(() => { setDetailOpen(false) }, [run?.id])
  if (!run) return <div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>

  const active = run.state === 'starting' || run.state === 'running' || run.state === 'cancelling'
  const columns = run.command.columns ?? []
  const showTable = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) > 0
  const terminal = run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled'
  const payload = terminal ? copyPayloadFor(run) : null
  const rerunVisible = terminal && selected?.command === run.command.command
  const rerunErrors = rerunVisible && selected ? validate(selected, values) : {}
  const rerunDisabled = Object.keys(rerunErrors).length > 0
  const rerunLabel = run.state === 'succeeded' ? '再次执行' : run.state === 'failed' ? '重试' : '重新执行'

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
          {payload && <CopyButton label={payload.label} getText={() => payload.text} testid="copy-run" />}
          {rerunVisible && (
            <button data-testid="rerun-button" disabled={rerunDisabled} onClick={onRerun}
              title={rerunDisabled ? '参数校验未通过，请回表单修正' : undefined}
              className="rounded-lg px-3 py-1 text-sm disabled:opacity-50"
              style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
              {rerunLabel}
            </button>
          )}
          <button data-testid="collapse-panel" onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? '展开面板' : '收起面板'}
            className="rounded-lg px-2 py-1 text-sm leading-none" style={{ color: 'var(--color-fg-dim)' }}>
            {collapsed ? '▾' : '×'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {run.error && (
            <div className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'var(--color-canvas)', color: 'var(--color-danger)' }}>
              <div className="flex items-center justify-between gap-2">
                <span>{run.error.summary}</span>
                {run.error.detail && (
                  <button data-testid="error-detail-toggle" onClick={() => setDetailOpen((o) => !o)}
                    className="shrink-0 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    {detailOpen ? '详情 ▴' : '详情 ▾'}
                  </button>
                )}
              </div>
              {detailOpen && run.error.detail && (
                <pre data-testid="error-detail" className="mt-2 max-h-48 overflow-auto text-xs" style={{ color: 'var(--color-fg-dim)' }}>{run.error.detail}</pre>
              )}
            </div>
          )}

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
