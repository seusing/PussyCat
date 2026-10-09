import { sanitizeInspirationLibrary, type InspirationItem, type InspirationLibrary } from './inspirationLibrary'

const BACKUP_VERSION = 1

export type InspirationBackupFile = { fileName: string; content: string }
export type ParsedInspirationBackup = { library: InspirationLibrary; invalid: number }
export type InspirationMergeResult = { library: InspirationLibrary; imported: number; skipped: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function buildInspirationBackup(library: InspirationLibrary, now = new Date()): InspirationBackupFile {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return {
    fileName: `爪爪灵感库-${stamp}.json`,
    content: JSON.stringify({ backupVersion: BACKUP_VERSION, exportedAt: now.toISOString(), library }, null, 2),
  }
}

// 也接受直接是灵感库本体(如从数据目录拷出来的 library.json)的文件。
// invalid:文件里结构不合格、被忽略的条目数。
export function parseInspirationBackup(text: string): ParsedInspirationBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('这不是有效的 JSON 文件')
  }
  if (isRecord(parsed) && 'backupVersion' in parsed && parsed.backupVersion !== BACKUP_VERSION) {
    throw new Error('备份文件的版本不受支持，请使用新版爪爪导入')
  }
  const raw = isRecord(parsed) && 'library' in parsed ? parsed.library : parsed
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.folders) || !Array.isArray(raw.items)) {
    throw new Error('这不是爪爪灵感库的备份文件')
  }
  const library = sanitizeInspirationLibrary(raw)
  return {
    library,
    invalid: raw.folders.length + raw.items.length - library.folders.length - library.items.length,
  }
}

const isWebSource = (source: string | undefined): source is string => !!source && /^https?:\/\//i.test(source)
const sourceKey = (item: InspirationItem, source: string) => `${item.kind}\n${source}`

// 按 id 合并:同 id 一律保留现有的。条目另外按"同类型 + 同网址来源"判重 —— 只比对导入前
// 已有的条目:来源是站点名或任务名的条目(source 不是网址)并不唯一,备份文件内部
// 共用同一网址的条目也都是当初真实保存的,这些都不能当重复丢掉。
export function mergeInspirationLibrary(current: InspirationLibrary, incoming: InspirationLibrary): InspirationMergeResult {
  const folderIds = new Set(current.folders.map((folder) => folder.id))
  const itemIds = new Set(current.items.map((item) => item.id))
  const sources = new Set<string>()
  for (const item of current.items) if (isWebSource(item.source)) sources.add(sourceKey(item, item.source))

  const folders = [...current.folders]
  const items = [...current.items]
  let imported = 0
  let skipped = 0
  for (const folder of incoming.folders) {
    if (folderIds.has(folder.id)) { skipped += 1; continue }
    folderIds.add(folder.id)
    folders.push(folder)
    imported += 1
  }
  for (const item of incoming.items) {
    if (itemIds.has(item.id) || (isWebSource(item.source) && sources.has(sourceKey(item, item.source)))) { skipped += 1; continue }
    itemIds.add(item.id)
    items.push(item)
    imported += 1
  }
  return { library: { ...current, folders, items }, imported, skipped }
}

export function readBackupFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsText(file)
  })
}
