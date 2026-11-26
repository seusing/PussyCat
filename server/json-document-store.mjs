// 一份 JSON 文档的本机文件存储:整份读写,由渲染进程持有内存副本、去抖后整份 PUT 过来。
// 灵感库(inspiration-store.mjs)和点点对话记录(dot-history-store.mjs)都用它。
//
// 写入走"临时文件 -> fsync -> rename"原子替换,读者永远只会看到完整的旧版或新版。
// 每天第一次写入前,把写入前的文件复制成 <文件名>.bak-YYYYMMDD(本地日期),只保留最近 keepBackups 份。
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
export const BACKUP_KEEP = 7

export class DocumentStoreError extends Error {
  constructor(statusCode, message, reasonCode) {
    super(message)
    this.name = 'DocumentStoreError'
    this.statusCode = statusCode
    this.reasonCode = reasonCode
  }
}

export const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

function localDateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {object} options
 * @param {string} options.dir 文件所在目录
 * @param {string} options.fileName 例如 library.json
 * @param {string} options.label 报错里的名字,例如「灵感库」
 * @param {string} options.reasonPrefix reasonCode 前缀,例如 inspiration → inspiration-invalid / inspiration-corrupt
 * @param {(document: unknown) => string | null} options.problem 结构校验:通过返回 null,否则是第一处问题的描述
 */
export function createJsonDocumentStore({
  dir,
  fileName,
  label,
  reasonPrefix,
  problem,
  maxBytes = DEFAULT_MAX_BYTES,
  keepBackups = BACKUP_KEEP,
  now = () => new Date(),
}) {
  if (!dir) throw new Error(`${reasonPrefix} store dir is required`)
  const file = join(dir, fileName)
  const backupPattern = new RegExp(`^${escapeRegExp(fileName)}\\.bak-(\\d{8})$`)
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
        console.warn(`[opencli-host] ${reasonPrefix} backup failed: ${error?.message ?? error}`)
      }
      return
    }
    const stale = (await readdir(dir))
      .filter((name) => backupPattern.test(name))
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
        if (error?.code === 'ENOENT') return { exists: false, document: null, savedAt: null }
        throw error
      }
      let document
      try {
        document = JSON.parse(text)
      } catch {
        document = null
      }
      // 读不出来就报错,不当作"不存在"返回:前端会拿"不存在"去写入空文档,把这份文件盖掉。
      if (!isRecord(document)) {
        throw new DocumentStoreError(500, `${label}文件无法解析：${file}`, `${reasonPrefix}-corrupt`)
      }
      return { exists: true, document, savedAt: (await stat(file)).mtime.toISOString() }
    },

    async write(document) {
      const issue = problem(document)
      if (issue) throw new DocumentStoreError(400, `${label}结构无效：${issue}`, `${reasonPrefix}-invalid`)

      const run = writeQueue.then(async () => {
        await mkdir(dir, { recursive: true })
        await backupBeforeFirstWriteOfDay()

        const temporary = `${file}.tmp-${process.pid}-${tempCounter += 1}`
        try {
          const handle = await open(temporary, 'w')
          try {
            await handle.writeFile(JSON.stringify(document), 'utf8')
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
