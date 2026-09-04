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
    return raw ? normalize(JSON.parse(raw)) : emptyInspirationLibrary()
  } catch {
    return emptyInspirationLibrary()
  }
}

export function saveInspirationLibrary(library: InspirationLibrary, storage?: Storage): boolean {
  const target = storageOf(storage)
  if (!target) return false
  try {
    target.setItem(INSPIRATION_LIBRARY_KEY, JSON.stringify(normalize(library)))
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(INSPIRATION_LIBRARY_EVENT))
    return true
  } catch {
    return false
  }
}

export function addInspirationItem(input: Omit<InspirationItem, 'id' | 'createdAt' | 'updatedAt'>, storage?: Storage): InspirationItem | null {
  const library = loadInspirationLibrary(storage)
  const now = Date.now()
  const item: InspirationItem = { ...input, id: id('inspiration'), createdAt: now, updatedAt: now }
  return saveInspirationLibrary({ ...library, items: [item, ...library.items] }, storage) ? item : null
}

export function addInspirationFolder(name: string, storage?: Storage): InspirationFolder | null
export function addInspirationFolder(name: string, parentId: string | null, storage?: Storage): InspirationFolder | null
export function addInspirationFolder(name: string, parentIdOrStorage?: string | null | Storage, storage?: Storage): InspirationFolder | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const targetStorage = parentIdOrStorage && typeof parentIdOrStorage === 'object' ? parentIdOrStorage : storage
  const parentId = typeof parentIdOrStorage === 'string' ? parentIdOrStorage : null
  const library = loadInspirationLibrary(targetStorage)
  const folder: InspirationFolder = {
    id: id('folder'),
    name: trimmed,
    createdAt: Date.now(),
    parentId: parentId && library.folders.some((item) => item.id === parentId) ? parentId : null,
  }
  return saveInspirationLibrary({ ...library, folders: [...library.folders, folder] }, targetStorage) ? folder : null
}

export function inspirationKindLabel(kind: InspirationItemKind): string {
  return kind === 'video' ? '视频解析' : kind === 'source' ? '灵感来源' : '笔记'
}
