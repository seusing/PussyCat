import { useEffect, useRef } from 'react'
import { siteLabel } from '../../data/zhCopy'
import type { CommandManifest } from '../../data/types'
import type { PolicyDecision } from '../../data/policy'

export type PendingAcknowledgement = { command: CommandManifest; decision: PolicyDecision }

/**
 * 提交确认框。**不是安全授权**（I-P5）——真正的执行边界是 Host 对 denied/unknown 的拒绝；
 * 这里只防止用户误点。所有手动提交（包括已确认的命令）都先经过这里。
 * acknowledgement-required 命令的 fingerprint 持久化和请求封装由 App.tsx 的
 * executeSelected({ confirmed: true }) 统一处理。
 */
export function AcknowledgeDialog({ pending, onConfirmed, onCancel }: {
  pending: PendingAcknowledgement | undefined
  onConfirmed: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // 打开时焦点落在「确认提交」(回车即确认);关闭时把焦点还给打开前的元素。
  useEffect(() => {
    if (!pending) return
    const previous = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => previous?.focus()
  }, [pending])

  if (!pending) return null
  const { command } = pending

  const handleBackdropClick = () => onCancel()

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()   // 防止触发 App 全局 Esc（收起结果面板）
      onCancel()
    }
  }

  return (
    <div
      className="app-glass-dialog-backdrop ack-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        data-testid="acknowledge-dialog"
        className="app-glass-dialog ack-dialog w-full rounded-[14px] p-5"
        style={{ maxWidth: 380, outline: 'none' }}
        tabIndex={-1}   // 点到卡片空白处时焦点仍留在框内,Esc 才能被 onKeyDown 接住
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 font-semibold" style={{ fontSize: 17, color: 'var(--color-fg)' }}>是否确认提交？</h3>
        <p className="mb-5" style={{ fontSize: 13, color: 'var(--color-fg-dim)' }}>
          {siteLabel(command.site)} · {command.name}
        </p>
        <div className="flex justify-end gap-2">
          <button
            data-testid="ack-cancel"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg-dim)', background: 'transparent' }}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            data-testid="ack-confirm"
            onClick={onConfirmed}
            className="cmd-run-btn"
          >
            确认提交
          </button>
        </div>
      </div>
    </div>
  )
}
