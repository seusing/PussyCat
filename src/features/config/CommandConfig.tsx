import { useEffect, useRef, useState } from 'react'
import { Lock, Send, Loader2, Copy, Check } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { buildTokens, commandPreview, quote } from '../../data/command'
import { isSiteFavorited, isCommandFavorited } from '../../data/preferences'
import { validate } from './validation'
import { DynamicField } from './DynamicField'
import { explainDecision, isRunnable } from '../../data/policy'
import { commandDescription, commandTitle } from '../../data/zhCopy'
import { MicroButton } from '../../components/MicroButton'
import { copyText } from '../../lib/clipboard'

export function CommandConfig({ onRun, registerSubmit, compactHeader = false }: {
  onRun: () => void
  registerSubmit?: (fn: (() => void) | null) => void
  compactHeader?: boolean
}) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const decision = useAppStore((s) => (s.selected ? s.decisionFor(s.selected.command) : undefined))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const preferences = useAppStore((s) => s.preferences)
  const toggleSiteFavorite = useAppStore((s) => s.toggleSiteFavorite)
  const toggleCommandFavorite = useAppStore((s) => s.toggleCommandFavorite)
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const handleRunRef = useRef<(() => void) | null>(null)

  useEffect(() => () => clearTimeout(copyTimer.current), [])

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

  const handleCopy = async () => {
    const ok = await copyText(commandPreview(selected, values))
    setCopyState(ok ? 'ok' : 'err')
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1500)
  }

  const copyTitle = copyState === 'ok' ? '已复制' : copyState === 'err' ? '复制失败' : '复制命令'

  return (
    <div>
      {!compactHeader && <div data-testid="command-header" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inspiration-command-title shrink-0">
          <h2 className="text-lg font-semibold">{commandTitle(selected.command) ?? selected.name}</h2>
          {commandTitle(selected.command) && <small>{selected.name}</small>}
        </div>
        <MicroButton
          variant="save"
          data-testid="fav-site"
          onClick={() => toggleSiteFavorite(selected.site)}
          active={isSiteFavorited(preferences, selected.site)}
          aria-pressed={isSiteFavorited(preferences, selected.site)}
          title={isSiteFavorited(preferences, selected.site) ? '取消收藏站点' : '收藏站点'}
        >
          {isSiteFavorited(preferences, selected.site) ? '已保存' : '稍后查看'}
        </MicroButton>
        <MicroButton
          variant="favorite"
          data-testid="fav-command"
          onClick={() => toggleCommandFavorite(selected)}
          active={isCommandFavorited(preferences, selected.command)}
          aria-pressed={isCommandFavorited(preferences, selected.command)}
          title={isCommandFavorited(preferences, selected.command) ? '取消收藏命令' : '收藏命令'}
        >
          {isCommandFavorited(preferences, selected.command) ? '已收藏' : '收藏'}
        </MicroButton>
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
        <button
          data-testid="copy-command"
          className="cmd-form-preview-copy"
          onClick={handleCopy}
          aria-label={copyTitle}
          title={copyTitle}
        >
          {copyState === 'ok'
            ? <Check size={14} aria-hidden="true" />
            : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>

      {/* 操作栏 */}
      <div className="cmd-form-actions">
        <span className="cmd-form-shortcut">
          <kbd className="cmd-kbd">Ctrl</kbd>
          <kbd className="cmd-kbd">Enter</kbd>
          提交
        </span>
        <button data-testid="run-button" className="cmd-run-btn" disabled={running || !runnable} onClick={handleRun}>
          {running
            ? <><Loader2 size={15} className="animate-spin" aria-hidden="true" />运行中…</>
            : <><Send size={14} aria-hidden="true" />运行任务</>}
        </button>
      </div>
      {!runnable && (
        <p data-testid="decision-reason" className="cmd-decision-reason">
          <Lock size={13} aria-hidden="true" />
          {explainDecision(decision)}
        </p>
      )}
    </div>
  )
}
