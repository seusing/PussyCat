import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import type { PolicyDecision } from '../../data/policy'

export type PendingAcknowledgement = { command: CommandManifest; decision: PolicyDecision }

// 中文说明映射表放在本文件(而非 policy.ts):policy.ts 只承载判决类型与只读的文案映射,
// 不承载"确认框具体怎么措辞"这类 UI 关注点。
const EXPOSURE_TEXT: Record<string, string> = {
  public: '公开信息，不涉及隐私',
  personal: '与你相关的个人信息',
  secret: '高度敏感信息',
  unknown: '敏感度尚未判定',
}

const AUTHORITY_TEXT: Record<string, string> = {
  'public-network': '访问公共网络',
  'explicit-local-input': '使用你在本次调用中显式提供的内容',
  'ambient-local-files': '扫描本机相关应用留下的本地文件',
  'live-local-app': '与本机正在运行的应用交互',
  'browser-profile': '使用浏览器登录态或 Cookie',
}

function authorityLabel(a: string): string {
  return AUTHORITY_TEXT[a] ?? a
}

/**
 * acknowledgement 确认框(Task 8)。**不是安全授权**(I-P5)——真正的执行边界是 Host
 * 对 denied/unknown 的拒绝;这里只防止用户误点、或基于已过期的界面信息误执行。
 * 文案因此写"这次将允许什么",不写"点确定继续"。
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div data-testid="acknowledge-dialog" className="w-full max-w-md rounded-lg p-4 text-sm shadow-lg"
        style={{ background: 'var(--color-panel)', color: 'var(--color-fg)', border: '1px solid var(--color-line)' }}>
        <h3 className="mb-2 text-base font-semibold">确认执行「{command.name}」</h3>
        {command.description && (
          <p className="mb-2" style={{ color: 'var(--color-fg-dim)' }}>{command.description}</p>
        )}
        <dl className="mb-3 space-y-1">
          <div>
            <dt className="inline font-medium">数据敏感度：</dt>
            <dd data-testid="ack-exposure" className="inline">{EXPOSURE_TEXT[metadata?.exposure ?? ''] ?? '未知'}</dd>
          </div>
          <div>
            <dt className="inline font-medium">将会：</dt>
            <dd data-testid="ack-authorities" className="inline">
              {authorities.length > 0 ? authorities.map(authorityLabel).join('、') : '不需要额外权限'}
            </dd>
          </div>
        </dl>
        <p className="mb-3 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          确认后，本命令将被允许按以上范围执行一次；可随时在命令详情里撤销。
          这不是一次安全授权——是否允许执行由服务端策略决定，这里只是避免误点或界面信息过期导致误执行。
        </p>
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
