// 灵感库的本机文件存储。数据文件是 <dir>/library.json,整份读写,由渲染进程持有内存副本、
// 去抖后整份 PUT 过来(见 src/features/inspiration/inspirationLibrary.ts)。
//
// 写入走"临时文件 -> fsync -> rename"原子替换,读者永远只会看到完整的旧版或新版。
// 每天第一次写入前,把写入前的 library.json 复制成 library.json.bak-YYYYMMDD(本地日期),
// 只保留最近 BACKUP_KEEP 份。
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const LIBRARY_FILE_NAME = 'library.json'
export const MAX_LIBRARY_BYTES = 50 * 1024 * 1024
export const BACKUP_KEEP = 7

const BACKUP_PATTERN = /^library\.json\.bak-(\d{8})$/

export class InspirationStoreError extends Error {
  constructor(statusCode, message, reasonCode) {
    super(message)
    this.name = 'InspirationStoreError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
  }
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

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

function localDateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

export function createInspirationStore({
  dir,
  maxBytes = MAX_LIBRARY_BYTES,
  keepBackups = BACKUP_KEEP,
  now = () => new Date(),
} = {}) {
  if (!dir) throw new Error('inspiration store dir is required')
  const file = join(dir, LIBRARY_FILE_NAME)
  let tempCounter = 0
  // Windows 上两个 rename 同时替换同一个目标会 EPERM,写入必须排队。
  let writeQueue = Promise.resolve()

  async function backupBeforeFirstWriteOfDay() {
    const backup = `${file}.bak-${localDateStamp(now())}`
    try {
      // EXCL:今天的备份已存在就不再覆盖;源文件不存在(首次写入)则无需备份。
      await copyFile(file, backup, fsConstants.COPYFILE_EXCL)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') {
        console.warn(`[opencli-host] inspiration backup failed: ${error?.message ?? error}`)
      }
      return
    }
    const stale = (await readdir(dir))
      .filter((name) => BACKUP_PATTERN.test(name))
      .sort()
      .slice(0, -keepBackups)
    await Promise.all(stale.map((name) => unlink(join(dir, name)).catch(() => {})))
  }

  return {
    maxBytes,
    file,

    async read() {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, library: null, savedAt: null }
        throw error
      }
      let library
      try {
        library = JSON.parse(text)
      } catch {
        library = null
      }
      // 读不出来就报错,不当作"不存在"返回:前端会拿"不存在"去迁移旧数据或写入空库,把这份文件盖掉。
      if (!isRecord(library)) {
        throw new InspirationStoreError(500, `灵感库文件无法解析：${file}`, 'inspiration-corrupt')
      }
      return { exists: true, library, savedAt: (await stat(file)).mtime.toISOString() }
    },

    async write(library) {
      const problem = libraryProblem(library)
      if (problem) throw new InspirationStoreError(400, `灵感库结构无效：${problem}`, 'inspiration-invalid')

      const run = writeQueue.then(async () => {
        await mkdir(dir, { recursive: true })
        await backupBeforeFirstWriteOfDay()

        const temporary = `${file}.tmp-${process.pid}-${tempCounter += 1}`
        try {
          const handle = await open(temporary, 'w')
          try {
            await handle.writeFile(JSON.stringify(library), 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, file)
        } catch (error) {
          await unlink(temporary).catch(() => {})
          throw error
        }
        return { savedAt: now().toISOString() }
      })
      writeQueue = run.catch(() => {})
      return run
    },
  }
}
