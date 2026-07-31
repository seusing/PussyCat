import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import { isSiteFavorited, isCommandFavorited, isAcknowledged } from '../../data/preferences'
import { validate } from './validation'
import { DynamicField } from './DynamicField'
import { CopyButton } from '../../components/CopyButton'
import { explainDecision, isRunnable } from '../../data/policy'
import { commandDescription } from '../../data/zhCopy'

// 「已确认」状态条的措辞:必须说清**撤销的是什么**。
// 原先只有一个孤零零的「撤销确认」链接——用户看不出撤销掉的是哪一项授予,只知道有个东西能撤。
// 这里把授予内容摊开来讲,撤销按钮跟在它后面,语义自洽。
const AUTHORITY_GRANT: Record<string, string> = {
  'browser-profile': '使用浏览器里的登录状态',
  'public-network': '访问对应网站',
  'ambient-local-files': '读取本机相关文件',
  'explicit-local-input': '读取你在表单里填写的内容',
  'live-local-app': '连接本机正在运行的程序',
}

export function CommandConfig({ onRun, registerSubmit }: { onRun: () => void; registerSubmit?: (fn: (() => void) | null) => void }) {
  const selected = useAppStore((s) => s.selected)
  const values = useAppStore((s) => s.values)
  const setValue = useAppStore((s) => s.setValue)
  const currentRun = useAppStore((s) => s.currentRun)
  const decision = useAppStore((s) => (s.selected ? s.decisionFor(s.selected.command) : undefined))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const preferences = useAppStore((s) => s.preferences)
  const toggleSiteFavorite = useAppStore((s) => s.toggleSiteFavorite)
  const toggleCommandFavorite = useAppStore((s) => s.toggleCommandFavorite)
  const revokeAcknowledgementCommand = useAppStore((s) => s.revokeAcknowledgementCommand)
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
  const runnable = isRunnable(decision)
  // 已确认的 acknowledgement-required 命令旁给一个撤销入口(Task 8 Step 4)。
  // 撤销后 isAcknowledged 变 false,下次运行会重新弹确认框——不影响 Host 判决本身(I-P5)。
  const acknowledged = decision?.state === 'acknowledgement-required' && !!decision.fingerprint
    && isAcknowledged(preferences, selected.command, decision.fingerprint)
  // 授予内容取自 Host 下发的判决 metadata,**不在前端另编一套说法**:
  // 确认框里写的是什么,这里就复述什么,否则两处措辞会各自漂移。
  const grants = (decision?.metadata?.authorities ?? [])
    .map((a) => AUTHORITY_GRANT[a])
    .filter((label): label is string => !!label)

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
      {/* 试点八条用中文精简说明,其余回落 manifest 原文(见 data/zhCopy.ts:不做机翻) */}
      <p className="mb-4" style={{ color: 'var(--color-fg-dim)' }}>{commandDescription(selected.command, selected.description)}</p>

      <div className="mb-4">
        {selected.args.map((arg) => (
          <DynamicField key={arg.name} arg={arg} commandKey={selected.command} value={values[arg.name]} error={errors[arg.name]}
            onChange={(v) => { setValue(arg.name, v); setErrors((e) => { const { [arg.name]: _drop, ...rest } = e; return rest }) }} />
        ))}
        {selected.args.length === 0 && <div className="text-sm" style={{ color: 'var(--color-fg-dim)' }}>此命令无参数</div>}
      </div>

      <div className="mb-4">
        <pre className="mb-1 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)', color: 'var(--color-fg-dim)' }}>{commandPreview(selected, values)}</pre>
        <CopyButton label="复制命令" getText={() => commandPreview(selected, values)} testid="copy-command" />
      </div>

      <button data-testid="run-button" disabled={running || !runnable} onClick={handleRun}
        className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
        {running ? '运行中…' : '运行任务'}
      </button>
      {!runnable && (
        <p data-testid="decision-reason" className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          {explainDecision(decision)}
        </p>
      )}
      {acknowledged && (
        <div data-testid="acknowledged-banner"
          className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2 text-xs"
          style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <span aria-hidden style={{ color: 'var(--color-success)' }}>✓</span>
          <span style={{ color: 'var(--color-fg-dim)' }}>
            已允许本命令
            {grants.length > 0 ? `：${grants.join('、')}` : '按已确认的范围执行'}
          </span>
          <button data-testid="revoke-acknowledge" onClick={() => revokeAcknowledgementCommand(selected.command)}
            className="ml-auto shrink-0 rounded px-2 py-1"
            title="撤销后再次运行会重新弹出确认框"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}>
            撤销
          </button>
        </div>
      )}
    </div>
  )
}
