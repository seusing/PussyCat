import { createContext } from 'react'

/** 通知是否渲染在悬浮层里(由 AppNotificationPortal 提供):只有悬浮层里的通知才用液态玻璃。 */
export const NotificationLayerContext = createContext(false)

/** 堆叠里的每张卡片:被后面一层盖住(收起且不是最前面那张)的卡不接玻璃。 */
export const NotificationStackCardContext = createContext<{ covered: boolean } | null>(null)
