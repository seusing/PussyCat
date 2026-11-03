import {
  NOTIFICATION_HISTORY_KEY, NOTIFICATION_HISTORY_LIMIT, recordNotifications, resetNotificationHistoryForTests,
  selectUnreadCount, useNotificationHistory, type NotificationInput,
} from './notificationHistory'

// restart() 会让 vitest 换一份新的模块实例,setup 里的重置够不到本文件静态引入的这一份,所以这里自己重置。
beforeEach(() => resetNotificationHistoryForTests())

const item = (id: string, over: Partial<NotificationInput> = {}): NotificationInput => ({
  id, message: `消息 ${id}`, tone: 'info', createdAt: 1_000, ...over,
})
const entries = () => useNotificationHistory.getState().entries
const stored = () => JSON.parse(localStorage.getItem(NOTIFICATION_HISTORY_KEY) ?? 'null') as { state: { entries: unknown[] }; version: number } | null

describe('record', () => {
  it('puts new entries first, unread, keeping the order of the batch', () => {
    recordNotifications([item('a')])
    recordNotifications([item('b'), item('c', { description: '原因', tone: 'danger' })])

    expect(entries().map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(entries()[1]).toEqual({ id: 'c', message: '消息 c', description: '原因', tone: 'danger', createdAt: 1_000, read: false })
    expect(entries()[2]).not.toHaveProperty('description')
  })

  it('records an id once, including ids repeated inside one batch', () => {
    recordNotifications([item('a'), item('a', { message: '换了文字' }), item('b')])
    recordNotifications([item('b'), item('a')])

    expect(entries().map((entry) => [entry.id, entry.message])).toEqual([['a', '消息 a'], ['b', '消息 b']])
  })

  it('neither writes the storage nor notifies subscribers when nothing is new', () => {
    recordNotifications([item('a')])
    const listener = vi.fn()
    const unsubscribe = useNotificationHistory.subscribe(listener)
    const setItem = vi.spyOn(localStorage, 'setItem')
    const before = entries()

    recordNotifications([item('a')])
    recordNotifications([])

    expect(entries()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    unsubscribe()
    setItem.mockRestore()
  })

  it(`keeps only the latest ${NOTIFICATION_HISTORY_LIMIT} entries`, () => {
    recordNotifications(Array.from({ length: 40 }, (_, index) => item(`old-${index}`)))
    recordNotifications(Array.from({ length: 30 }, (_, index) => item(`new-${index}`)))

    expect(entries()).toHaveLength(NOTIFICATION_HISTORY_LIMIT)
    expect(entries()[0].id).toBe('new-0')
    expect(entries().at(-1)?.id).toBe('old-19')
    expect(entries().some((entry) => entry.id === 'old-20')).toBe(false)
  })

  it('cuts a single oversized batch to the limit as well', () => {
    recordNotifications(Array.from({ length: 70 }, (_, index) => item(`n-${index}`)))

    expect(entries()).toHaveLength(NOTIFICATION_HISTORY_LIMIT)
    expect(entries()[0].id).toBe('n-0')
  })
})

describe('未读、已读与清空', () => {
  it('counts unread entries and markAllRead clears the count without touching anything else', () => {
    recordNotifications([item('a'), item('b')])
    expect(selectUnreadCount(useNotificationHistory.getState())).toBe(2)

    useNotificationHistory.getState().markAllRead()
    expect(selectUnreadCount(useNotificationHistory.getState())).toBe(0)
    expect(entries().map((entry) => entry.id)).toEqual(['a', 'b'])

    recordNotifications([item('c')])
    expect(selectUnreadCount(useNotificationHistory.getState())).toBe(1)
    expect(entries().map((entry) => entry.read)).toEqual([false, true, true])
  })

  it('markAllRead and clear write nothing when there is nothing to change', () => {
    const listener = vi.fn()
    const unsubscribe = useNotificationHistory.subscribe(listener)
    const setItem = vi.spyOn(localStorage, 'setItem')

    useNotificationHistory.getState().markAllRead()
    useNotificationHistory.getState().clear()
    recordNotifications([item('a')])
    setItem.mockClear()
    listener.mockClear()
    useNotificationHistory.getState().markAllRead()
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()
    useNotificationHistory.getState().markAllRead()
    expect(listener).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledTimes(1)
    unsubscribe()
    setItem.mockRestore()
  })

  it('clear empties the history and an id may be recorded again afterwards', () => {
    recordNotifications([item('a')])
    useNotificationHistory.getState().clear()
    expect(entries()).toEqual([])

    recordNotifications([item('a')])
    expect(entries().map((entry) => entry.id)).toEqual(['a'])
  })
})

// 重启:清掉模块缓存后重新加载,store 在创建时从存储里读回历史。
async function restart() {
  vi.resetModules()
  return import('./notificationHistory')
}
const good = (id: string, over: Record<string, unknown> = {}) => ({ id, message: `消息 ${id}`, tone: 'success', createdAt: 5, read: false, ...over })
const save = (state: unknown, version = 1) => localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify({ state, version }))

describe('持久化', () => {
  it('stores the entries only, under the versioned key', () => {
    recordNotifications([item('a')])

    const saved = stored()
    expect(saved?.version).toBe(1)
    expect(Object.keys(saved!.state)).toEqual(['entries'])
    expect(saved?.state.entries).toEqual([{ id: 'a', message: '消息 a', tone: 'info', createdAt: 1_000, read: false }])
  })

  it('comes back after a restart with the read flags, and the unread count follows', async () => {
    recordNotifications([item('a'), item('b')])
    useNotificationHistory.getState().markAllRead()
    recordNotifications([item('c', { description: '原因' })])

    const reloaded = await restart()

    expect(reloaded.useNotificationHistory.getState().entries.map((entry) => [entry.id, entry.read])).toEqual([['c', false], ['a', true], ['b', true]])
    expect(reloaded.useNotificationHistory.getState().entries[0].description).toBe('原因')
    expect(reloaded.selectUnreadCount(reloaded.useNotificationHistory.getState())).toBe(1)
    // 重启后同一个 id 不会再记一遍
    reloaded.recordNotifications([item('a')])
    expect(reloaded.useNotificationHistory.getState().entries).toHaveLength(3)
  })

  it('drops bad entries and duplicate ids, keeps the order and cuts to the limit', async () => {
    save({
      entries: [
        good('a'),
        null,
        'text',
        good('no-message', { message: 3 }),
        good('bad-tone', { tone: 'loud' }),
        good('bad-time', { createdAt: 'yesterday' }),
        good('bad-read', { read: 'no' }),
        good('', { id: '' }),
        good('a'),
        good('b', { description: '原因', extra: 'ignored' }),
        ...Array.from({ length: 60 }, (_, index) => good(`bulk-${index}`)),
      ],
    })

    const reloaded = await restart()
    const restored = reloaded.useNotificationHistory.getState().entries

    expect(restored).toHaveLength(NOTIFICATION_HISTORY_LIMIT)
    expect(restored.slice(0, 2)).toEqual([
      { id: 'a', message: '消息 a', tone: 'success', createdAt: 5, read: false },
      { id: 'b', message: '消息 b', description: '原因', tone: 'success', createdAt: 5, read: false },
    ])
    expect(restored[2].id).toBe('bulk-0')
  })

  it.each([
    ['not JSON', () => localStorage.setItem(NOTIFICATION_HISTORY_KEY, '{oops')],
    ['not an object', () => localStorage.setItem(NOTIFICATION_HISTORY_KEY, '"entries"')],
    ['no state', () => localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify({ version: 1 }))],
    ['entries is not an array', () => save({ entries: 'x' })],
    ['another version', () => save({ entries: [good('a')] }, 99)],
  ])('treats %s as an empty history', async (_name, seed) => {
    seed()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const reloaded = await restart()

    expect(reloaded.useNotificationHistory.getState().entries).toEqual([])
    error.mockRestore()
  })

  it('keeps working in memory when the storage throws on every call', async () => {
    const broken = {
      get length() { return 0 },
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('quota') },
      removeItem() { throw new Error('denied') },
      clear() {},
      key: () => null,
    }
    vi.stubGlobal('localStorage', broken)

    expect(() => recordNotifications([item('a')])).not.toThrow()
    expect(entries().map((entry) => entry.id)).toEqual(['a'])
    await expect(useNotificationHistory.persist.rehydrate()).resolves.not.toThrow()
    expect(() => useNotificationHistory.getState().clear()).not.toThrow()
  })

  it('keeps working when reading the localStorage property itself throws', async () => {
    vi.stubGlobal('localStorage', undefined)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError') } })

    expect(() => recordNotifications([item('a')])).not.toThrow()
    await expect(useNotificationHistory.persist.rehydrate()).resolves.not.toThrow()
    expect(entries()).toEqual([])
  })

  it('resetNotificationHistoryForTests empties the history', () => {
    recordNotifications([item('a')])
    resetNotificationHistoryForTests()
    expect(entries()).toEqual([])
  })
})
