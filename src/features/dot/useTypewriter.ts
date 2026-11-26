import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'

// 匀速吐字:回答按轮询一段段到达,直接上屏会一顿一顿。这里按时间均匀放出字符,积压越多放得越快,
// 不会越拖越远;回答结束后加速收尾。
const BASE_CHARS_PER_SECOND = 45
const CATCH_UP_PER_CHAR = 2.5
const FINISH_MULTIPLIER = 3
// 正文每次放字都要整段重排一遍 Markdown,约 30 帧一秒足够顺,不必每帧都更新
const MIN_COMMIT_MS = 32

/** 经过 dtMs 之后应该显示到第几个字(纯函数,便于测试)。 */
export function nextReveal(shown: number, total: number, dtMs: number, streaming: boolean): number {
  if (shown >= total) return total
  const backlog = total - shown
  const perSecond = (BASE_CHARS_PER_SECOND + backlog * CATCH_UP_PER_CHAR) * (streaming ? 1 : FINISH_MULTIPLIER)
  return Math.min(total, shown + Math.max(1, Math.round((perSecond * dtMs) / 1000)))
}

/**
 * @param text 目前收到的全部正文
 * @param streaming 还在生成
 * @param instant 直接显示全部(停止、出错时定格)
 */
export function useTypewriter(text: string, streaming: boolean, instant = false): string {
  const reduceMotion = useReducedMotion()
  const immediate = instant || !!reduceMotion || typeof requestAnimationFrame !== 'function'
  // 打开时已经答完的回答(翻看对话记录)直接整段显示,不重新打一遍字
  const [shown, setShown] = useState(() => (immediate || !streaming ? text.length : 0))
  const shownRef = useRef(shown)
  shownRef.current = Math.min(shown, text.length)

  useEffect(() => {
    if (immediate) {
      setShown(text.length)
      return
    }
    if (shownRef.current >= text.length) return
    let frame = 0
    let last = performance.now()
    // 用 performance.now() 而不是帧回调给的时间戳:两者在有的环境(jsdom)里不是同一个起点
    const tick = () => {
      const now = performance.now()
      if (now - last < MIN_COMMIT_MS) {
        frame = requestAnimationFrame(tick)
        return
      }
      const next = nextReveal(shownRef.current, text.length, now - last, streaming)
      last = now
      shownRef.current = next
      setShown(next)
      if (next < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, streaming, immediate])

  return text.slice(0, immediate ? text.length : Math.min(shown, text.length))
}
