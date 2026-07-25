import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import { isSiteFavorited, isCommandFavorited } from '../../data/preferences'
import { validate } from './validation'
import { DynamicField } from './DynamicField'
import { CopyButton } from '../../components/CopyButton'

export function CommandConfig({ onRun, registerSubmit }: { onRun: () => void; registerSubmit?: (fn: (() => void) | null) => void }) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const preferences = useAppStore((s) => s.preferences)
  const toggleSiteFavorite = useAppStore((s) => s.toggleSiteFavorite)
  const toggleCommandFavorite = useAppStore((s) => s.toggleCommandFavorite)
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

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        <span>{selected.site}</span>
        <button
          data-testid="fav-site"
          onClick={() => toggleSiteFavorite(selected.site)}
          aria-pressed={isSiteFavorited(preferences, selected.site)}
          title={isSiteFavorited(preferences, selected.site) ? '取消收藏站点' : '收藏站点'}
          style={{ color: isSiteFavorited(preferences, selected.site) ? 'var(--color-warning)' : 'var(--color-fg-dim)', lineHeight: 1 }}
        >
          {isSiteFavorited(preferences, selected.site) ? '★' : '☆'}
        </button>
        <span>/ {selected.name}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{selected.name}</h2>
        <button
          data-testid="fav-command"
          onClick={() => toggleCommandFavorite(selected)}
          aria-pressed={isCommandFavorited(preferences, selected.command)}
          title={isCommandFavorited(preferences, selected.command) ? '取消收藏命令' : '收藏命令'}
          style={{ color: isCommandFavorited(preferences, selected.command) ? 'var(--color-warning)' : 'var(--color-fg-dim)', lineHeight: 1 }}
        >
          {isCommandFavorited(preferences, selected.command) ? '★' : '☆'}
        </button>
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
        {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
      </div>
      <p className="mb-4 text-sm" style={{ color: 'var(--color-fg-dim)' }}>{selected.description}</p>

      <div className="mb-4">
        {selected.args.map((arg) => (
          <DynamicField key={arg.name} arg={arg} value={values[arg.name]} error={errors[arg.name]}
            onChange={(v) => { setValue(arg.name, v); setErrors((e) => { const { [arg.name]: _drop, ...rest } = e; return rest }) }} />
        ))}
        {selected.args.length === 0 && <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>此命令无参数</div>}
      </div>

      <div className="mb-4">
        <pre className="mb-1 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{commandPreview(selected, values)}</pre>
        <CopyButton label="复制命令" getText={() => commandPreview(selected, values)} testid="copy-command" />
      </div>

      <button data-testid="run-button" disabled={running} onClick={handleRun}
        className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
        {running ? '运行中…' : '运行任务'}
      </button>
    </div>
  )
}
