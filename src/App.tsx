import { useEffect, useMemo } from 'react'
import AppShell from './components/AppShell'
import { SiteCommandNav } from './features/nav/SiteCommandNav'
import { CommandConfig } from './features/config/CommandConfig'
import { RunPanel } from './features/runs/RunPanel'
import { useAppStore } from './store/appStore'
import { loadCatalog } from './data/catalog'
import { buildArgv } from './data/command'
import { createMockHost } from './host/mockHost'
import type { HostBridge } from './host/types'

function normalizeHostError(e: unknown): { summary: string; detail?: string } {
  return {
    summary: e instanceof Error ? e.message : '任务启动失败',
    detail: e instanceof Error ? e.stack : String(e),
  }
}

export default function App({
  host: injectedHost,
  mode = 'demo',
}: { host?: HostBridge; mode?: 'demo' | 'connected' } = {}) {
  const host = useMemo(() => injectedHost ?? createMockHost(), [injectedHost])
  const setCommands = useAppStore((s) => s.setCommands)
  const setCatalogStatus = useAppStore((s) => s.setCatalogStatus)
  const setMode = useAppStore((s) => s.setMode)
  const catalogStatus = useAppStore((s) => s.catalogStatus)
  const catalogError = useAppStore((s) => s.catalogError)

  const fetchCatalog = () => {
    loadCatalog()
      .then((snap) => setCommands(snap.commands))
      .catch((err) => setCatalogStatus('error', err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => {
    setMode(mode)
    const offOut = host.onOutput((e) => useAppStore.getState().appendOutput(e))
    const offDone = host.onDone((e) => useAppStore.getState().finishRun(e))
    fetchCatalog()
    return () => { offOut(); offDone() }
    // fetchCatalog 每次渲染重建，但只在 host 身份变化时需要重新接线/拉取一次，行为与原版 [host, setCommands] 等价
  }, [host, mode, setCommands, setCatalogStatus, setMode])

  const onRun = () => {
    const s = useAppStore.getState()
    if (!s.selected) return
    const runId = crypto.randomUUID()
    s.beginRun(runId)
    const argv = buildArgv(s.selected, s.values)
    void host.startCommand({ runId, commandKey: s.selected.command, argv })
      .catch((err) => useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err) }))
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
        config={<CommandConfig onRun={onRun} />}
        runs={<RunPanel onCancel={onCancel} />}
        catalogStatus={catalogStatus}
        catalogError={catalogError}
        onRetryCatalog={() => { setCatalogStatus('loading'); fetchCatalog() }}
      />
    </div>
  )
}
