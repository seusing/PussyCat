// 灵感库的本机文件存储:<dir>/library.json,整份读写(见 json-document-store.mjs),
// 由渲染进程持有内存副本、去抖后整份 PUT 过来(见 src/features/inspiration/inspirationLibrary.ts)。
import { BACKUP_KEEP, DEFAULT_MAX_BYTES, DocumentStoreError, createJsonDocumentStore, isRecord } from './json-document-store.mjs'

export const LIBRARY_FILE_NAME = 'library.json'
export const MAX_LIBRARY_BYTES = DEFAULT_MAX_BYTES
export { BACKUP_KEEP }
export const InspirationStoreError = DocumentStoreError

// 只校验顶层结构和每条记录的核心字段,不枚举 kind/format 之类的取值:这些由渲染进程
// 的 normalize 负责,宿主枚举一份只会在前端新增类型时把整次保存拒掉。
// 返回 null 表示通过,否则是第一处问题的描述。
export function libraryProblem(library) {
  if (!isRecord(library)) return '顶层必须是对象'
  if (library.version !== 1) return 'version 必须是 1'
  if (!Array.isArray(library.folders)) return 'folders 必须是数组'
  if (!Array.isArray(library.items)) return 'items 必须是数组'
  for (const [index, folder] of library.folders.entries()) {
    if (!isRecord(folder) || typeof folder.id !== 'string' || typeof folder.name !== 'string') {
      return `folders[${index}] 缺少字符串字段 id/name`
    }
  }
  for (const [index, item] of library.items.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string'
      || typeof item.title !== 'string' || typeof item.content !== 'string') {
      return `items[${index}] 缺少字符串字段 id/title/content`
    }
  }
  return null
}

export function createInspirationStore(options = {}) {
  const store = createJsonDocumentStore({
    ...options,
    fileName: LIBRARY_FILE_NAME,
    label: '灵感库',
    reasonPrefix: 'inspiration',
    problem: libraryProblem,
  })
  return {
    maxBytes: store.maxBytes,
    file: store.file,
    async read() {
      const { document, ...rest } = await store.read()
      return { ...rest, library: document }
    },
    write: (library) => store.write(library),
  }
}
