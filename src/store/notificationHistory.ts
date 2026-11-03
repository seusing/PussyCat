// 通知历史:只记任务状态这类事后值得回看的通知(哪些进历史由调用方用 history 标记决定)。
// 最新在前、同一 id 只记一次、最多 50 条,存在本机,重启后还在。
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

export type NotificationTone = 'info' | 'success' | 'danger' | 'warning' | 'rerun'

export type NotificationEntry = {
  id: string
  message: string
  description?: string
  tone: NotificationTone
  createdAt: number
  read: boolean
}

export type NotificationInput = Omit<NotificationEntry, 'read'>

export const NOTIFICATION_HISTORY_KEY = 'opencli-app:notification-history:v1'
export const NOTIFICATION_HISTORY_LIMIT = 50

const TONES: readonly string[] = ['info', 'success', 'danger', 'warning', 'rerun']

type NotificationHistoryState = {
  entries: NotificationEntry[]
  /** 记下新通知;已有的 id(含同一批里重复的)跳过,全是旧的就什么都不写。 */
  record: (items: readonly NotificationInput[]) => void
  markAllRead: () => void
  clear: () => void
}

// 每次调用时才取 localStorage,并吞掉一切异常:浏览器封锁存储时访问属性本身就会抛,
// 读不出来或写不进去时历史只留在内存里(做法同 data/layout.ts 的 resolveStorage)。
function currentStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined
  } catch {
    return undefined
  }
}

const safeStorage: StateStorage = {
  getItem: (name) => {
    try { return currentStorage()?.getItem(name) ?? null } catch { return null }
  },
  setItem: (name, value) => {
    try { currentStorage()?.setItem(name, value) } catch { /* 写不进去(配额、被封锁):只留在内存里 */ }
  },
  removeItem: (name) => {
    try { currentStorage()?.removeItem(name) } catch { /* 同上 */ }
  },
}

function asEntry(raw: unknown): NotificationEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.message !== 'string') return null
  if (typeof item.tone !== 'string' || !TONES.includes(item.tone)) return null
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null
  if (typeof item.read !== 'boolean') return null
  return {
    id: item.id,
    message: item.message,
    ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
    tone: item.tone as NotificationTone,
    createdAt: item.createdAt,
    read: item.read,
  }
}

/** 从存储里读回来的原始值:丢弃坏条目和重复 id,保持原有顺序,截到上限。 */
function restoreEntries(raw: unknown): NotificationEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const entries: NotificationEntry[] = []
  for (const item of raw) {
    const entry = asEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
    if (entries.length >= NOTIFICATION_HISTORY_LIMIT) break
  }
  return entries
}

export const useNotificationHistory = create<NotificationHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      // persist 会在每次 set 之后写一遍存储,所以没有变化时要在调用 set 之前就返回。
      record: (items) => {
        const known = new Set(get().entries.map((entry) => entry.id))
        const added: NotificationEntry[] = []
        for (const item of items) {
          if (known.has(item.id)) continue
          known.add(item.id)
          added.push({
            id: item.id,
            message: item.message,
            ...(item.description ? { description: item.description } : {}),
            tone: item.tone,
            createdAt: item.createdAt,
            read: false,
          })
        }
        if (added.length === 0) return
        set({ entries: [...added, ...get().entries].slice(0, NOTIFICATION_HISTORY_LIMIT) })
      },
      markAllRead: () => {
        const { entries } = get()
        if (entries.every((entry) => entry.read)) return
        set({ entries: entries.map((entry) => (entry.read ? entry : { ...entry, read: true })) })
      },
      clear: () => {
        if (get().entries.length === 0) return
        set({ entries: [] })
      },
    }),
    {
      name: NOTIFICATION_HISTORY_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ entries: state.entries }),
      merge: (persisted, current) => ({
        ...current,
        entries: restoreEntries((persisted as { entries?: unknown } | undefined)?.entries),
      }),
    },
  ),
)

export const selectUnreadCount = (state: Pick<NotificationHistoryState, 'entries'>): number =>
  state.entries.reduce((count, entry) => count + (entry.read ? 0 : 1), 0)

/** 供非 React 代码(如 VkPanel 的事件回调)直接记通知。 */
export const recordNotifications = (items: readonly NotificationInput[]) => useNotificationHistory.getState().record(items)

/** 测试用:回到空历史。 */
export function resetNotificationHistoryForTests() {
  useNotificationHistory.setState({ entries: [] })
}
