import { forwardRef, useCallback, useContext, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Info, RotateCw, TriangleAlert, X } from 'lucide-react'
import { useGlassMenuSurface } from './GlassMenu'
import { NotificationLayerContext, NotificationStackCardContext } from './notificationContext'
import './AppAlert.css'

export type AppAlertTone = 'info' | 'success' | 'warning' | 'error' | 'rerun' | 'neutral'

type AppAlertProps = {
  tone?: AppAlertTone
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  onClose?: () => void
  closeLabel?: string
  className?: string
  testId?: string
  role?: 'status' | 'alert' | 'presentation'
  ariaLive?: 'off' | 'polite' | 'assertive'
  progress?: number
  durationMs?: number
  onExpire?: () => void
  progressTestId?: string
  progressLabel?: string
  progressClassName?: string
  dataTone?: string
}

const toneIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: CircleAlert,
  rerun: RotateCw,
  neutral: Info,
} satisfies Record<AppAlertTone, typeof Info>

function cx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ')
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export const AppAlert = forwardRef<HTMLDivElement, AppAlertProps>(function AppAlert({
  tone = 'neutral',
  title,
  description,
  action,
  onClose,
  closeLabel = '关闭通知',
  className,
  testId,
  role,
  ariaLive,
  progress,
  durationMs,
  onExpire,
  progressTestId,
  progressLabel = '通知剩余时间',
  progressClassName,
  dataTone,
}, forwardedRef) {
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire
  const expires = typeof onExpire === 'function'
  useEffect(() => {
    if (durationMs === undefined || !expires) return
    const timer = window.setTimeout(() => onExpireRef.current?.(), durationMs)
    return () => window.clearTimeout(timer)
  }, [durationMs, expires])

  // 在悬浮层里、而且不是被盖住的那几张:接上液态玻璃(和玻璃菜单同一套)。
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])
  const inLayer = useContext(NotificationLayerContext)
  const stackCard = useContext(NotificationStackCardContext)
  const glass = inLayer && !stackCard?.covered
  useGlassMenuSurface(rootRef, glass)

  const Icon = toneIcons[tone]
  const rootRole = role ?? (tone === 'error' ? 'alert' : 'status')
  const controlledProgress = typeof progress === 'number'
  const hasProgress = controlledProgress || typeof durationMs === 'number'
  const progressValue = controlledProgress ? clampProgress(progress) : 100
  const progressStyle: CSSProperties = {
    width: `${progressValue}%`,
    ...(durationMs !== undefined && !controlledProgress ? { animationDuration: `${durationMs}ms` } : {}),
  }

  return (
    <div
      ref={setRootRef}
      data-testid={testId}
      data-tone={dataTone ?? tone}
      className={cx('app-alert', glass && 'app-alert--glass', className)}
      role={rootRole}
      aria-live={ariaLive ?? (rootRole === 'alert' ? 'assertive' : 'polite')}
    >
      <Icon className="app-alert__icon" size={18} aria-hidden="true" />
      <div className="app-alert__body">
        <div className="app-alert__title">{title}</div>
        {description && <div className="app-alert__description">{description}</div>}
        {action && <div className="app-alert__actions">{action}</div>}
      </div>
      {onClose && (
        <button type="button" className="app-alert__close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
      {hasProgress && (
        <div className="app-alert__progress-track">
          <div
            data-testid={progressTestId}
            className={cx('app-alert__progress', !controlledProgress && 'is-duration', progressClassName)}
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={controlledProgress ? Math.round(progressValue) : undefined}
            aria-valuetext={!controlledProgress && durationMs !== undefined ? `${durationMs / 1000} 秒后自动关闭` : undefined}
            style={progressStyle}
          />
        </div>
      )}
    </div>
  )
})
