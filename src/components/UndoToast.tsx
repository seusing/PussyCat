import { useEffect } from 'react'
import { useAppStore } from '../store/appStore'
import { AppAlert } from './AppAlert'

const AUTO_DISMISS_MS = 3000

export function UndoToast() {
  const lastUndo = useAppStore((s) => s.lastUndo)
  const undo = useAppStore((s) => s.undoLastFavorite)
  const dismiss = useAppStore((s) => s.dismissUndo)

  useEffect(() => {
    if (!lastUndo) return
    const id = setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [lastUndo, dismiss])

  if (!lastUndo) return null
  const label = lastUndo.kind === 'site'
    ? `已取消收藏站点 ${lastUndo.item.site}`
    : `已取消收藏命令 ${lastUndo.item.command}`
  const toastKey = lastUndo.kind === 'site'
    ? `site:${lastUndo.item.site}`
    : `command:${lastUndo.item.command}`

  return (
    <AppAlert
      key={toastKey}
      testId="undo-toast"
      tone="neutral"
      title={label}
      role="status"
      ariaLive="polite"
      durationMs={AUTO_DISMISS_MS}
      className="undo-toast fixed bottom-4 left-1/2 -translate-x-1/2"
      action={<button data-testid="undo-button" onClick={undo} style={{ color: 'var(--color-accent)' }}>撤销</button>}
    />
  )
}
