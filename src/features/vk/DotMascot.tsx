import { motion, useReducedMotion } from 'motion/react'
import './DotMascot.css'

// 指数缓出、不回弹:从一个小点长出来,关掉时缩回去(做法参照 bloub)
const GROW = [0.16, 1, 0.3, 1] as const

/** 点点:一颗绿点加两只眼睛。待机时眨眼、眼神左右漂移;放进 AnimatePresence 才有进出动画。 */
export function DotMascot({ size = 26 }: { size?: number }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.span
      className="dot-mascot"
      data-testid="vk-dot-mascot"
      aria-hidden="true"
      style={{ width: size, height: size }}
      initial={reduceMotion ? false : { scale: 0.15, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { scale: 0.15, opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: GROW }}
    >
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <circle cx="20" cy="21" r="15" fill="var(--color-success, #3fb950)" />
        <g className="dot-mascot-gaze">
          <g className="dot-mascot-eyes">
            <ellipse cx="15.2" cy="19" rx="2.5" ry="4.2" fill="#fff" transform="rotate(-14 15.2 19)" />
            <ellipse cx="24.8" cy="19" rx="2.5" ry="4.2" fill="#fff" transform="rotate(-14 24.8 19)" />
          </g>
        </g>
      </svg>
    </motion.span>
  )
}
