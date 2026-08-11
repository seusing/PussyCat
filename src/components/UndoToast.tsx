import { useEffect } from 'react'
import { useAppStore } from '../store/appStore'

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

  return (
    <div
      data-testid="undo-toast"
      className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2 text-sm shadow-lg"
      style={{ background: 'var(--color-panel)', color: 'var(--color-fg)', border: '1px solid var(--color-line)' }}
    >
      <span>{label}</span>
      <button data-testid="undo-button" onClick={undo} style={{ color: 'var(--color-accent)' }}>撤销</button>
    </div>
  )
}
