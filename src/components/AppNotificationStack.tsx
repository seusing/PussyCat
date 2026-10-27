import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import './AppNotificationStack.css'

type Props = { children: ReactNode; onOverflow?: (count: number) => void }

// 收起时露出的卡边层数、每层向下错开的距离,以及各层透明度(第 3 张起完全隐藏)。
const PEEK_LAYERS = 2
const PEEK_OFFSET = 6
const LAYER_OPACITY = [1, 0.7, 0.45]
const CARD_GAP = 8
const SPRING = { type: 'spring', stiffness: 400, damping: 32 } as const

export function AppNotificationStack({ children, onOverflow }: Props) {
  const cards = Children.toArray(children)
  const count = cards.length
  const reducedMotion = useReducedMotion()
  const stackRef = useRef<HTMLDivElement>(null)
  const lastOverflowRef = useRef(0)
  const [expanded, setExpanded] = useState(false)
  // 条数降到 1 条就回到收起,下次再有 2 条时默认仍是收起
  useEffect(() => { if (count < 2) setExpanded(false) }, [count])
  const collapsed = count >= 2 && !expanded

  const measure = useCallback(() => {
    const stack = stackRef.current
    // 收起时只占一张卡的高度,不会撑出可用空间,不做淘汰
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

  const peekHeight = collapsed ? Math.min(count - 1, PEEK_LAYERS) * PEEK_OFFSET : 0

  return <div ref={stackRef} className="app-notification-stack">
    <div className="app-notification-stack__cards" style={{ paddingBottom: peekHeight }}>
      {cards.map((child, index) => {
        const layer = collapsed ? Math.min(index, PEEK_LAYERS) : 0
        const covered = collapsed && index > 0
        const opacity = collapsed ? (LAYER_OPACITY[index] ?? 0) : 1
        // 被盖住的卡仍然挂载(自动过期的计时器在子组件里),但不能被读屏、点击或聚焦
        const coveredProps = covered ? { 'aria-hidden': true, inert: '' } : {}
        return <motion.div
          key={isValidElement(child) ? child.key : index}
          layout={!reducedMotion}
          className="app-notification-stack__card"
          data-front={index === 0}
          data-layer={layer}
          data-covered={covered}
          style={{ zIndex: count - index }}
          initial={reducedMotion ? false : { y: -8, opacity: 0 }}
          animate={{ y: layer * PEEK_OFFSET, opacity }}
          transition={reducedMotion ? { duration: 0 } : SPRING}
          {...coveredProps}
        >{child}</motion.div>
      })}
    </div>
    {count >= 2 && <motion.div
      layout={reducedMotion ? false : 'position'}
      className="app-notification-stack__toggle-row"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reducedMotion ? { duration: 0 } : SPRING}
    >
      <button type="button" className="app-notification-stack__toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        {expanded ? '收起' : `全部 ${count} 条`}
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
    </motion.div>}
  </div>
}
