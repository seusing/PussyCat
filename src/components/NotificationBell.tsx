import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { Bell } from 'lucide-react'
import { selectUnreadCount, useNotificationHistory } from '../store/notificationHistory'
import { NotificationHistoryPopover } from './NotificationHistoryPopover'
import './NotificationBell.css'

// 摇铃:从 0 度出发的欠阻尼弹簧(刚度 220、阻尼 10),给一个初速度让它先甩到 peak 度再衰减,约 1 秒停。
// 一次来的通知越多甩得越大:18 度起,每多一条加 4 度,封顶 30 度。
const RING_BASE_DEG = 18
const RING_STEP_DEG = 4
const RING_MAX_DEG = 30
const RING_PEAK_SECONDS = 0.0435   // 初速度 = -peak / 这个值时,第一次摆幅恰好是 peak
const RING_SPRING = { type: 'spring', stiffness: 220, damping: 10 } as const
const BADGE_SPRING = { type: 'spring', stiffness: 600, damping: 20 } as const

export const ringPeak = (added: number) => Math.min(RING_BASE_DEG + RING_STEP_DEG * (added - 1), RING_MAX_DEG)

/** 顶栏按钮组里的通知铃铛:未读角标、新通知摇铃,点开是历史面板。 */
export function NotificationBell() {
  const unread = useNotificationHistory(selectUnreadCount)
  const reducedMotion = useReducedMotion()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [ringCount, setRingCount] = useState(0)
  const iconRef = useRef<HTMLSpanElement>(null)
  const ringing = useRef<{ stop: () => void } | null>(null)
  // 启动时已持久化的未读不摇:基准取第一次渲染时的未读数。
  const previousUnread = useRef(unread)
  const open = anchor !== null

  useEffect(() => {
    const added = unread - previousUnread.current
    previousUnread.current = unread
    const icon = iconRef.current
    // 只在未读数增加、面板关着、允许动效时摇;面板开着时新通知一进来就被标成已读。
    if (added <= 0 || open || reducedMotion || !icon) return
    ringing.current?.stop()
    ringing.current = animate(icon, { rotate: 0 }, { ...RING_SPRING, velocity: -ringPeak(added) / RING_PEAK_SECONDS })
    setRingCount((count) => count + 1)
  }, [unread, open, reducedMotion])

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
