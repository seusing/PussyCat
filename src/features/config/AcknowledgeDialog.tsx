import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { commandDescription } from '../../data/zhCopy'
import type { CommandManifest } from '../../data/types'
import type { PolicyDecision } from '../../data/policy'

export type PendingAcknowledgement = { command: CommandManifest; decision: PolicyDecision }

// 中文说明映射表放在本文件(而非 policy.ts):policy.ts 只承载判决类型与只读的文案映射,
// 不承载"确认框具体怎么措辞"这类 UI 关注点。
//
// exposure 从整句改成「短语 + 色」:敏感度是个四档枚举,枚举天生该用颜色区分,
// 用一句话描述反而要求用户逐字读完才能分档。色值全部复用主题变量,不新增颜色。
const EXPOSURE_TEXT: Record<string, { label: string; color: string }> = {
  public: { label: '公开信息', color: 'var(--color-success)' },
  personal: { label: '涉及个人信息', color: 'var(--color-warning)' },
  secret: { label: '高度敏感信息', color: 'var(--color-danger)' },
  unknown: { label: '敏感度尚未判定', color: 'var(--color-fg-dim)' },
}

// authority 同样收短。原文是"能力的完整定义",这里只要"用户看一眼知道被碰了什么"——
// 完整定义在下方折叠的说明里,以及命令详情页,不靠这一行承担。
const AUTHORITY_TEXT: Record<string, { label: string; icon: AuthorityIconName }> = {
  'public-network': { label: '访问公共网络', icon: 'globe' },
  'explicit-local-input': { label: '只用你填的内容', icon: 'input' },
  'ambient-local-files': { label: '读本机应用文件', icon: 'folder' },
  'live-local-app': { label: '与本机程序交互', icon: 'window' },
  'browser-profile': { label: '用浏览器登录态', icon: 'browser' },
}

type AuthorityIconName = 'globe' | 'input' | 'folder' | 'window' | 'browser'

// 纯内联 SVG,与 AppShell 的 PanelIcon 同一路数,不引入图标库依赖。
// 16×16 视框、stroke=currentColor,颜色与字号跟随父级。
function AuthorityIcon({ name }: { name: AuthorityIconName }) {
  const paths: Record<AuthorityIconName, JSX.Element> = {
    globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /></>,
    input: <><path d="M3 13.5h10" /><path d="M4.5 10.8 10.8 4.5l1.7 1.7L6.2 12.5l-2.2.5z" /></>,
    folder: <path d="M2 12.5v-9h4l1.4 1.8H14v7.2z" />,
    window: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6.2h12" /></>,
    browser: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6.2h12" /><path d="M4.2 4.6h.01" /></>,
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {paths[name]}
    </svg>
  )
}

function authorityEntry(a: string): { label: string; icon: AuthorityIconName } {
  return AUTHORITY_TEXT[a] ?? { label: a, icon: 'window' }
}

/**
 * acknowledgement 确认框(Task 8)。**不是安全授权**(I-P5)——真正的执行边界是 Host
 * 对 denied/unknown 的拒绝;这里只防止用户误点、或基于已过期的界面信息误执行。
 * 文案因此写"这次将允许什么",不写"点确定继续"。
 *
 * 版式分三层:① 敏感度徽章(颜色即分档)② 权限逐条列(图标 + 短语)
 * ③ 完整免责说明折进 <details>。第三层的原文一字未改——它是合规说明,
 * 收起来是为了不挡住前两层,不是为了删。
 */
export function AcknowledgeDialog({ pending, onConfirmed, onCancel }: {
  pending: PendingAcknowledgement | undefined
  onConfirmed: () => void
  onCancel: () => void
}) {
  const acknowledgeCommand = useAppStore((s) => s.acknowledgeCommand)
  const [sessionOnly, setSessionOnly] = useState(false)

  if (!pending) return null
  const { command, decision } = pending
  const metadata = decision.metadata
  const authorities = metadata?.authorities ?? []
  const exposure = EXPOSURE_TEXT[metadata?.exposure ?? ''] ?? EXPOSURE_TEXT.unknown

  const handleCancel = () => {
    setSessionOnly(false)
    onCancel()
  }

  const handleConfirm = () => {
    if (!decision.fingerprint) return   // 无 fingerprint 的判决理论上到不了这里(仅 acknowledgement-required 才有);防御性早退
    const persisted = acknowledgeCommand(command.command, decision.fingerprint, Date.now())
    if (!persisted && !sessionOnly) {
      // 先把"仅本次会话有效"的提示亮出来,用户看到后再点一次才真正放行——
      // 否则对话框立刻消失,这条提示永远没人看得到。
      setSessionOnly(true)
      return
    }
    setSessionOnly(false)
    onConfirmed()
  }

  return (
    <div className="app-glass-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center">
      <div data-testid="acknowledge-dialog" className="app-glass-dialog w-full max-w-md rounded-lg p-4 text-sm">
        <h3 className="mb-2 text-base font-semibold">确认执行「{command.name}」</h3>
        {/* 走 zhCopy 覆盖表,和命令详情页同一个来源。此前这里直接读 manifest 的
            description,于是同一条命令在左边配置区是中文、在确认框里是英文 —— 而确认框
            恰恰是最需要看懂的地方。表里没有的仍如实回落英文原文(不机翻)。 */}
        {commandDescription(command.command, command.description) && (
          <p className="mb-3" style={{ color: 'var(--color-fg-dim)' }}>
            {commandDescription(command.command, command.description)}
          </p>
        )}

        <div data-testid="ack-exposure" className="mb-3 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs"
          style={{ background: 'var(--color-canvas)', color: exposure.color }}>
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: 'currentColor' }} />
          {exposure.label}
        </div>

        <div data-testid="ack-authorities" className="mb-3 flex flex-col gap-2">
          {authorities.length > 0
            ? authorities.map((a) => {
              const entry = authorityEntry(a)
              return (
                <div key={a} className="flex items-center gap-2">
                  <span style={{ color: 'var(--color-fg-dim)' }}><AuthorityIcon name={entry.icon} /></span>
                  <span>{entry.label}</span>
                </div>
              )
            })
            : <span style={{ color: 'var(--color-fg-dim)' }}>不需要额外权限</span>}
        </div>

        <details className="mb-3">
          <summary className="cursor-pointer text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            只允许执行一次，可随时撤销
          </summary>
          <p className="mt-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            确认后，本命令将被允许按以上范围执行一次；可随时在命令详情里撤销。
            这不是一次安全授权——是否允许执行由服务端策略决定，这里只是避免误点或界面信息过期导致误执行。
          </p>
        </details>

        {sessionOnly && (
          <p data-testid="ack-session-only" className="mb-3 text-xs" style={{ color: 'var(--color-warning)' }}>
            本地偏好暂时无法保存，这次确认仅本次会话有效，重启应用后需要重新确认。
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button data-testid="ack-cancel" onClick={handleCancel} className="rounded-lg px-3 py-1"
            style={{ color: 'var(--color-fg-dim)' }}>
            取消
          </button>
          <button data-testid="ack-confirm" onClick={handleConfirm} className="rounded-lg px-4 py-2 font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
            {sessionOnly ? '知道了，继续运行' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  )
}
