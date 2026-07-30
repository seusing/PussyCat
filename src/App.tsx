import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppShell from './components/AppShell'
import { SiteCommandNav } from './features/nav/SiteCommandNav'
import { CommandConfig } from './features/config/CommandConfig'
import { RunPanel } from './features/runs/RunPanel'
import { UndoToast } from './components/UndoToast'
import { AcknowledgeDialog } from './features/config/AcknowledgeDialog'
import { useAppStore, isTerminal } from './store/appStore'
import { buildArgv } from './data/command'
import { createMockHost } from './host/mockHost'
import { snapshotCatalogSource, type CatalogSource } from './host'
import { validate } from './features/config/validation'
import type { CommandManifest } from './data/types'
import type { HostBridge } from './host/types'
import { HostRequestError } from './host/errors'
import { isRunnable } from './data/policy'
import { isAcknowledged } from './data/preferences'

export function normalizeHostError(e: unknown, context: 'start' | 'cancel'): { summary: string; detail?: string } {
  const fallback = context === 'cancel' ? '取消请求失败' : '任务启动失败'
  if (e instanceof HostRequestError) return { summary: e.summary || fallback, detail: e.detail }   // 结构化透传(复审 F2)
  if (e && typeof e === 'object' && !(e instanceof Error)) {
    const o = e as { summary?: unknown; detail?: unknown }
    if (typeof o.summary === 'string') {
      return { summary: o.summary, detail: typeof o.detail === 'string' ? o.detail : undefined }
    }
  }
  if (e instanceof Error) return { summary: e.message || fallback, detail: e.stack }
  return { summary: fallback, detail: String(e) }
}

