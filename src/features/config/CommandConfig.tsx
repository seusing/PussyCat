import { useEffect, useRef, useState } from 'react'
import { Lock, Send, Loader2 } from 'lucide-react'
import { MANUAL_RUN_CONCURRENCY, activeRunCount, useAppStore } from '../../store/appStore'
import { buildTokens, commandPreview, quote } from '../../data/command'
import { validate } from './validation'
import { DynamicField } from './DynamicField'
import { explainDecision, isRunnable } from '../../data/policy'
import { commandDescription, commandTitle } from '../../data/zhCopy'
import { CopyButton } from '../../components/CopyButton'

export function CommandConfig({ onRun, registerSubmit, compactHeader = false }: {
  onRun: () => void
  registerSubmit?: (fn: (() => void) | null) => void
  compactHeader?: boolean
}) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const runLimitReached = useAppStore((s) => activeRunCount(s) >= MANUAL_RUN_CONCURRENCY)
  const decision = useAppStore((s) => (s.selected ? s.decisionFor(s.selected.command) : undefined))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const handleRunRef = useRef<(() => void) | null>(null)

  useEffect(() => { setErrors({}) }, [selected])   // ⑦a 切换命令后清掉上一条命令残留的字段错误

  useEffect(() => {
    if (!registerSubmit) return
    registerSubmit(() => handleRunRef.current?.())
    return () => registerSubmit(null)
  }, [registerSubmit])

  const handleRun = () => {
    // 单快照读实时 store:selected 与 values 由 selectCommand 原子写入,必须同源取——
    // 混用「实时 cmd + 渲染期 values」会在未提交窗口里让新命令配上旧命令的值(评审 I-1)
    const s = useAppStore.getState()
    const cmd = s.selected
    if (!cmd) return          // 无 selected 时安全 no-op(替代原早退里的 handleRunRef.current = null,P1 硬性要求③)
    const live = s.currentRun
    // 读实时 store 而非渲染期闭包快照:与 executeSelected 的权威守卫同源,消除 commit 前的陈旧窗口(M-2)
    if (live && (live.state === 'starting' || live.state === 'running' || live.state === 'cancelling')) return
    if (activeRunCount(s) >= MANUAL_RUN_CONCURRENCY) return
    const errs = validate(cmd, s.values)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      const first = cmd.args.find((a) => errs[a.name])
      if (first) document.querySelector<HTMLElement>(`[data-testid="field-${first.name}"]`)?.focus()
      return
    }
    onRun()
  }

  useEffect(() => { handleRunRef.current = selected ? handleRun : null })   // commit 后赋值,消除渲染期 ref 副作用(M-2);无依赖数组=每次 commit 后同步最新闭包

  if (!selected) { return <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>从左侧选择一个服务和命令</div> }

  const running = currentRun?.state === 'starting' || currentRun?.state === 'running' || currentRun?.state === 'cancelling'
  const runnable = isRunnable(decision)

  const tokens = buildTokens(selected, values)

  return (
    <div>
      {!compactHeader && <div data-testid="command-header" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inspiration-command-title shrink-0">
          <h2 className="text-lg font-semibold">{commandTitle(selected.command) ?? selected.name}</h2>
          {commandTitle(selected.command) && <small>{selected.name}</small>}
        </div>
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
        {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
        {/* 说明和标题控件共用一行空间，窄窗口时自然换行，避免再占一整段底部高度。 */}
        <span data-testid="command-description" className="min-w-0 text-sm" style={{ flex: '1 1 16rem', color: 'var(--color-fg-dim)', overflowWrap: 'anywhere' }}>
          {commandDescription(selected.command, selected.description)}
        </span>
      </div>}

      {selected.args.length === 0 ? (
        <p className="cmd-form-empty">此命令无参数</p>
      ) : (
        <div className="cmd-form-grid">
          {selected.args.map((arg) => (
            <DynamicField key={arg.name} arg={arg} commandKey={selected.command} value={values[arg.name]} error={errors[arg.name]}
              onChange={(v) => { setValue(arg.name, v); setErrors((e) => { const { [arg.name]: _drop, ...rest } = e; return rest }) }} />
          ))}
        </div>
      )}

      {/* 终端预览块 */}
      <div className="cmd-form-preview">
        <pre data-testid="command-preview">
          <span className="cmd-preview-sub">opencli</span>
          {tokens.map((tok, i) => (
            <span
              key={i}
              className={tok.kind === 'flag' ? 'cmd-preview-flag' : tok.kind === 'sub' ? 'cmd-preview-sub' : 'cmd-preview-value'}
            >
              {' '}{tok.kind === 'flag' ? tok.text : quote(tok.text)}
            </span>
          ))}
        </pre>
        <CopyButton label="复制命令" getText={() => commandPreview(selected, values)} testid="copy-command" className="cmd-form-preview-copy" />
      </div>

      {/* 操作栏 */}
      <div className="cmd-form-actions">
        <span className="cmd-form-shortcut">
          <kbd className="cmd-kbd">Ctrl</kbd>
          <kbd className="cmd-kbd">Enter</kbd>
          提交
        </span>
        <button data-testid="run-button" className="cmd-run-btn" disabled={running || !runnable || runLimitReached} onClick={handleRun}>
          {running
            ? <><Loader2 size={15} strokeWidth={1.5} className="animate-spin" aria-hidden="true" />运行中…</>
            : <><Send size={14} strokeWidth={1.5} aria-hidden="true" />运行任务</>}
        </button>
      </div>
      {!running && runLimitReached && (
        <p data-testid="run-limit-reason" className="cmd-decision-reason">
          已有 {MANUAL_RUN_CONCURRENCY} 条命令在运行，等其中一条结束后再试
        </p>
      )}
      {!runnable && (
        <p data-testid="decision-reason" className="cmd-decision-reason">
          <Lock size={13} strokeWidth={1.5} aria-hidden="true" />
          {explainDecision(decision)}
        </p>
      )}
    </div>
  )
}
