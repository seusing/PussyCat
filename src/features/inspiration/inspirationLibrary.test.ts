import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fakeInspirationPersistence } from '../../testing/inspirationPersistence'
import {
  INSPIRATION_LIBRARY_EVENT,
  INSPIRATION_LIBRARY_KEY,
  INSPIRATION_MIGRATED_KEY,
  addInspirationFolder,
  addInspirationItem,
  connectInspirationLibrary,
  findInspirationItemBySource,
  getInspirationLibraryState,
  inspirationKindLabel,
  loadInspirationLibrary,
  retryInspirationLibraryLoad,
  saveInspirationLibrary,
  type InspirationLibrary,
} from './inspirationLibrary'

function item(title: string, folderId: string | null = null) {
  return {
    title,
    content: '',
    kind: 'note' as const,
    format: 'md' as const,
    folderId,
  }
}

function library(...titles: string[]): InspirationLibrary {
  return {
    version: 1,
    folders: [],
    items: titles.map((title, index) => ({ id: `id-${index}`, ...item(title), createdAt: index + 1, updatedAt: index + 1 })),
  }
}

const titlesOf = (value: InspirationLibrary) => value.items.map((entry) => entry.title)

test('同一目录下文件夹和笔记共用名称空间并按序追加后缀', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1_000)
    addInspirationItem(item('方案'))
    vi.setSystemTime(2_000)
    addInspirationItem(item('方案'))
    vi.setSystemTime(3_000)
    addInspirationItem(item('方案'))
    vi.setSystemTime(4_000)
    const folder = addInspirationFolder('方案')!

    expect(loadInspirationLibrary().items.map((entry) => entry.title).sort()).toEqual(['方案', '方案(1)', '方案(2)'])
    expect(folder.name).toBe('方案(3)')
    expect(new Set([folder.name, ...loadInspirationLibrary().items.map((entry) => entry.title)]).size).toBe(4)
  } finally {
    vi.useRealTimers()
  }
})

test('不同父目录允许使用相同名称', () => {
  const left = addInspirationFolder('左侧')!
  const right = addInspirationFolder('右侧')!
  const first = addInspirationItem(item('笔记', left.id))!
  const second = addInspirationItem(item('笔记', right.id))!

  expect(first.title).toBe('笔记')
  expect(second.title).toBe('笔记')
})

test('保存编辑后的冲突名称时仍保持唯一', () => {
  const first = addInspirationItem(item('已有'))!
  const second = addInspirationItem(item('另一个'))!
  const current = loadInspirationLibrary()
  const next = {
    ...current,
    items: current.items.map((entry) => entry.id === second.id ? { ...entry, title: '已有' } : entry),
  }

  expect(saveInspirationLibrary(next)).toBe(true)
  const saved = loadInspirationLibrary()
  expect(saved.items.find((entry) => entry.id === first.id)?.title).toBe('已有')
  expect(saved.items.find((entry) => entry.id === second.id)?.title).toBe('已有(1)')
})

test('公众号文章条目重新加载后保留，并可按来源查找', () => {
  const saved = addInspirationItem({ ...item('一篇文章'), kind: 'article', source: 'https://mp.weixin.qq.com/s/abc' })!

  const reloaded = loadInspirationLibrary()
  expect(reloaded.items).toHaveLength(1)
  expect(reloaded.items[0].kind).toBe('article')
  expect(inspirationKindLabel('article')).toBe('公众号文章')
  expect(findInspirationItemBySource('https://mp.weixin.qq.com/s/abc')?.id).toBe(saved.id)
  expect(findInspirationItemBySource('https://mp.weixin.qq.com/s/other')).toBeNull()
})

