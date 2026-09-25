import { Children, isValidElement, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import './AppNotificationStack.css'

type Props = { children: ReactNode; onOverflow?: (count: number) => void }

export function AppNotificationStack({ children, onOverflow }: Props) {
  const cards = Children.toArray(children)
  const reducedMotion = useReducedMotion()
  const stackRef = useRef<HTMLDivElement>(null)
  const lastOverflowRef = useRef(0)
  const measure = useCallback(() => {
    const stack = stackRef.current
    if (!stack || cards.length === 0 || !onOverflow) {
      lastOverflowRef.current = 0
      return
    }
    const appMain = stack.closest<HTMLElement>('.app-main')
    if (!appMain) {
      lastOverflowRef.current = 0
      return
    }
    const available = Math.max(0, appMain.getBoundingClientRect().bottom - stack.getBoundingClientRect().top)
    const heights = Array.from(stack.querySelectorAll<HTMLElement>(':scope > .app-notification-stack__card')).map((card) => card.getBoundingClientRect().height)
    let visible = 0
    let used = 0
    for (const height of heights) {
      const next = visible === 0 ? height : used + 8 + height
      if (visible > 0 && next > available) break
      used = next
      visible += 1
    }
    visible = Math.max(1, visible)
    const overflow = Math.max(0, cards.length - visible)
    const previousOverflow = lastOverflowRef.current
    lastOverflowRef.current = overflow
    if (overflow > 0 && overflow !== previousOverflow) onOverflow(overflow)
  }, [cards.length, onOverflow])

  useLayoutEffect(() => {
    measure()
    const stack = stackRef.current
    if (!stack) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(stack)
    stack.querySelectorAll<HTMLElement>(':scope > .app-notification-stack__card').forEach((card) => observer?.observe(card))
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [measure])

  return <div ref={stackRef} className="app-notification-stack">
    {cards.map((child, index) => <motion.div
        key={isValidElement(child) ? child.key : index}
        layout={!reducedMotion}
        className="app-notification-stack__card"
        data-front={index === 0}
        style={{ zIndex: cards.length - index }}
        initial={reducedMotion ? false : { y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.01, ease: 'easeOut' }}
      >{child}</motion.div>)}
  </div>
}
