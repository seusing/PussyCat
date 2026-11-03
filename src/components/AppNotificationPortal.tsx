import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NotificationLayerContext } from './notificationContext'

const HOST_SELECTOR = '[data-testid="app-notification-layer"]'

export function AppNotificationPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(() => document.querySelector<HTMLElement>(HOST_SELECTOR))

  useEffect(() => {
    if (!host) setHost(document.querySelector<HTMLElement>(HOST_SELECTOR))
  }, [host])

  return host
    ? createPortal(<NotificationLayerContext.Provider value>{children}</NotificationLayerContext.Provider>, host)
    : children
}
