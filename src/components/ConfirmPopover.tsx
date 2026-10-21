import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { positionMenu, useGlassMenuSurface } from './GlassMenu'
import './ConfirmPopover.css'

type Placement = ReturnType<typeof positionMenu> & { above: boolean }

/**
 * 关闭后把焦点还给触发按钮。点在页面空白处时,浏览器处理完这次点击会把焦点移到 body,
 * 所以下一拍再补一次;点到别的可聚焦元素则让它保留焦点。
 */
function restoreFocus(anchor: HTMLElement) {
  anchor.focus({ preventScroll: true })
  window.setTimeout(() => {
    const active = document.activeElement
    if (anchor.isConnected && (!active || active === document.body)) anchor.focus({ preventScroll: true })
  }, 0)
}

/**
 * 锚定在触发按钮上的就地确认气泡。挂载即打开,卸载即关闭;要播退出动画就把它放进调用方的
 * AnimatePresence。取消、Esc、点外部、确认之后焦点都回到触发按钮。
 */
export function ConfirmPopover({ anchor, title, body, confirmLabel, onConfirm, onCancel }: {
  anchor: HTMLElement
  title: string
  /** 正文,每个元素一行。 */
  body: readonly string[]
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const bodyId = useId()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const reduceMotion = useReducedMotion()
  useGlassMenuSurface(surfaceRef, true)

  useLayoutEffect(() => {
    const update = () => {
      const surface = surfaceRef.current
      if (!surface) return
      const position = positionMenu(anchor, surface)
      setPlacement({ ...position, above: position.top < anchor.getBoundingClientRect().top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  // 定位前气泡是 visibility:hidden,聚焦要等定位完成之后。
  const positioned = placement !== null
  useEffect(() => {
    if (positioned) cancelRef.current?.focus({ preventScroll: true })
  }, [positioned])

  const dismiss = () => {
    restoreFocus(anchor)
    onCancel()
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (surfaceRef.current?.contains(target) || anchor.contains(target))) return
      dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()   // 不触发 App 全局 Esc
      dismissRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor])

  return createPortal(
    <motion.div
      ref={surfaceRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="confirm-popover glass-menu-effect"
      style={placement
        ? {
          top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight,
          visibility: 'visible', originY: placement.above ? 1 : 0,
        }
        : { top: 0, left: 0, visibility: 'hidden' }}
      initial={{ opacity: 0.96, y: 5, scaleY: 0.96 }}
      animate={{ opacity: 1, y: 0, scaleY: 1, pointerEvents: 'auto' }}
      exit={{ opacity: 0.96, y: 5, scaleY: 0.96, pointerEvents: 'none' }}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
    >
      <div className="glass-menu-content">
        <h3 id={titleId} className="confirm-popover-title">{title}</h3>
        <div id={bodyId} className="confirm-popover-body">
          {body.map((line, index) => <p key={index}>{line}</p>)}
        </div>
        <div className="confirm-popover-actions">
          <button ref={cancelRef} type="button" className="confirm-popover-cancel" onClick={dismiss}>取消</button>
          <button
            type="button"
            className="confirm-popover-confirm"
            onClick={() => {
              restoreFocus(anchor)
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </motion.div>,
    document.body,
  )
}
