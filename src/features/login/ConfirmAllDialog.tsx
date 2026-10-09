import { useEffect, useRef } from 'react'

/**
 * 「确认并检查全部」的确认框。和单个命令的 AcknowledgeDialog 一样**不是安全授权**(I-P5),
 * 只是让用户一次看清要用自己的 Chrome 去查哪些站点;各站点的确认仍按各自 decision 的
 * fingerprint 逐条写入偏好(与 App.tsx 的 executeSelected 持久化逻辑一致)。
 */
export function ConfirmAllDialog({ sites, onConfirm, onCancel }: {
  sites: string[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => previous?.focus()
  }, [])

  return (
    <div
      className="app-glass-dialog-backdrop ack-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()   // 不触发 App 全局 Esc
        onCancel()
      }}
    >
      <div
        data-testid="confirm-all-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-all-title"
        className="app-glass-dialog ack-dialog w-full rounded-[14px] p-5"
        style={{ maxWidth: 420, outline: 'none' }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="confirm-all-title" className="mb-1 font-semibold" style={{ fontSize: 17, color: 'var(--color-fg)' }}>确认并检查全部？</h3>
        <p className="mb-3" style={{ fontSize: 13, color: 'var(--color-fg-dim)' }}>
          将用你的 Chrome 检查以下站点的登录状态（只读）
        </p>
        <ul data-testid="confirm-all-sites" className="mb-5 flex flex-wrap gap-2">
          {sites.map((site) => (
            <li
              key={site}
              className="rounded-lg px-2.5 py-1 text-sm"
              style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
            >
              {site}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-all-cancel"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg-dim)', background: 'transparent' }}
          >
            取消
          </button>
          <button ref={confirmRef} type="button" data-testid="confirm-all-confirm" onClick={onConfirm} className="cmd-run-btn">
            确认并检查
          </button>
        </div>
      </div>
    </div>
  )
}
