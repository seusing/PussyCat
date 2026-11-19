import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { glassPopMotion, positionMenu, useGlassMenuSurface } from '../../components/GlassMenu'
import './DotSuggestTip.css'

/** 小红书链接用什么解析:模型通道(付费)或点点速览(免费)。 */
export type XhsParser = 'model' | 'dot'

const OPEN_DELAY_MS = 400

type Placement = { top: number; left: number; above: boolean }

/**
 * 链接框里出现小红书链接时,贴着链接框弹出的小贴士,问要不要用点点免费解析。
 * 不加遮罩、不锁页面、不抢输入框的焦点;点「用模型」、按 Esc、点贴士和链接框以外的地方,
 * 都等于继续用模型。出现前先停顿片刻,粘贴或输入告一段落再弹。
 */
export function DotSuggestTip({ anchorRef, active, onChoose }: {
  anchorRef: RefObject<HTMLElement | null>
  /** 有小红书链接、且这批链接还没选过解析方式。 */
  active: boolean
  onChoose: (choice: XhsParser) => void
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return undefined
    }
    const timer = window.setTimeout(() => setShown(true), OPEN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [active])

  const anchor = anchorRef.current
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {shown && anchor && <TipBubble key="dot-tip" anchor={anchor} onChoose={onChoose} />}
    </AnimatePresence>,
    document.body,
  )
}

function TipBubble({ anchor, onChoose }: { anchor: HTMLElement; onChoose: (choice: XhsParser) => void }) {
  const titleId = useId()
  const bodyId = useId()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const reduceMotion = useReducedMotion()
  useGlassMenuSurface(surfaceRef, true)

  useLayoutEffect(() => {
    const update = () => {
      const surface = surfaceRef.current
      if (!surface) return
      const { top, left } = positionMenu(anchor, surface)
      setPlacement({ top, left, above: top < anchor.getBoundingClientRect().top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  const chooseRef = useRef(onChoose)
  chooseRef.current = onChoose
  // 选定后贴士还要播一小段退场动画;这期间不能再把下一次点击(比如「开始解析」)当成「点在别处」
  const present = useIsPresent()
  useEffect(() => {
    if (!present) return undefined
    // 点在链接框里是继续编辑,不算忽略贴士
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (surfaceRef.current?.contains(target) || anchor.contains(target))) return
      chooseRef.current('model')
    }
    // 外层面板可能自己用 Esc 关窗口,在捕获阶段先拦下,只关这张贴士
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      chooseRef.current('model')
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchor, present])

  return (
    <motion.div
      ref={surfaceRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="vk-dot-tip"
      data-placement={placement?.above ? 'above' : 'below'}
      className="dot-tip glass-menu-effect"
      style={placement
        ? { top: placement.top, left: placement.left, visibility: 'visible', originY: placement.above ? 1 : 0 }
        : { top: 0, left: 0, visibility: 'hidden' }}
      {...glassPopMotion(reduceMotion)}
    >
      <div className="glass-menu-content">
        <p id={titleId} className="dot-tip-title">用点点免费解析小红书链接？</p>
        <p id={bodyId} className="dot-tip-body">用你登录的小红书账号，约半分钟出总结，没有时间轴、章节和行情图</p>
        <div className="dot-tip-actions">
          <button type="button" data-testid="vk-dot-tip-model" onClick={() => onChoose('model')}>用模型</button>
          <button type="button" data-testid="vk-dot-tip-dot" className="dot-tip-primary" onClick={() => onChoose('dot')}>用点点</button>
        </div>
      </div>
    </motion.div>
  )
}
