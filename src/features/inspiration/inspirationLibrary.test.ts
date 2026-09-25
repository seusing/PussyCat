import {
  INSPIRATION_LIBRARY_KEY,
  addInspirationFolder,
  addInspirationItem,
  loadInspirationLibrary,
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

beforeEach(() => {
  localStorage.clear()
})

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

test('加载旧数据时整理已有重复名称并回写存储', () => {
  const library: InspirationLibrary = {
    version: 1,
    folders: [],
    items: [
      { id: 'old', ...item('想法'), createdAt: 1, updatedAt: 1 },
      { id: 'new', ...item('想法'), createdAt: 2, updatedAt: 2 },
      { id: 'newer', ...item('想法(1)'), createdAt: 3, updatedAt: 3 },
    ],
  }
  localStorage.setItem(INSPIRATION_LIBRARY_KEY, JSON.stringify(library))

  const normalized = loadInspirationLibrary()
  expect(normalized.items.map((entry) => entry.title)).toEqual(['想法', '想法(1)', '想法(2)'])
  expect(JSON.parse(localStorage.getItem(INSPIRATION_LIBRARY_KEY) ?? '{}').items).toEqual(normalized.items)
})

test('保存编辑后的冲突名称时仍保持唯一', () => {
  const first = addInspirationItem(item('已有'))!
  const second = addInspirationItem(item('另一个'))!
  const library = loadInspirationLibrary()
  const next = {
    ...library,
    items: library.items.map((entry) => entry.id === second.id ? { ...entry, title: '已有' } : entry),
  }

  expect(saveInspirationLibrary(next)).toBe(true)
  const saved = loadInspirationLibrary()
  expect(saved.items.find((entry) => entry.id === first.id)?.title).toBe('已有')
  expect(saved.items.find((entry) => entry.id === second.id)?.title).toBe('已有(1)')
})
