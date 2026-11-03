import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { selectUnreadCount, useNotificationHistory, type NotificationEntry } from '../store/notificationHistory'
import { AppAlert, type AppAlertTone } from './AppAlert'
import { AppNotificationStack } from './AppNotificationStack'
import { restoreFocus } from './ConfirmPopover'
import { glassPopMotion, positionMenu } from './GlassMenu'
import './NotificationHistoryPopover.css'

type Placement = { top: number; left: number; width: number; maxHeight: number }

const VIEWPORT_MARGIN = 8
const pad = (value: number) => String(value).padStart(2, '0')

/** 刚刚 / N 分钟前 / 当天的 HH:mm / 更早的 M月D日 HH:mm。 */
export function formatNotificationTime(createdAt: number, now: number): string {
  const elapsed = now - createdAt
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  const at = new Date(createdAt)
  const today = new Date(now)
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? clock : `${at.getMonth() + 1}月${at.getDate()}日 ${clock}`
}

function HistoryCard({ entry, now }: { entry: NotificationEntry; now: number }) {
  const tone: AppAlertTone = entry.tone === 'danger' ? 'error' : entry.tone
  return (
    <AppAlert
      testId="notification-history-item"
      dataTone={entry.tone}
      tone={tone}
      title={entry.message}
      description={[entry.description, formatNotificationTime(entry.createdAt, now)].filter(Boolean).join(' · ')}
      role="presentation"
      ariaLive="off"
    />
  )
}

/**
 * 铃铛点开的通知历史面板:机制照 OpencliReleasePanel——portal 到 body、锚定触发按钮、Esc / 点外部关闭、
 * 关闭后焦点回到触发按钮。打开时(以及开着时又来了新通知)全部标为已读。
 * 材质是普通毛玻璃,不接液态玻璃(Hyalite):面板里的内容会动(堆叠展开、长高、滚动),见 CSS 里的说明。
 */
export function NotificationHistoryPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const entries = useNotificationHistory((state) => state.entries)
  const unread = useNotificationHistory(selectUnreadCount)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (unread > 0) useNotificationHistory.getState().markAllRead()
  }, [unread])

  // 右边对齐铃铛;条数变化会改变高度,所以也要重算。
  useLayoutEffect(() => {
    const update = () => {
      const surface = surfaceRef.current
      if (!surface) return
      const { top, width, maxHeight } = positionMenu(anchor, surface)
      const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.getBoundingClientRect().right - width, window.innerWidth - VIEWPORT_MARGIN - width))
      setPlacement({ top, left, width, maxHeight })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, entries.length])

  // 定位前面板是 visibility:hidden,聚焦要等定位完成之后;焦点落在面板上,Tab 就能进到里面的按钮。
  const positioned = placement !== null
  useEffect(() => {
    if (positioned) surfaceRef.current?.focus({ preventScroll: true })
  }, [positioned])

  const dismiss = () => {
    restoreFocus(anchor)
    onClose()
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (surfaceRef.current?.contains(target) || anchor.contains(target))) return
      dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()   // 不触发 App 全局 Esc
      dismissRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor])

  const now = Date.now()
  return createPortal(
    <motion.div
      ref={surfaceRef}
      role="dialog"
      aria-label="通知"
      tabIndex={-1}
      data-testid="notification-history"
      className="notification-popover"
      style={placement
        ? {
          top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight,
          visibility: 'visible', originY: 0,
        }
        : { top: 0, left: 0, visibility: 'hidden' }}
      {...glassPopMotion(reduceMotion)}
    >
      <div>
        <div className="notification-popover__head">
          <h3>通知</h3>
          <button
            type="button"
            data-testid="notification-clear"
            disabled={entries.length === 0}
            onClick={() => useNotificationHistory.getState().clear()}
          >
            清空
          </button>
        </div>
        {entries.length === 0
          ? (
            <div data-testid="notification-empty" className="notification-popover__empty">
              <p>暂无通知</p>
              <p>任务提交、完成、中断或出错时会记在这里</p>
            </div>
          )
          : (
            <div className="notification-popover__body">
              <AppNotificationStack toggleLabel={(count) => `查看所有 ${count} 条`}>
                {entries.map((entry) => <HistoryCard key={entry.id} entry={entry} now={now} />)}
              </AppNotificationStack>
            </div>
          )}
      </div>
    </motion.div>,
    document.body,
  )
}
