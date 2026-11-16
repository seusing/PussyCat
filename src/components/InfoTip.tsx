import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Info } from 'lucide-react'
import { positionMenu, useGlassMenuSurface } from './GlassMenu'
import './InfoTip.css'

const CLOSE_DELAY_MS = 160

type CardPosition = ReturnType<typeof positionMenu>

/**
 * 默认收起的说明:一个 ⓘ 按钮,悬停或聚焦打开,离开 160ms 后关闭;点击固定;Esc 或点击外部关闭。
 * 交互与笔记里的术语卡片(TermHint)一致。
 */
export function InfoTip({ label, children, className = '' }: {
  /** 按钮的无障碍名称,说明这是关于什么的说明。 */
  label: string
  children: ReactNode
  className?: string
}) {
  const cardId = useId()
  const reduceMotion = useReducedMotion()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CardPosition | null>(null)
  useGlassMenuSurface(cardRef, open)

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const openCard = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  const closeCard = useCallback(() => {
    clearCloseTimer()
    pinned.current = false
    setOpen(false)
  }, [clearCloseTimer])

  const scheduleClose = useCallback(() => {
    if (pinned.current) return
    clearCloseTimer()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  useLayoutEffect(() => {
    if (open && triggerRef.current && cardRef.current) setPosition(positionMenu(triggerRef.current, cardRef.current))
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const reposition = () => {
      if (triggerRef.current && cardRef.current) setPosition(positionMenu(triggerRef.current, cardRef.current))
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (triggerRef.current?.contains(target) || cardRef.current?.contains(target))) return
      closeCard()
    }
    // 外层面板可能自己用 Esc 关窗口,在捕获阶段先拦下,只关这张卡片。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closeCard()
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, closeCard])

  const cardStyle: CSSProperties = position
    ? { top: position.top, left: position.left, maxHeight: position.maxHeight }
    : { top: 0, left: 0, visibility: 'hidden' }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`info-tip ${className}`.trim()}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onFocus={openCard}
        onBlur={scheduleClose}
        onClick={(event) => {
          // 放在 <label>/<summary> 里时不能顺带触发外层的点击行为
          event.preventDefault()
          event.stopPropagation()
          if (pinned.current) closeCard()
          else { pinned.current = true; openCard() }
        }}
      >
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={cardRef}
              key="info-tip-card"
              id={cardId}
              role="tooltip"
              className="info-tip-card glass-menu-surface glass-menu-effect"
              style={cardStyle}
              onMouseEnter={openCard}
              onMouseLeave={scheduleClose}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, pointerEvents: 'auto' }}
              exit={{ opacity: 0, y: 4, pointerEvents: 'none' }}
              transition={{ duration: reduceMotion ? 0 : 0.14 }}
            >
              <div className="glass-menu-content info-tip-card-body">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
