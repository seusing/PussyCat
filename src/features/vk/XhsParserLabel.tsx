import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

// 参照 spring-scale-in:每个字从 0.7 倍弹到略超 1 再回落,字与字错开一点
const SPRING = { type: 'spring', stiffness: 420, damping: 16, mass: 0.6 } as const
const STAGGER_S = 0.045

/** 「用模型 / 用点点」开关的文字:当前方式的两个字用荧光笔高亮,切换时逐字弹出。 */
export function XhsParserLabel({ dot }: { dot: boolean }) {
  const reduceMotion = useReducedMotion()
  const word = dot ? '点点' : '模型'
  return (
    <span className="vk-parser-label" aria-hidden="true">
      用
      <span className={`vk-parser-word${dot ? ' is-dot' : ''}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={word} className="vk-parser-word-chars">
            {[...word].map((char, index) => (
              <motion.span
                key={index}
                className="vk-parser-char"
                initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { scale: 0.7, opacity: 0, transition: { duration: 0.12 } }}
                transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: index * STAGGER_S }}
              >
                {char}
              </motion.span>
            ))}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}
