import { useEffect, useMemo, useState } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import { useAppStore } from '../../store/appStore'
import { StreamLog } from './StreamLog'
import { ResultsTable } from './ResultsTable'
import { copyPayloadFor } from '../../data/copyPayload'
import { CopyButton } from '../../components/CopyButton'
import { validate } from '../config/validation'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { collectNoteLinks } from './noteLinks'

export function RunPanel({ onCancel, onRerun }: { onCancel: () => void; onRerun: () => void }) {
  const run = useAppStore((s) => s.currentRun)
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const [tab, setTab] = useState<'result' | 'log'>('log')
  const collapsed = useAppStore((s) => s.runPanelCollapsed)
  const setCollapsed = useAppStore((s) => s.setRunPanelCollapsed)
  const [detailOpen, setDetailOpen] = useState(false)
  const [savingLinks, setSavingLinks] = useState(false)
  useEffect(() => { setDetailOpen(false) }, [run?.id])
  const noteLinks = useMemo(
    () => run?.state === 'succeeded' ? collectNoteLinks(run.result ?? []) : { video: [], imageText: [], all: [] },
    [run?.result, run?.state],
  )
  if (!run) return <div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>

  const active = run.state === 'starting' || run.state === 'running' || run.state === 'cancelling'
  const columns = run.command.columns ?? []
  const showTable = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) > 0
  const terminal = run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled'
  const payload = terminal ? copyPayloadFor(run) : null
  const saveLinks = async () => {
    if (savingLinks || noteLinks.all.length === 0) return
    setSavingLinks(true)
    try {
      await saveTextFileAs('笔记链接.txt', `${noteLinks.all.join('\n')}\n`)
    } finally {
      setSavingLinks(false)
    }
  }
  const rerunVisible = terminal && selected?.command === run.command.command
  const rerunErrors = rerunVisible && selected ? validate(selected, values) : {}
  const rerunDisabled = Object.keys(rerunErrors).length > 0
  const rerunLabel = run.state === 'succeeded' ? '再次执行' : run.state === 'failed' ? '重试' : '重新执行'

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span data-testid="run-state" className="flex items-center gap-2 text-sm font-medium">
          {active && <ThinkingOrb state={orbState(run.state)} size={20} theme="dark" />}
          {stateLabel(run.state)}
        </span>
        <div className="flex items-center gap-2">
          {active && (
            <button data-testid="cancel-button" onClick={onCancel} disabled={run.state === 'cancelling'}
              className="rounded-lg px-3 py-1 text-sm disabled:opacity-50" style={{ background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>
              {run.state === 'cancelling' ? '正在取消…' : '取消执行'}
            </button>
          )}
          {payload && <CopyButton label={payload.label} getText={() => payload.text} testid="copy-run" />}
          {noteLinks.video.length > 0 && (
            <button
              data-testid="export-note-links"
              type="button"
              onClick={() => useAppStore.getState().setVkHandoff({
                url: noteLinks.video.join('\n'),
                commandKey: run.command.command,
                collectedAt: run.startedAt,
              })}
              className="rounded-lg px-3 py-1 text-sm"
              style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
            >一键导出笔记链接</button>
          )}
          {noteLinks.all.length > 0 && (
            <button
              data-testid="save-note-links"
              type="button"
              onClick={() => { void saveLinks() }}
              disabled={savingLinks}
              className="rounded-lg px-3 py-1 text-sm disabled:opacity-50"
              style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
            >{savingLinks ? '正在保存…' : '保存至本地'}</button>
          )}
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

          <div className="min-h-0 flex-1 overflow-auto">
            {showTable && tab === 'result'
              ? <>
                  {(noteLinks.video.length > 0 || noteLinks.imageText.length > 0) && (
                    <div data-testid="note-link-groups" className="mb-3 grid gap-2 sm:grid-cols-2">
                      {noteLinks.video.length > 0 && <LinkGroup title="视频笔记" links={noteLinks.video} testid="video-note-links" />}
                      {noteLinks.imageText.length > 0 && <LinkGroup title="图文笔记" links={noteLinks.imageText} testid="image-note-links" />}
                    </div>
                  )}
                  <ResultsTable
                    columns={columns}
                    rows={run.result ?? []}
                    onSendToVk={(url) => {
                      // 跨模块交接:规范化 URL + 脱敏 provenance(命令键/采集时刻),
                      // 严禁携带行数据,严禁另造第二种 manifest 格式。
                      useAppStore.getState().setVkHandoff({
                        url,
                        commandKey: run.command.command,
                        collectedAt: run.startedAt,
                      })
                    }}
                  />
                </>
              : <StreamLog lines={run.lines} />}
          </div>
        </>
      )}
    </div>
  )
}

function LinkGroup({ title, links, testid }: { title: string; links: string[]; testid: string }) {
  return (
    <section data-testid={testid} className="min-w-0 rounded-lg p-2" style={{ border: '1px solid var(--color-line)', background: 'var(--color-canvas)' }}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--color-fg)' }}>{title}（{links.length}）</span>
        <CopyButton label="复制链接" getText={() => `${links.join('\n')}\n`} testid={`${testid}-copy`} />
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-xs" style={{ color: 'var(--color-fg-dim)' }}>{links.join('\n')}</pre>
    </section>
  )
}

function stateLabel(s: string): string {
  return ({ starting: '正在启动…', running: '运行中…', cancelling: '正在取消…', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[s] ?? s
}

// 只在进行中的三态出球:终态(已完成/失败/已取消)的信息由文字与颜色承担,再放个动图是噪音。
// theme 必须显式钉 'dark' —— 本应用是 :root{color-scheme:dark} 的纯深色,没有 data-theme
// 也没有 dark class,组件默认的 'auto' 会退回去读系统主题,用户开浅色时会画成深色墨迹而隐形。
function orbState(s: string): OrbState {
  return ({ starting: 'connecting', running: 'working', cancelling: 'breathing' } as Record<string, OrbState>)[s] ?? 'working'
}
