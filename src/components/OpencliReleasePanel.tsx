import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { restoreFocus } from './ConfirmPopover'
import { glassPopMotion, positionMenu, useGlassMenuSurface } from './GlassMenu'
import './OpencliReleasePanel.css'

type Placement = ReturnType<typeof positionMenu> & { above: boolean }

type Props = {
  /** 触发按钮,面板锚定在它下面。 */
  anchor: HTMLElement
  /** 内置版本;只在生效版本不是它时传,这一行才会出现。 */
  rollbackTo?: string
  /** 「检查更新」那一行左边的说明。 */
  checkText: string
  /** 命令目录条数;未知时不显示这一行。 */
  commandCount?: number
  /** 有新版时的发布说明链接。 */
  notes?: { version: string; url: string }
  /** 更新或恢复请求在途时,「恢复内置」不可点。 */
  busy: boolean
  onCheck: () => void
  onRollback: () => void
  onClose: () => void
}

/**
 * 顶栏 OpenCLI 版本区点开的小面板:内置版本、检查更新、命令目录、发布说明。交互对齐 ConfirmPopover:
 * 挂载即打开、卸载即关闭(要播退出动画就放进调用方的 AnimatePresence),Esc、点外部、选了动作之后
 * 焦点都回到触发按钮。
 */
export function OpencliReleasePanel({ anchor, rollbackTo, checkText, commandCount, notes, busy, onCheck, onRollback, onClose }: Props) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const checkRef = useRef<HTMLButtonElement | null>(null)
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

  // 定位前面板是 visibility:hidden,聚焦要等定位完成之后。
  const positioned = placement !== null
  useEffect(() => {
    if (positioned) checkRef.current?.focus({ preventScroll: true })
  }, [positioned])

  const dismiss = () => {
    restoreFocus(anchor)
    onClose()
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

  const choose = (action: () => void) => () => {
    dismiss()
    action()
  }

  return createPortal(
    <motion.div
      ref={surfaceRef}
      role="dialog"
      aria-label="OpenCLI 版本"
      data-testid="opencli-release-panel"
      className="opencli-panel glass-menu-effect"
      style={placement
        ? {
          top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight,
          visibility: 'visible', originY: placement.above ? 1 : 0,
        }
        : { top: 0, left: 0, visibility: 'hidden' }}
      {...glassPopMotion(reduceMotion)}
    >
      <div className="glass-menu-content">
        {rollbackTo && (
          <div className="opencli-panel-row">
            <span>内置版本 {rollbackTo}</span>
            <button type="button" data-testid="rollback-opencli" aria-label="恢复内置版本" title={`退回安装包内置的 OpenCLI ${rollbackTo}`}
              disabled={busy} onClick={choose(onRollback)}>
              恢复内置
            </button>
          </div>
        )}
        <div className="opencli-panel-row">
          <span data-testid="opencli-release-checked-at">{checkText}</span>
          <button ref={checkRef} type="button" data-testid="check-updates" title="检查 OpenCLI 有没有新版本" onClick={choose(onCheck)}>
            检查更新
          </button>
        </div>
        {commandCount !== undefined && (
          <div className="opencli-panel-row">
            <span data-testid="opencli-panel-catalog">命令目录 {commandCount} 条</span>
          </div>
        )}
        {notes && (
          <div className="opencli-panel-row">
            <a href={notes.url} target="_blank" rel="noopener noreferrer">查看 {notes.version} 发布说明</a>
          </div>
        )}
      </div>
    </motion.div>,
    document.body,
  )
}
