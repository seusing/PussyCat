import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { NotificationStackCardContext } from './notificationContext'
import './AppNotificationStack.css'

type Props = {
  children: ReactNode
  onOverflow?: (count: number) => void
  /** 收起时切换按钮上的文字,默认「全部 N 条」。 */
  toggleLabel?: (count: number) => string
}

// 收起时露出两层卡边:深度 1、2 分别下移 9px、18px,横向收窄到 91.5%、83%(原点在顶部居中)。
const PEEK_LAYERS = 2
const PEEK_OFFSET = [0, 9, 18]
const PEEK_SCALE = [1, 0.915, 0.83]
const CARD_GAP = 10
// 展开时弹簧回弹,第 2 张起依次错开 45ms,最多错开 8 张。
const SPRING = { type: 'spring', stiffness: 340, damping: 22, mass: 0.9 } as const
const STAGGER_S = 0.045
const STAGGER_MAX = 8
const REDUCED_TRANSITION = { duration: 0.2, ease: 'easeOut' } as const
const LABEL_SLIDE_PX = 5

const defaultToggleLabel = (count: number) => `全部 ${count} 条`

export function AppNotificationStack({ children, onOverflow, toggleLabel = defaultToggleLabel }: Props) {
  const cards = Children.toArray(children)
  const count = cards.length
  const reducedMotion = useReducedMotion()
  const stackRef = useRef<HTMLDivElement>(null)
  const frontRef = useRef<HTMLDivElement>(null)
  const lastOverflowRef = useRef(0)
  const [expanded, setExpanded] = useState(false)
  // 条数降到 1 条就回到收起,下次再有 2 条时默认仍是收起
  useEffect(() => { if (count < 2) setExpanded(false) }, [count])
  const collapsed = count >= 2 && !expanded

  const measure = useCallback(() => {
    const stack = stackRef.current
    // 收起时只占一张卡的高度,不会撑出可用空间,不做淘汰;没人要淘汰数量也就不用量
    if (!stack || count === 0 || !onOverflow || collapsed) {
      lastOverflowRef.current = 0
      return
    }
    const appMain = stack.closest<HTMLElement>('.app-main')
    if (!appMain) {
      lastOverflowRef.current = 0
      return
    }
    // 展开时底部的「收起」胶囊也要留出位置,否则被裁掉就收不回去了
    const toggle = stack.querySelector<HTMLElement>('.app-notification-stack__toggle')
    const reserved = toggle ? toggle.getBoundingClientRect().height + CARD_GAP : 0
    const available = Math.max(0, appMain.getBoundingClientRect().bottom - stack.getBoundingClientRect().top - reserved)
    const heights = Array.from(stack.querySelectorAll<HTMLElement>('.app-notification-stack__card')).map((card) => card.getBoundingClientRect().height)
    let visible = 0
    let used = 0
    for (const height of heights) {
      const next = visible === 0 ? height : used + CARD_GAP + height
      if (visible > 0 && next > available) break
      used = next
      visible += 1
    }
    visible = Math.max(1, visible)
    const overflow = Math.max(0, count - visible)
    const previousOverflow = lastOverflowRef.current
    lastOverflowRef.current = overflow
    if (overflow > 0 && overflow !== previousOverflow) onOverflow(overflow)
  }, [count, onOverflow, collapsed])

  useLayoutEffect(() => {
    measure()
    const stack = stackRef.current
    if (!stack) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(stack)
    stack.querySelectorAll<HTMLElement>('.app-notification-stack__card, .app-notification-stack__toggle').forEach((element) => observer?.observe(element))
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [measure])

  // 被盖住的卡片要和最前面那张一样高,叠在它后面时才只露出一道卡边;前卡的高度写进 --stack-front-height。
  useLayoutEffect(() => {
    const front = frontRef.current
    const stack = stackRef.current
    if (!front || !stack) return
    const sync = () => stack.style.setProperty('--stack-front-height', `${front.getBoundingClientRect().height}px`)
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(front)
    return () => observer.disconnect()
  }, [count, collapsed])

  const peekHeight = collapsed ? PEEK_OFFSET[Math.min(count - 1, PEEK_LAYERS)] : 0
  const label = toggleLabel(count)
  const toggleText = expanded ? '收起' : label
  const slide = expanded ? 1 : -1   // 展开时旧文字向上滑出、新文字从下面滑入;收起时反过来

  return <div ref={stackRef} className="app-notification-stack">
    <div className="app-notification-stack__cards" style={{ paddingBottom: peekHeight }}>
      {cards.map((child, index) => {
        const layer = collapsed ? Math.min(index, PEEK_LAYERS) : 0
        const covered = collapsed && index > 0
        // 被盖住的卡仍然挂载(自动过期的计时器在子组件里),但不能被读屏、点击或聚焦
        const coveredProps = covered ? { 'aria-hidden': true, inert: '' } : {}
        const stagger = expanded && index > 0 ? Math.min(index - 1, STAGGER_MAX) * STAGGER_S : 0
        return <motion.div
          key={isValidElement(child) ? child.key : index}
          ref={index === 0 ? frontRef : undefined}
          layout={reducedMotion ? false : 'position'}
          className="app-notification-stack__card"
          data-front={index === 0}
          data-layer={layer}
          data-covered={covered}
          style={{ zIndex: count - index, originX: 0.5, originY: 0 }}
          initial={reducedMotion ? false : { y: -8, scale: 0.98 }}
          animate={{ y: PEEK_OFFSET[layer], scaleX: PEEK_SCALE[layer] }}
          transition={reducedMotion ? REDUCED_TRANSITION : { ...SPRING, delay: stagger }}
          {...coveredProps}
        >
          <NotificationStackCardContext.Provider value={{ covered }}>{child}</NotificationStackCardContext.Provider>
        </motion.div>
      })}
    </div>
    {count >= 2 && <motion.div
      layout={reducedMotion ? false : 'position'}
      className="app-notification-stack__toggle-row"
      transition={reducedMotion ? REDUCED_TRANSITION : SPRING}
    >
      <button
        type="button"
        className="app-notification-stack__toggle"
        aria-expanded={expanded}
        aria-label={toggleText}
        onClick={() => setExpanded((current) => !current)}
      >
        {reducedMotion
          ? <span className="app-notification-stack__toggle-text">{toggleText}</span>
          : <AnimatePresence mode="popLayout" initial={false} custom={slide}>
            <motion.span
              key={toggleText}
              className="app-notification-stack__toggle-text"
              custom={slide}
              variants={LABEL_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.13, ease: 'easeOut' }}
            >{toggleText}</motion.span>
          </AnimatePresence>}
        <motion.span
          className="app-notification-stack__chevron"
          data-expanded={expanded}
          aria-hidden="true"
          initial={false}
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={reducedMotion ? REDUCED_TRANSITION : { duration: 0.2, ease: 'easeOut' }}
        ><ChevronDown size={14} /></motion.span>
      </button>
    </motion.div>}
  </div>
}

const LABEL_VARIANTS = {
  enter: (direction: number) => ({ y: LABEL_SLIDE_PX * direction, opacity: 0 }),
  center: { y: 0, opacity: 1 },
  exit: (direction: number) => ({ y: -LABEL_SLIDE_PX * direction, opacity: 0 }),
}
