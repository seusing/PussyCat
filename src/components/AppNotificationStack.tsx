import { Children, isValidElement, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import './AppNotificationStack.css'

export function AppNotificationStack({ children }: { children: ReactNode }) {
  const cards = Children.toArray(children)
  const reducedMotion = useReducedMotion()

  return (
    <div className="app-notification-stack">
      {cards.map((child, index) => (
        <motion.div
          key={isValidElement(child) ? child.key : index}
          className="app-notification-stack__card"
          data-front={index === 0}
          initial={reducedMotion ? false : { z: 40, y: 10, opacity: 0 }}
          animate={{
            z: -60 * index,
            y: -12 * index,
            rotateX: Math.min(index * 2, 10),
            opacity: Math.max(0.16, 1 - index * 0.18),
          }}
          transition={reducedMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 250, damping: 25, mass: 0.8 }}
          style={{ zIndex: cards.length - index }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  )
}
