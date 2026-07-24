import { useEffect, useMemo, useRef, useState } from 'react'
import AppShell from './components/AppShell'
import { SiteCommandNav } from './features/nav/SiteCommandNav'
import { CommandConfig } from './features/config/CommandConfig'
import { RunPanel } from './features/runs/RunPanel'
import { UndoToast } from './components/UndoToast'
import { useAppStore } from './store/appStore'
import { buildArgv } from './data/command'
import { createMockHost } from './host/mockHost'
import { snapshotCatalogSource, type CatalogSource } from './host'
import { validate } from './features/config/validation'
import type { HostBridge } from './host/types'

function normalizeHostError(e: unknown): { summary: string; detail?: string } {
  return {
    summary: e instanceof Error ? e.message : '任务启动失败',
    detail: e instanceof Error ? e.stack : String(e),
  }
}

export default function App({
  host: injectedHost,
  catalogSource: injectedSource,
  mode = 'demo',
}: { host?: HostBridge; catalogSource?: CatalogSource; mode?: 'demo' | 'connected' } = {}) {
  const host = useMemo(() => injectedHost ?? createMockHost(), [injectedHost])
  const catalogSource = useMemo(() => injectedSource ?? snapshotCatalogSource(), [injectedSource])
  const setCommands = useAppStore((s) => s.setCommands)
  const setCatalogStatus = useAppStore((s) => s.setCatalogStatus)
  const setMode = useAppStore((s) => s.setMode)
  const catalogStatus = useAppStore((s) => s.catalogStatus)
  const catalogError = useAppStore((s) => s.catalogError)
  const [refresh, setRefresh] = useState<{ state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }>({ state: 'idle' })
  const loadGen = useRef(0)   // 请求世代:latest-wins,过期响应(首载或刷新)一律丢弃(三轮复审 F1)

  const fetchCatalog = () => {
    const gen = ++loadGen.current
    catalogSource.load()
      .then(({ snapshot, degraded }) => {
        if (gen !== loadGen.current) return
        setCommands(snapshot.commands)
        // 世代接管即整块归位:被顶掉的在途手动刷新留下的 refreshing/error 残留一并清掉,按钮不卡死(评审 P3)
        setRefresh({ state: 'idle', generatedAt: snapshot.generatedAt, degraded })
        if (degraded) console.warn('[catalog]', degraded)
      })
      .catch((err) => {
        if (gen !== loadGen.current) return
        setRefresh((r) => (r.state === 'refreshing' ? { ...r, state: 'idle' } : r))   // 同上:失败也不许卡 refreshing
        setCatalogStatus('error', err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(() => {
    setMode(mode)
    const offOut = host.onOutput((e) => useAppStore.getState().appendOutput(e))
    const offDone = host.onDone((e) => useAppStore.getState().finishRun(e))
    fetchCatalog()
    return () => { offOut(); offDone() }
    // fetchCatalog 每次渲染重建，但只在 host 身份变化时需要重新接线/拉取一次，行为与原版 [host, setCommands] 等价
  }, [host, catalogSource, mode, setCommands, setCatalogStatus, setMode])

  useEffect(() => { useAppStore.getState().hydratePreferences() }, [])

  const onRefreshCatalog = () => {
    const gen = ++loadGen.current
    setRefresh((r) => ({ ...r, state: 'refreshing', error: undefined, degraded: undefined }))
    catalogSource.load()
      .then(({ snapshot, degraded }) => {
        if (gen !== loadGen.current) return
        useAppStore.getState().setCommands(snapshot.commands)
        setRefresh({ state: 'idle', generatedAt: snapshot.generatedAt, degraded })
      })
      .catch((err) => {
        if (gen !== loadGen.current) return
        setRefresh((r) => ({ ...r, state: 'error', error: err instanceof Error ? err.message : String(err) }))
      })
  }

  const executeSelected = (): boolean => {
    const s = useAppStore.getState()
    if (!s.selected) return false
    if (Object.keys(validate(s.selected, s.values)).length > 0) return false   // 权威再验(阻塞4)
    const runId = crypto.randomUUID()
    s.beginRun(runId)
    const argv = buildArgv(s.selected, s.values)
    void host.startCommand({ runId, commandKey: s.selected.command, argv })
      .catch((err) => useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
    return true
  }

  const onCancel = () => {
    const run = useAppStore.getState().currentRun
    if (!run) return
    useAppStore.getState().markCancelling()   // ⑥ 立即进入 cancelling，×不改状态
    void host.cancelCommand(run.id)
      .catch((err) => useAppStore.getState().finishRun({ runId: run.id, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
  }

  return (
    <div data-testid="app-root" className="h-full">
      <AppShell
        nav={<SiteCommandNav />}
        config={<CommandConfig onRun={executeSelected} />}
        runs={<RunPanel onCancel={onCancel} onRerun={executeSelected} />}
        catalogStatus={catalogStatus}
        catalogError={catalogError}
        onRetryCatalog={() => { setCatalogStatus('loading'); fetchCatalog() }}
        headerActions={<CatalogRefresh refresh={refresh} onRefresh={onRefreshCatalog} />}
      />
      <UndoToast />
    </div>
  )
}

function CatalogRefresh({ refresh, onRefresh }: {
  refresh: { state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }
  onRefresh: () => void
}) {
  const count = useAppStore((s) => s.commands.length)
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {refresh.generatedAt !== undefined && (
        <span data-testid="catalog-meta">
          {count} 条 · {new Date(refresh.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新
        </span>
      )}
      {refresh.state === 'error' && (
        <span data-testid="refresh-error" title={refresh.error} style={{ color: 'var(--color-danger)' }}>刷新失败</span>
      )}
      {refresh.degraded && (
        <span data-testid="refresh-degraded" title={refresh.degraded} style={{ color: 'var(--color-warning)' }}>已降级：本地快照</span>
      )}
      <button data-testid="refresh-catalog" disabled={refresh.state === 'refreshing'} onClick={onRefresh}
        className="rounded-lg px-2 py-1 disabled:opacity-50"
        style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
        {refresh.state === 'refreshing' ? '刷新中…' : '刷新目录'}
      </button>
    </div>
  )
}
