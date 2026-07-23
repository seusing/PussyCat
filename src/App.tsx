import { useEffect, useMemo } from 'react'
import AppShell from './components/AppShell'
import { SiteCommandNav } from './features/nav/SiteCommandNav'
import { CommandConfig } from './features/config/CommandConfig'
import { RunPanel } from './features/runs/RunPanel'
import { useAppStore } from './store/appStore'
import { loadCatalog } from './data/catalog'
import { createMockHost } from './host/mockHost'

let runSeq = 0

export default function App() {
  const host = useMemo(() => createMockHost(), [])
  const setCommands = useAppStore((s) => s.setCommands)

  useEffect(() => {
    const offOut = host.onOutput((e) => useAppStore.getState().appendOutput(e))
    const offDone = host.onDone((e) => useAppStore.getState().finishRun(e))
    loadCatalog().then((snap) => setCommands(snap.commands)).catch(() => {})
    return () => { offOut(); offDone() }
  }, [host, setCommands])

  const onRun = () => {
    const s = useAppStore.getState()
    if (!s.selected) return
    const runId = `run-${++runSeq}`
    s.beginRun(runId)
    void host.startCommand({ runId, site: s.selected.site, command: s.selected.name, args: s.values })
  }

  const onCancel = () => {
    const run = useAppStore.getState().currentRun
    if (!run) return
    useAppStore.getState().markCancelling()   // ⑥ 立即进入 cancelling，×不改状态
    void host.cancelCommand(run.id)
  }

  return (
    <div data-testid="app-root" className="h-full">
      <AppShell nav={<SiteCommandNav />} config={<CommandConfig onRun={onRun} />} runs={<RunPanel onCancel={onCancel} />} />
    </div>
  )
}
