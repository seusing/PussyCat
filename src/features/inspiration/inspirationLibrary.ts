export type InspirationItemKind = 'note' | 'video' | 'source' | 'article'

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

// 旧版把整份库存在 localStorage 的这个 key 下;现在只在一次性迁移时读它,从不改写。
export const INSPIRATION_LIBRARY_KEY = 'zhuazhua:inspiration-library:v1'
export const INSPIRATION_MIGRATED_KEY = 'zhuazhua:inspiration-library:migrated-at'
export const INSPIRATION_LIBRARY_EVENT = 'zhuazhua:inspiration-library-changed'

const SAVE_DEBOUNCE_MS = 500
const SAVE_RETRY_MS = 10_000

export function emptyInspirationLibrary(): InspirationLibrary {
  return { version: 1, folders: [], items: [] }
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
    && (item.kind === 'note' || item.kind === 'video' || item.kind === 'source' || item.kind === 'article')
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

// 把任意输入收敛成合法的库:丢弃结构不合格的条目,修复指向不存在文件夹的引用。
export function sanitizeInspirationLibrary(raw: unknown): InspirationLibrary {
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

// ---- 内存副本与宿主持久化 ----
//
// 库的权威存储是宿主上的文件(server/inspiration-store.mjs)。这里持有一份模块级内存副本,
// 下面的同步接口读写它;每次保存后去抖 SAVE_DEBOUNCE_MS,再把整份 PUT 给宿主。
// 未调用 connectInspirationLibrary 时(演示模式、单元测试)只在内存里工作。

export type InspirationPersistence = {
  load: () => Promise<{ exists: boolean; library: unknown }>
  save: (library: InspirationLibrary) => Promise<void>
}

export type InspirationLibraryState = {
  phase: 'loading' | 'ready' | 'error'
  error: string
  // 最近一次写宿主失败,内存里的修改还没落盘;会自动重试。
  saveFailed: boolean
}

const READY: InspirationLibraryState = { phase: 'ready', error: '', saveFailed: false }

let memory = emptyInspirationLibrary()
let state: InspirationLibraryState = READY
let persistence: InspirationPersistence | null = null
let epoch = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false
let dirty = false
let pagehideBound = false
const stateListeners = new Set<() => void>()

function setState(patch: Partial<InspirationLibraryState>) {
  const next = { ...state, ...patch }
  if (next.phase === state.phase && next.error === state.error && next.saveFailed === state.saveFailed) return
  state = next
  stateListeners.forEach((listener) => listener())
}

function notifyLibraryChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(INSPIRATION_LIBRARY_EVENT))
}

function schedulePersist(delay: number) {
  if (!persistence) return
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushPersist() }, delay)
}

async function flushPersist() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (!persistence || saving || !dirty) return
  const target = persistence
  const current = epoch
  saving = true
  dirty = false
  let failed = false
  try {
    await target.save(memory)
  } catch {
    failed = true
    dirty = true
  }
  if (current !== epoch) return
  saving = false
  setState({ saveFailed: failed })
  // 写的过程中又有新修改,或写失败了:排下一次。已经有新的定时器就不动它。
  if (dirty && saveTimer === undefined) schedulePersist(failed ? SAVE_RETRY_MS : 0)
}

// 一次性迁移:旧库只读不改;迁移成功后记一个标记,此后以宿主为准。
function readLegacyLibrary(): InspirationLibrary | null {
  try {
    if (typeof localStorage === 'undefined') return null
    if (localStorage.getItem(INSPIRATION_MIGRATED_KEY)) return null
    const raw = localStorage.getItem(INSPIRATION_LIBRARY_KEY)
    if (!raw) return null
    const library = normalizeNames(sanitizeInspirationLibrary(JSON.parse(raw))).library
    return library.items.length + library.folders.length > 0 ? library : null
  } catch {
    return null
  }
}

function markLegacyMigrated() {
  try {
    localStorage.setItem(INSPIRATION_MIGRATED_KEY, String(Date.now()))
  } catch {
    // 标记丢了也无妨:宿主已有文件,下次启动以宿主为准。
  }
}

async function loadFromHost() {
  const source = persistence
  if (!source) return
  const current = epoch
  setState({ phase: 'loading', error: '' })
  let step = '读取灵感库失败'
  try {
    const remote = await source.load()
    let next: InspirationLibrary
    let repaired = false
    if (remote.exists) {
      const raw = remote.library as { version?: unknown } | null
      if (!raw || typeof raw !== 'object' || (raw.version !== undefined && raw.version !== 1)) {
        throw new Error('灵感库文件的格式不受支持，已保留原文件')
      }
      const normalized = normalizeNames(sanitizeInspirationLibrary(raw))
      next = normalized.library
      repaired = normalized.changed
    } else {
      const legacy = readLegacyLibrary()
      if (legacy) {
        step = '迁移旧版灵感库失败'
        await source.save(legacy)
        markLegacyMigrated()
      }
      next = legacy ?? emptyInspirationLibrary()
    }
    if (current !== epoch) return
    memory = next
    setState({ phase: 'ready', error: '' })
    notifyLibraryChanged()
    if (repaired) schedulePersist(SAVE_DEBOUNCE_MS)
  } catch (error) {
    if (current !== epoch) return
    setState({ phase: 'error', error: `${step}：${error instanceof Error ? error.message : String(error)}` })
  }
}

// 应用启动时调用:接上宿主并加载。加载完成前库处于 loading,所有写入都会被拒绝,
// 避免用空库覆盖宿主上的文件。
export function connectInspirationLibrary(next: InspirationPersistence): void {
  persistence = next
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true
    window.addEventListener('pagehide', () => { void flushPersist() })
  }
  void loadFromHost()
}

export function retryInspirationLibraryLoad(): void {
  if (state.phase === 'error') void loadFromHost()
}

export function getInspirationLibraryState(): InspirationLibraryState {
  return state
}

export function subscribeInspirationLibraryState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}

export function resetInspirationLibraryForTests(): void {
  epoch += 1
  clearTimeout(saveTimer)
  saveTimer = undefined
  saving = false
  dirty = false
  persistence = null
  memory = emptyInspirationLibrary()
  state = READY
}

// 返回当前内存副本,调用方只读;任何修改都要经 saveInspirationLibrary 提交。
export function loadInspirationLibrary(): InspirationLibrary {
  return memory
}

// 提交整份库。尚未读取完成(或读取失败)时拒绝并返回 false。
export function saveInspirationLibrary(library: InspirationLibrary): boolean {
  if (state.phase !== 'ready') return false
  memory = normalizeNames(sanitizeInspirationLibrary(library)).library
  notifyLibraryChanged()
  schedulePersist(SAVE_DEBOUNCE_MS)
  return true
}

export function addInspirationItem(input: Omit<InspirationItem, 'id' | 'createdAt' | 'updatedAt'>): InspirationItem | null {
  const library = loadInspirationLibrary()
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
  return saveInspirationLibrary(next) ? actual : null
}

export function addInspirationFolder(name: string, parentId: string | null = null): InspirationFolder | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const library = loadInspirationLibrary()
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
  return saveInspirationLibrary(next) ? actual : null
}

export function findInspirationItemBySource(source: string): InspirationItem | null {
  return loadInspirationLibrary().items.find((item) => item.source === source) ?? null
}

export function inspirationKindLabel(kind: InspirationItemKind): string {
  return kind === 'video' ? '视频解析' : kind === 'source' ? '灵感来源' : kind === 'article' ? '公众号文章' : '笔记'
}