describe('宿主持久化', () => {
  const settle = () => vi.advanceTimersByTimeAsync(0)
  const connect = async (persistence: ReturnType<typeof fakeInspirationPersistence>) => {
    connectInspirationLibrary(persistence)
    await settle()
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('未接宿主时直接可用,只在内存里读写', () => {
    expect(getInspirationLibraryState()).toMatchObject({ phase: 'ready', saveFailed: false })
    expect(addInspirationItem(item('内存笔记'))).not.toBeNull()
    expect(titlesOf(loadInspirationLibrary())).toEqual(['内存笔记'])
    expect(localStorage.getItem(INSPIRATION_LIBRARY_KEY)).toBeNull()
  })

  test('加载完成前处于 loading,拒绝写入;完成后换成宿主的内容并通知', async () => {
    const persistence = fakeInspirationPersistence(library('宿主笔记'))
    const changed = vi.fn()
    window.addEventListener(INSPIRATION_LIBRARY_EVENT, changed)
    try {
      connectInspirationLibrary(persistence)
      expect(getInspirationLibraryState().phase).toBe('loading')
      expect(addInspirationItem(item('抢跑'))).toBeNull()
      expect(addInspirationFolder('抢跑')).toBeNull()
      expect(saveInspirationLibrary(library('抢跑'))).toBe(false)

      await settle()
      expect(getInspirationLibraryState()).toMatchObject({ phase: 'ready', error: '' })
      expect(titlesOf(loadInspirationLibrary())).toEqual(['宿主笔记'])
      expect(changed).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(persistence.save).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(INSPIRATION_LIBRARY_EVENT, changed)
    }
  })

  test('宿主返回的库里有重复名称时,加载后在内存里整理并写回宿主', async () => {
    const persistence = fakeInspirationPersistence({
      version: 1,
      folders: [],
      items: [
        { id: 'old', ...item('想法'), createdAt: 1, updatedAt: 1 },
        { id: 'new', ...item('想法'), createdAt: 2, updatedAt: 2 },
        { id: 'newer', ...item('想法(1)'), createdAt: 3, updatedAt: 3 },
      ],
    })
    await connect(persistence)

    expect(titlesOf(loadInspirationLibrary())).toEqual(['想法', '想法(1)', '想法(2)'])
    await vi.advanceTimersByTimeAsync(500)
    expect(persistence.save).toHaveBeenCalledTimes(1)
    expect(titlesOf(persistence.save.mock.calls[0][0])).toEqual(['想法', '想法(1)', '想法(2)'])
  })

  test('宿主文件的版本不认识时报错,不覆盖原文件', async () => {
    const persistence = fakeInspirationPersistence({ version: 2, folders: [], items: [] })
    await connect(persistence)

    expect(getInspirationLibraryState().phase).toBe('error')
    expect(getInspirationLibraryState().error).toContain('格式不受支持')
    expect(saveInspirationLibrary(library('不该写入'))).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(persistence.save).not.toHaveBeenCalled()
  })

  test('保存后去抖 500ms,连续保存只把最后一份整库写给宿主', async () => {
    const persistence = fakeInspirationPersistence(library('已有'))
    await connect(persistence)

    addInspirationItem(item('第一条'))
    await vi.advanceTimersByTimeAsync(300)
    addInspirationItem(item('第二条'))
    await vi.advanceTimersByTimeAsync(499)
    expect(persistence.save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(persistence.save).toHaveBeenCalledTimes(1)
    expect(titlesOf(persistence.save.mock.calls[0][0])).toEqual(['已有', '第一条', '第二条'])
    expect(getInspirationLibraryState().saveFailed).toBe(false)
  })

  test('写宿主失败时标记 saveFailed,保留内存里的修改并在 10 秒后自动重试', async () => {
    const persistence = fakeInspirationPersistence(library('已有'))
    await connect(persistence)
    persistence.saveError = new Error('disk full')

    addInspirationItem(item('不能丢'))
    await vi.advanceTimersByTimeAsync(500)
    expect(persistence.save).toHaveBeenCalledTimes(1)
    expect(getInspirationLibraryState().saveFailed).toBe(true)
    expect(titlesOf(loadInspirationLibrary())).toEqual(['已有', '不能丢'])

    await vi.advanceTimersByTimeAsync(9_000)
    expect(persistence.save).toHaveBeenCalledTimes(1)
    persistence.saveError = null
    await vi.advanceTimersByTimeAsync(1_000)
    expect(persistence.save).toHaveBeenCalledTimes(2)
    expect(titlesOf(persistence.save.mock.calls[1][0])).toEqual(['已有', '不能丢'])
    expect(getInspirationLibraryState().saveFailed).toBe(false)
  })

  test('失败期间再次保存,不等 10 秒,500ms 后就重试', async () => {
    const persistence = fakeInspirationPersistence(library('已有'))
    await connect(persistence)
    persistence.saveError = new Error('locked')
    addInspirationItem(item('第一条'))
    await vi.advanceTimersByTimeAsync(500)
    expect(getInspirationLibraryState().saveFailed).toBe(true)

    persistence.saveError = null
    addInspirationItem(item('第二条'))
    await vi.advanceTimersByTimeAsync(500)
    expect(persistence.save).toHaveBeenCalledTimes(2)
    expect(titlesOf(persistence.save.mock.calls[1][0])).toEqual(['已有', '第一条', '第二条'])
    expect(getInspirationLibraryState().saveFailed).toBe(false)
  })

  test('上一次写还没返回时的新修改排在后面,不并发写', async () => {
    const persistence = fakeInspirationPersistence(library('已有'))
    await connect(persistence)
    let release: () => void = () => {}
    persistence.save.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))

    addInspirationItem(item('第一条'))
    await vi.advanceTimersByTimeAsync(500)
    addInspirationItem(item('第二条'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(persistence.save).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(persistence.save).toHaveBeenCalledTimes(2)
    expect(titlesOf(persistence.save.mock.calls[1][0])).toEqual(['已有', '第一条', '第二条'])
  })

  test('页面隐藏时立即写出还没到期的修改', async () => {
    const persistence = fakeInspirationPersistence(library('已有'))
    await connect(persistence)

    addInspirationItem(item('刚写的'))
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(persistence.save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(persistence.save).toHaveBeenCalledTimes(1)
  })

  test('读取失败进入 error,重试成功后恢复', async () => {
    const persistence = fakeInspirationPersistence(library('宿主笔记'))
    persistence.loadError = new Error('无法连接爪爪本地服务，请稍后重试')
    await connect(persistence)

    expect(getInspirationLibraryState().phase).toBe('error')
    expect(getInspirationLibraryState().error).toBe('读取灵感库失败：无法连接爪爪本地服务，请稍后重试')
    expect(addInspirationItem(item('出错时写入'))).toBeNull()

    persistence.loadError = null
    retryInspirationLibraryLoad()
    expect(getInspirationLibraryState().phase).toBe('loading')
    await settle()
    expect(getInspirationLibraryState()).toMatchObject({ phase: 'ready', error: '' })
    expect(titlesOf(loadInspirationLibrary())).toEqual(['宿主笔记'])
  })

  describe('从 localStorage 一次性迁移', () => {
    const seedLegacy = () => localStorage.setItem(INSPIRATION_LIBRARY_KEY, JSON.stringify({
      ...library('旧笔记一', '旧笔记二'),
      folders: [{ id: 'folder-old', name: '旧文件夹', createdAt: 1, parentId: null }],
    }))

    test('宿主没有文件而本地有旧库:整份写给宿主,只记迁移标记,旧库原样保留', async () => {
      seedLegacy()
      const before = localStorage.getItem(INSPIRATION_LIBRARY_KEY)
      const persistence = fakeInspirationPersistence()
      await connect(persistence)

      expect(persistence.save).toHaveBeenCalledTimes(1)
      expect(titlesOf(persistence.save.mock.calls[0][0])).toEqual(['旧笔记一', '旧笔记二'])
      expect(persistence.save.mock.calls[0][0].folders.map((entry) => entry.name)).toEqual(['旧文件夹'])
      expect(getInspirationLibraryState().phase).toBe('ready')
      expect(loadInspirationLibrary().items).toHaveLength(2)
      expect(localStorage.getItem(INSPIRATION_MIGRATED_KEY)).toMatch(/^\d+$/)
      expect(localStorage.getItem(INSPIRATION_LIBRARY_KEY)).toBe(before)
    })

    test('宿主已有文件:以宿主为准,不读旧库也不写宿主', async () => {
      seedLegacy()
      const persistence = fakeInspirationPersistence(library('宿主笔记'))
      await connect(persistence)

      expect(titlesOf(loadInspirationLibrary())).toEqual(['宿主笔记'])
      expect(persistence.save).not.toHaveBeenCalled()
      expect(localStorage.getItem(INSPIRATION_MIGRATED_KEY)).toBeNull()
    })

    test('迁移失败:报错、不记标记、不碰旧库;重试成功后才记标记', async () => {
      seedLegacy()
      const before = localStorage.getItem(INSPIRATION_LIBRARY_KEY)
      const persistence = fakeInspirationPersistence()
      persistence.saveError = new Error('HTTP 500')
      await connect(persistence)

      expect(getInspirationLibraryState().phase).toBe('error')
      expect(getInspirationLibraryState().error).toBe('迁移旧版灵感库失败：HTTP 500')
      expect(localStorage.getItem(INSPIRATION_MIGRATED_KEY)).toBeNull()
      expect(localStorage.getItem(INSPIRATION_LIBRARY_KEY)).toBe(before)
      expect(addInspirationItem(item('迁移前写入'))).toBeNull()

      persistence.saveError = null
      retryInspirationLibraryLoad()
      await settle()
      expect(getInspirationLibraryState().phase).toBe('ready')
      expect(persistence.save).toHaveBeenCalledTimes(2)
      expect(loadInspirationLibrary().items).toHaveLength(2)
      expect(localStorage.getItem(INSPIRATION_MIGRATED_KEY)).not.toBeNull()
    })

    test('已迁移过而宿主文件不在了:不再读旧库,从空库开始', async () => {
      seedLegacy()
      localStorage.setItem(INSPIRATION_MIGRATED_KEY, '1')
      const persistence = fakeInspirationPersistence()
      await connect(persistence)

      expect(getInspirationLibraryState().phase).toBe('ready')
      expect(loadInspirationLibrary().items).toEqual([])
      expect(persistence.save).not.toHaveBeenCalled()
    })

    test('旧库是空的或损坏时不迁移', async () => {
      for (const raw of [JSON.stringify(library()), '{broken']) {
        localStorage.setItem(INSPIRATION_LIBRARY_KEY, raw)
        const persistence = fakeInspirationPersistence()
        await connect(persistence)
        expect(getInspirationLibraryState().phase).toBe('ready')
        expect(persistence.save).not.toHaveBeenCalled()
        expect(localStorage.getItem(INSPIRATION_MIGRATED_KEY)).toBeNull()
      }
    })
  })
})
