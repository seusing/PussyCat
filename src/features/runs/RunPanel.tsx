import { useEffect, useMemo, useRef, useState } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import { Check, ChevronDown, Download, Send, Square, X } from 'lucide'
import { useAppStore } from '../../store/appStore'
import { StreamLog } from './StreamLog'
import { ResultsTable } from './ResultsTable'
import { copyPayloadFor } from '../../data/copyPayload'
import { CopyButton } from '../../components/CopyButton'
import { IconActionButton } from '../../components/IconActionButton'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { collectNoteLinks } from './noteLinks'
import './RunPanel.css'

export function RunPanel({ onCancel }: { onCancel: () => void }) {
  const run = useAppStore((s) => s.currentRun)
  const [tab, setTab] = useState<'result' | 'log'>('log')
  const collapsed = useAppStore((s) => s.runPanelCollapsed)
  const setCollapsed = useAppStore((s) => s.setRunPanelCollapsed)
  const [detailOpen, setDetailOpen] = useState(false)
  const [savingLinks, setSavingLinks] = useState(false)
  const [linksSaved, setLinksSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { setDetailOpen(false) }, [run?.id])
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  const listingCollections = run?.command.command === 'xiaohongshu/saved'
    && run.values['list-collections'] === true
  const noteLinks = useMemo(
    () => run?.state === 'succeeded' && !listingCollections
      ? collectNoteLinks(run.result ?? [])
      : { video: [], imageText: [], all: [] },
    [listingCollections, run?.result, run?.state],
  )
  if (!run) return <div className="p-3 text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无任务</div>

  const active = run.state === 'starting' || run.state === 'running' || run.state === 'cancelling'
  const columns = listingCollections
    ? ['rank', 'id', 'name', 'count', 'url']
    : run.command.columns ?? []
  const showTable = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) > 0
  // 命令成功但结果为空时日志里只有一个 `[]`,看起来像命令失效;补一句说明
  const emptyResult = run.state === 'succeeded' && columns.length > 0 && (run.result?.length ?? 0) === 0
  const terminal = run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled'
  const payload = terminal ? copyPayloadFor(run) : null
  const saveLinks = async () => {
    if (savingLinks || noteLinks.all.length === 0) return
    setSavingLinks(true)
    try {
      if (await saveTextFileAs('笔记链接.txt', `${noteLinks.all.join('\n')}\n`)) {
        setLinksSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setLinksSaved(false), 1500)
      }
    } finally {
      setSavingLinks(false)
    }
  }
  const cancelLabel = run.state === 'cancelling' ? '正在取消' : '取消执行'
  const saveLabel = savingLinks ? '正在保存' : linksSaved ? '已保存' : '保存至本地'

  return (
    <div className="run-panel flex h-full flex-col p-3">
      <div className="run-panel-header">
        <span data-testid="run-state" className="run-panel-status">
          {active && <ThinkingOrb state={orbState(run.state)} size={20} theme="dark" />}
          {terminal && <span className="run-panel-status-dot" data-tone={terminalTone(run.state)} aria-hidden="true" />}
          {stateLabel(run.state)}
        </span>
        <div className="run-panel-actions" role="toolbar" aria-label="任务操作">
          {active && (
            <IconActionButton
              data-testid="cancel-button"
              tone="danger"
              icon={Square}
              label={cancelLabel}
              onClick={onCancel}
              disabled={run.state === 'cancelling'}
            />
          )}
          {payload && <CopyButton label={payload.label} getText={() => payload.text} testid="copy-run" />}
          {noteLinks.all.length > 0 && (
            <IconActionButton
              data-testid="export-note-links"
              icon={Send}
              label="一键导出笔记链接"
              onClick={() => useAppStore.getState().setVkHandoff({
                url: noteLinks.all.join('\n'),
                commandKey: run.command.command,
                collectedAt: run.startedAt,
              })}
            />
          )}
          {noteLinks.all.length > 0 && (
            <IconActionButton
              data-testid="save-note-links"
              icon={linksSaved ? Check : Download}
              label={saveLabel}
              onClick={() => { void saveLinks() }}
              disabled={savingLinks}
            />
          )}
          <IconActionButton
            data-testid="collapse-panel"
            icon={collapsed ? ChevronDown : X}
            label={collapsed ? '展开面板' : '收起面板'}
            onClick={() => setCollapsed(!collapsed)}
          />
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

          {emptyResult && (
            <div data-testid="empty-result" className="mb-2 rounded-lg p-2 text-sm" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>
              执行成功，没有符合条件的结果
            </div>
          )}

          {showTable && (
            <div className="run-panel-tabs">
              <button type="button" className={tab === 'result' ? 'is-active' : undefined} aria-pressed={tab === 'result'} onClick={() => setTab('result')}>表格结果</button>
              <button type="button" className={tab === 'log' ? 'is-active' : undefined} aria-pressed={tab === 'log'} onClick={() => setTab('log')}>完整日志</button>
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
                    sendIconOnly
                    onSendToVk={listingCollections ? undefined : (url) => {
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
    <section data-testid={testid} className="min-w-0 rounded-lg p-2" style={{ border: '1px solid var(--color-hairline)', background: 'rgb(255 255 255 / 2%)' }}>
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

function terminalTone(s: string): string {
  return ({ succeeded: 'success', failed: 'danger', cancelled: 'dim' } as Record<string, string>)[s]
}

// 只在进行中的三态出球:终态(已完成/失败/已取消)的信息由文字与颜色承担,再放个动图是噪音。
// theme 必须显式钉 'dark' —— 本应用是 :root{color-scheme:dark} 的纯深色,没有 data-theme
// 也没有 dark class,组件默认的 'auto' 会退回去读系统主题,用户开浅色时会画成深色墨迹而隐形。
function orbState(s: string): OrbState {
  return ({ starting: 'connecting', running: 'working', cancelling: 'breathing' } as Record<string, OrbState>)[s] ?? 'working'
}