export default function App({
  host: injectedHost,
  catalogSource: injectedSource,
  mode = 'demo',
  baseUrl,
}: { host?: HostBridge; catalogSource?: CatalogSource; mode?: 'demo' | 'connected'; baseUrl?: string } = {}) {
  const host = useMemo(() => injectedHost ?? createMockHost(), [injectedHost])
  const catalogSource = useMemo(() => injectedSource ?? snapshotCatalogSource(), [injectedSource])
  const setCommands = useAppStore((s) => s.setCommands)
  const setCatalogStatus = useAppStore((s) => s.setCatalogStatus)
  const setMode = useAppStore((s) => s.setMode)
  const catalogStatus = useAppStore((s) => s.catalogStatus)
  const catalogError = useAppStore((s) => s.catalogError)
  const [refresh, setRefresh] = useState<{ state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }>({ state: 'idle' })
  const loadGen = useRef(0)   // 请求世代:latest-wins,过期响应(首载或刷新)一律丢弃(三轮复审 F1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const submitFormRef = useRef<(() => void) | null>(null)
  const registerSubmit = useCallback((fn: (() => void) | null) => { submitFormRef.current = fn }, [])

  const fetchCatalog = () => {
    const gen = ++loadGen.current
    catalogSource.load()
      .then(({ snapshot, degraded, decisions }) => {
        if (gen !== loadGen.current) return
        setCommands(snapshot.commands, decisions)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) return   // AltGr(=Ctrl+Alt)是欧洲键盘真实字符输入,任何热键不得劫持(终审 M-1)
      // IME 组合输入中三键全部让路。三重保险:isComposing(标准) / key==='Process'(标准,替代已废弃的 keyCode)
      // / keyCode===229(VK_PROCESSKEY 历史约定,部分旧 WebKit/IME 只置它)。桌面无可打印键映射到 229;
      // 已知唯一误伤面是 Chrome on Android 软键盘对所有 keydown 报 229 —— 本项目是桌面 WebView,出射程(评审 M-1)
      if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return   // IME 组合输入中:三键全部让路(229 是 IME 合成键的历史约定,配 isComposing 双保险;复审 F1+P3)
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {   // 排除 Ctrl+Shift+K(浏览器 DevTools);'K' 保留给 CapsLock
        event.preventDefault()                                   // 压掉浏览器默认(地址栏搜索)
        searchInputRef.current?.focus()
        return
      }
      if (mod && !event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        submitFormRef.current?.()                                // 完整提交流程:字段错误显示+聚焦首错(P1-2)
        return
      }
      if (event.key === 'Escape') {
        const el = document.activeElement as HTMLElement | null
        const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        if (editable) { el.blur(); return }                      // ② 取消聚焦
        const s = useAppStore.getState()
        if (s.currentRun && !s.runPanelCollapsed) s.setRunPanelCollapsed(true)   // ③ 只收起(P1-1)
        // ④ 已收起/无 run:no-op —— 永不 toggle、永不展开
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onRefreshCatalog = () => {
    const gen = ++loadGen.current
    setRefresh((r) => ({ ...r, state: 'refreshing', error: undefined, degraded: undefined }))
    catalogSource.load()
      .then(({ snapshot, degraded, decisions }) => {
        if (gen !== loadGen.current) return
        useAppStore.getState().setCommands(snapshot.commands, decisions)
        setRefresh({ state: 'idle', generatedAt: snapshot.generatedAt, degraded })
      })
      .catch((err) => {
        if (gen !== loadGen.current) return
        setRefresh((r) => ({ ...r, state: 'error', error: err instanceof Error ? err.message : String(err) }))
      })
  }

  // 409(fingerprint-stale)/428(acknowledgement-required) 是"需要重新确认",不是普通失败——
  // 不把服务端原始错误甩给用户(Task 8 铁律),而是重拉目录、作废本地陈旧确认、重新弹确认框。
  const handleStartError = (err: unknown, runId: string, cmd: CommandManifest) => {
    if (err instanceof HostRequestError && err.reasonCode === 'fingerprint-stale') {
      useAppStore.getState().finishRun({
        runId, at: Date.now(), outcome: 'error',
        error: { summary: '策略已更新，请重新确认后再试', detail: err.detail },
      })
      useAppStore.getState().revokeAcknowledgementCommand(cmd.command)   // 作废本地该条陈旧确认
      catalogSource.load().then(({ snapshot, decisions }) => {
        if (useAppStore.getState().selected?.command !== cmd.command) return   // 用户已切走,不弹陈旧对话框
        useAppStore.getState().setCommands(snapshot.commands, decisions)
        const fresh = decisions?.find((d) => d.commandKey === cmd.command)
        if (fresh) useAppStore.getState().requestAcknowledgement(cmd, fresh)   // 用刷新后的 fingerprint 重新弹框
      })
      return
    }
    if (err instanceof HostRequestError && err.reasonCode === 'acknowledgement-required') {
      useAppStore.getState().finishRun({
        runId, at: Date.now(), outcome: 'error',
        error: { summary: '此命令需要先确认', detail: err.detail },
      })
      const decision = useAppStore.getState().decisionFor(cmd.command)
      if (decision) useAppStore.getState().requestAcknowledgement(cmd, decision)
      return
    }
    useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'error', error: normalizeHostError(err, 'start') })
  }

  const executeSelected = (): boolean => {
    const s = useAppStore.getState()
    if (s.catalogStatus !== 'ready') return false
    if (s.currentRun && !isTerminal(s.currentRun.state)) return false   // 键盘路径绕过按钮 disabled,权威兜底
    if (!s.selected) return false
    const decision = s.decisionFor(s.selected.command)
    if (!isRunnable(decision)) return false   // Host 判决闸(I-P1):置灰只是体验,这里才是权威;覆盖键盘路径
    if (Object.keys(validate(s.selected, s.values)).length > 0) return false   // 权威再验(阻塞4)

    const cmd = s.selected
    let acknowledgement: { fingerprint: string } | undefined
    if (decision!.state === 'acknowledgement-required') {
      const fp = decision!.fingerprint
      if (!fp || !isAcknowledged(s.preferences, cmd.command, fp)) {
        s.requestAcknowledgement(cmd, decision!)   // 未确认或指纹陈旧:不发请求,弹确认框(Task 8 Step 5)
        return false
      }
      acknowledgement = { fingerprint: fp }
    }

    const runId = crypto.randomUUID()
    s.beginRun(runId)
    const argv = buildArgv(cmd, s.values)
    // acknowledgement 已进 RunRequest(types.ts)的类型声明:内联字面量因此受**多余属性检查**管辖,
    // 字段名写错会当场 tsc 报错。此前靠"拆成局部变量绕过检查"的写法能跑,但拼错一个字母就变成
    // 字段静默不发、用户表现为「确认了却一直 428」——那种失败编译器本来能替我们抓住。
    void host.startCommand({ runId, commandKey: cmd.command, argv, acknowledgement })
      .catch((err) => handleStartError(err, runId, cmd))
    return true
  }

  const onCancel = () => {
    const run = useAppStore.getState().currentRun
    if (!run) return
    useAppStore.getState().markCancelling()   // ⑥ 立即进入 cancelling，×不改状态
    void host.cancelCommand(run.id)
      .catch((err) => useAppStore.getState().finishRun({ runId: run.id, at: Date.now(), outcome: 'error', error: normalizeHostError(err, 'cancel') }))
  }

  const pendingAcknowledgement = useAppStore((s) => s.pendingAcknowledgement)

  return (
    <div data-testid="app-root" className="h-full">
      <AppShell
        nav={<SiteCommandNav searchRef={searchInputRef} />}
        config={<CommandConfig onRun={executeSelected} registerSubmit={registerSubmit} />}
        runs={<RunPanel onCancel={onCancel} onRerun={executeSelected} />}
        catalogStatus={catalogStatus}
        catalogError={catalogError}
        onRetryCatalog={() => { setCatalogStatus('loading'); fetchCatalog() }}
        headerActions={<CatalogRefresh refresh={refresh} onRefresh={onRefreshCatalog} />}
        baseUrl={baseUrl}
      />
      <UndoToast />
      <AcknowledgeDialog
        pending={pendingAcknowledgement}
        onCancel={() => useAppStore.getState().dismissAcknowledgement()}
        onConfirmed={() => { useAppStore.getState().dismissAcknowledgement(); executeSelected() }}
      />
    </div>
  )
}

function CatalogRefresh({ refresh, onRefresh }: {
  refresh: { state: 'idle' | 'refreshing' | 'error'; error?: string; degraded?: string; generatedAt?: number }
  onRefresh: () => void
}) {
  const count = useAppStore((s) => s.commands.length)
  const decisionsCount = useAppStore((s) => s.decisions.size)
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {decisionsCount === 0 && (
        <span data-testid="policy-disconnected" style={{ color: 'var(--color-warning)' }}>
          Host 未连接：命令均不可执行
        </span>
      )}
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
