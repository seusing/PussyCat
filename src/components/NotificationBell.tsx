import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { Bell } from 'lucide-react'
import { selectUnreadCount, useNotificationHistory } from '../store/notificationHistory'
import { NotificationHistoryPopover } from './NotificationHistoryPopover'
import './NotificationBell.css'

// 摇铃:从 0 度出发的欠阻尼弹簧(刚度 220、阻尼 4.5),给一个初速度让它单向起摆、先甩到 peak 度再逐渐衰减;
// 实测约 0.1 秒到峰值,超过 3 度的摆动持续约 1.1 秒,超过 1.5 度的约 1.4 秒。
// 一次来的通知越多甩得越大:28 度起,每多一条加 3 度,封顶 38 度。
const RING_BASE_DEG = 28
const RING_STEP_DEG = 3
const RING_MAX_DEG = 38
export const RING_SPRING = { type: 'spring', stiffness: 220, damping: 4.5 } as const
// 质量 1 的欠阻尼弹簧从 0 出发、初速度为 v0 时,第一次摆到的最大幅度恰是 v0 乘这个系数(秒),
// 所以初速度取 -peak / 系数,首个峰值就是 peak。
const PEAK_PER_VELOCITY = (() => {
  const halfDamping = RING_SPRING.damping / 2
  const dampedFrequency = Math.sqrt(RING_SPRING.stiffness - halfDamping ** 2)
  const peakTime = Math.atan(dampedFrequency / halfDamping) / dampedFrequency
  return (Math.exp(-halfDamping * peakTime) * Math.sin(dampedFrequency * peakTime)) / dampedFrequency
})()
const BADGE_SPRING = { type: 'spring', stiffness: 600, damping: 20 } as const

export const ringPeak = (added: number) => Math.min(RING_BASE_DEG + RING_STEP_DEG * (added - 1), RING_MAX_DEG)
export const ringVelocity = (added: number) => -ringPeak(added) / PEAK_PER_VELOCITY

/** 用户现在看得到窗口:页面可见,并且窗口有焦点。 */
const windowSeen = () => document.visibilityState !== 'hidden' && document.hasFocus()

/** 顶栏按钮组里的通知铃铛:未读角标、新通知摇铃,点开是历史面板。 */
export function NotificationBell() {
  const unread = useNotificationHistory(selectUnreadCount)
  const reducedMotion = useReducedMotion()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [ringCount, setRingCount] = useState(0)
  const iconRef = useRef<HTMLSpanElement>(null)
  const ringing = useRef<{ stop: () => void; state: string } | null>(null)
  // 启动时已持久化的未读不摇:基准取第一次渲染时的未读数。
  const previousUnread = useRef(unread)
  // 窗口在后台或没有焦点时来的通知,用户看不到摇铃:记下条数,等回到前台再补摇一次。
  const pendingRing = useRef(0)
  const open = anchor !== null
  const latest = useRef({ unread, open, reducedMotion })
  latest.current = { unread, open, reducedMotion }

  const ring = useCallback((added: number) => {
    const icon = iconRef.current
    if (!icon) return
    ringing.current?.stop()
    ringing.current = animate(icon, { rotate: 0 }, { ...RING_SPRING, velocity: ringVelocity(added) })
    setRingCount((count) => count + 1)
  }, [])

  useEffect(() => {
    const added = unread - previousUnread.current
    previousUnread.current = unread
    if (unread === 0) pendingRing.current = 0
    // 只在未读数增加、面板关着、允许动效时摇;面板开着时新通知一进来就被标成已读。
    if (added <= 0 || open || reducedMotion) return
    if (!windowSeen()) {
      pendingRing.current += added
      return
    }
    // 前台照旧立即摇;之前攒下的(窗口只是失焦又刚好回来)一并算进这一次。
    ring(added + pendingRing.current)
    pendingRing.current = 0
  }, [unread, open, reducedMotion, ring])

  useEffect(() => {
    const catchUp = () => {
      if (pendingRing.current === 0 || !windowSeen()) return
      const added = pendingRing.current
      pendingRing.current = 0
      const current = latest.current
      if (current.unread > 0 && !current.open && !current.reducedMotion) ring(added)
    }
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    return () => {
      document.removeEventListener('visibilitychange', catchUp)
      window.removeEventListener('focus', catchUp)
    }
  }, [ring])

  useEffect(() => () => ringing.current?.stop(), [])

  const label = unread > 0 ? `通知，${unread} 条未读` : '通知'
  return (
    <>
      <button
        type="button"
        data-testid="notification-bell"
        data-ring-count={ringCount}
        className="app-icon-button notification-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title="通知"
        onPointerEnter={(event) => {
          // 鼠标移入摇一次(幅度同一条通知);触摸和键盘聚焦不触发,面板开着、减少动态效果、正在摇时也不摇。
          if (event.pointerType !== 'mouse' || open || reducedMotion || ringing.current?.state === 'running') return
          ring(1)
        }}
        onClick={(event) => {
          const bell = event.currentTarget
          setAnchor((current) => (current ? null : bell))
        }}
      >
        <motion.span ref={iconRef} className="notification-bell__icon"><Bell size={17} aria-hidden="true" /></motion.span>
        {unread > 0 && (
          <motion.span
            data-testid="notification-badge"
            className="notification-bell__badge"
            aria-hidden="true"
            initial={reducedMotion ? { opacity: 0 } : { scale: 0 }}
            animate={reducedMotion ? { opacity: 1 } : { scale: 1 }}
            transition={reducedMotion ? { duration: 0.2, ease: 'easeOut' } : BADGE_SPRING}
          >
            {unread > 99 ? '99+' : unread}
          </motion.span>
        )}
      </button>
      <AnimatePresence>
        {anchor && <NotificationHistoryPopover key="notification-history" anchor={anchor} onClose={() => setAnchor(null)} />}
      </AnimatePresence>
    </>
  )
}
