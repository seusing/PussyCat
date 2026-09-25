export type InspirationItemKind = 'note' | 'video' | 'source'

export type InspirationFolder = {
  id: string
  name: string
  createdAt: number
  parentId: string | null
}

export type InspirationItem = {
  id: string
  title: string
  content: string
  kind: InspirationItemKind
  format: 'md' | 'txt'
  folderId: string | null
  source?: string
  createdAt: number
  updatedAt: number
}

export type InspirationLibrary = {
  version: 1
  folders: InspirationFolder[]
  items: InspirationItem[]
}

export const INSPIRATION_LIBRARY_KEY = 'zhuazhua:inspiration-library:v1'
export const INSPIRATION_LIBRARY_EVENT = 'zhuazhua:inspiration-library-changed'

export function emptyInspirationLibrary(): InspirationLibrary {
  return { version: 1, folders: [], items: [] }
}

function storageOf(storage?: Storage): Storage | undefined {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function id(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`
  } catch {
    // Fall through to the short local id in restricted WebViews.
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function validFolder(value: unknown): value is InspirationFolder {
  const folder = value as InspirationFolder
  return !!folder && typeof folder === 'object'
    && typeof folder.id === 'string' && typeof folder.name === 'string'
    && Number.isFinite(folder.createdAt)
}

function validItem(value: unknown): value is InspirationItem {
  const item = value as InspirationItem
  return !!item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.title === 'string'
    && typeof item.content === 'string'
    && (item.kind === 'note' || item.kind === 'video' || item.kind === 'source')
    && (item.format === 'md' || item.format === 'txt')
    && (item.folderId === null || typeof item.folderId === 'string')
    && (item.source === undefined || typeof item.source === 'string')
    && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt)
}

export function makeUniqueInspirationName(value: string, occupiedNames: Iterable<string>, fallback: string): string {
  const desired = value.trim() || fallback
  const lower = (name: string) => name.toLocaleLowerCase()
  const occupied = new Set(Array.from(occupiedNames, lower))
  if (!occupied.has(lower(desired))) return desired
  const match = desired.match(/^(.*)\((\d+)\)$/)
  const base = (match?.[1] || desired).trim() || fallback
  let n = 1
  while (occupied.has(lower(`${base}(${n})`))) n += 1
  return `${base}(${n})`
}

function normalizeNames(library: InspirationLibrary): { library: InspirationLibrary; changed: boolean } {
  const folders = [...library.folders]
  const items = [...library.items]
  const used = new Map<string, Set<string>>()
  const keyFor = (folderId: string | null) => folderId ?? 'root'
  const usedFor = (folderId: string | null) => {
    const key = keyFor(folderId)
    let set = used.get(key)
    if (!set) { set = new Set(); used.set(key, set) }
    return set
  }
  const unique = (value: string, fallback: string, set: Set<string>) => {
    const result = makeUniqueInspirationName(value, set, fallback)
    set.add(result.toLocaleLowerCase())
    return result
  }
  let changed = false
  const entries = [
    ...folders.map((folder, index) => ({ type: 'folder' as const, value: folder, index })),
    ...items.map((item, index) => ({ type: 'item' as const, value: item, index: folders.length + index })),
  ].sort((a, b) => a.value.createdAt - b.value.createdAt || a.index - b.index)
  const nextFolders = [...folders]
  const nextItems = [...items]
  for (const entry of entries) {
    if (entry.type === 'folder') {
      const name = unique(entry.value.name, '未命名文件夹', usedFor(entry.value.parentId))
      if (name !== entry.value.name) { changed = true; nextFolders[folders.indexOf(entry.value)] = { ...entry.value, name } }
    } else {
      const title = unique(entry.value.title, '未命名灵感', usedFor(entry.value.folderId))
      if (title !== entry.value.title) { changed = true; nextItems[items.indexOf(entry.value)] = { ...entry.value, title } }
    }
  }
  return { library: { ...library, folders: nextFolders, items: nextItems }, changed }
}

export function normalizeInspirationLibrary(library: InspirationLibrary): InspirationLibrary {
  return normalizeNames(library).library
}

function normalize(raw: unknown): InspirationLibrary {
  if (!raw || typeof raw !== 'object') return emptyInspirationLibrary()
  const value = raw as Partial<InspirationLibrary>
  if (value.version !== undefined && value.version !== 1) return emptyInspirationLibrary()
  const rawFolders = Array.isArray(value.folders) ? value.folders.filter(validFolder) : []
  const folderIds = new Set(rawFolders.map((folder) => folder.id))
  const folders = rawFolders.map((folder) => ({
    ...folder,
    parentId: typeof folder.parentId === 'string' && folder.parentId !== folder.id && folderIds.has(folder.parentId)
      ? folder.parentId
      : null,
  }))
  const items = Array.isArray(value.items)
    ? value.items.filter(validItem).map((item) => ({ ...item, folderId: item.folderId && folderIds.has(item.folderId) ? item.folderId : null }))
    : []
  return { version: 1, folders, items }
}

export function loadInspirationLibrary(storage?: Storage): InspirationLibrary {
  const target = storageOf(storage)
  if (!target) return emptyInspirationLibrary()
  try {
    const raw = target.getItem(INSPIRATION_LIBRARY_KEY)
    if (!raw) return emptyInspirationLibrary()
    const parsed = JSON.parse(raw)
    const value = parsed && typeof parsed === 'object' ? parsed as Partial<InspirationLibrary> : null
    const base = value ? normalize({ ...value, folders: Array.isArray(value.folders) ? value.folders : [], items: Array.isArray(value.items) ? value.items : [] }) : emptyInspirationLibrary()
    const normalized = normalizeNames(base)
    if (normalized.changed) {
      try { target.setItem(INSPIRATION_LIBRARY_KEY, JSON.stringify(normalized.library)) } catch { /* keep the in-memory repair */ }
    }
    return normalized.library
  } catch {
    return emptyInspirationLibrary()
  }
}

export function saveInspirationLibrary(library: InspirationLibrary, storage?: Storage): boolean {
  const target = storageOf(storage)
  if (!target) return false
  try {
    const normalized = normalizeNames(normalize(library)).library
    target.setItem(INSPIRATION_LIBRARY_KEY, JSON.stringify(normalized))
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(INSPIRATION_LIBRARY_EVENT))
    return true
  } catch {
    return false
  }
}

export function addInspirationItem(input: Omit<InspirationItem, 'id' | 'createdAt' | 'updatedAt'>, storage?: Storage): InspirationItem | null {
  const library = loadInspirationLibrary(storage)
  const now = Date.now()
  const parentId = input.folderId
  const occupiedNames = [
    ...library.items.filter((entry) => entry.folderId === parentId).map((entry) => entry.title),
    ...library.folders.filter((entry) => entry.parentId === parentId).map((entry) => entry.name),
  ]
  const item: InspirationItem = {
    ...input,
    title: makeUniqueInspirationName(input.title, occupiedNames, '未命名灵感'),
    id: id('inspiration'),
    createdAt: now,
    updatedAt: now,
  }
  const next = normalizeNames({ ...library, items: [...library.items, item] }).library
  const actual = next.items.find((candidate) => candidate.id === item.id) ?? item
  return saveInspirationLibrary(next, storage) ? actual : null
}

export function addInspirationFolder(name: string, storage?: Storage): InspirationFolder | null
export function addInspirationFolder(name: string, parentId: string | null, storage?: Storage): InspirationFolder | null
export function addInspirationFolder(name: string, parentIdOrStorage?: string | null | Storage, storage?: Storage): InspirationFolder | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const targetStorage = parentIdOrStorage && typeof parentIdOrStorage === 'object' ? parentIdOrStorage : storage
  const parentId = typeof parentIdOrStorage === 'string' ? parentIdOrStorage : null
  const library = loadInspirationLibrary(targetStorage)
  const occupiedNames = [
    ...library.folders.filter((item) => item.parentId === parentId).map((item) => item.name),
    ...library.items.filter((item) => item.folderId === parentId).map((item) => item.title),
  ]
  const folder: InspirationFolder = {
    id: id('folder'),
    name: makeUniqueInspirationName(trimmed, occupiedNames, '未命名文件夹'),
    createdAt: Date.now(),
    parentId: parentId && library.folders.some((item) => item.id === parentId) ? parentId : null,
  }
  const next = normalizeNames({ ...library, folders: [...library.folders, folder] }).library
  const actual = next.folders.find((candidate) => candidate.id === folder.id) ?? folder
  return saveInspirationLibrary(next, targetStorage) ? actual : null
}

export function inspirationKindLabel(kind: InspirationItemKind): string {
  return kind === 'video' ? '视频解析' : kind === 'source' ? '灵感来源' : '笔记'
}
