// 生效的 OpenCLI:内置那份(随宿主打包,版本钉死)或用户在应用内更新装下的那份。
//
// 数据目录 <dataRoot>/opencli/:
//   versions/<版本>/node_modules/@jackwener/opencli/…   已装好的版本
//   active.json                                          {version, entry, installedAt},指向生效的那份
//   staging/                                             下载和安装的临时区
// active.json 缺失、损坏或指向的入口不存在时一律退回内置版本,更新永远不会把宿主带到起不来的状态。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripBom } from '../src/shared/normalize.mjs'

const ENTRY_PATTERN = /[\\/]dist[\\/]src[\\/]main\.js$/i

/** 某个版本装好之后的入口路径。 */
export function versionEntry(root, version) {
  return join(root, 'versions', version, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
}

function packageVersion(entry) {
  try {
    const packageRoot = join(dirname(entry), '..', '..')
    const version = JSON.parse(stripBom(readFileSync(join(packageRoot, 'package.json'), 'utf8'))).version
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function createOpencliRuntime({ bundledEntry, dataRoot }) {
  if (!bundledEntry) throw new Error('bundledEntry is required')
  if (!dataRoot) throw new Error('dataRoot is required')
  const root = join(dataRoot, 'opencli')
  const activeFile = join(root, 'active.json')
  let bundledVersionMemo

  // 每次现读:文件只有几十字节,且 activate 用 rename 原子替换,读到的不会是半截。
  const readActive = () => {
    try {
      const { version, entry } = JSON.parse(stripBom(readFileSync(activeFile, 'utf8')))
      if (typeof version !== 'string' || typeof entry !== 'string') return undefined
      if (!ENTRY_PATTERN.test(entry) || !existsSync(entry)) return undefined
      return { version, entry }
    } catch {
      return undefined
    }
  }

  return {
    root,
    /** 生效版本的入口;没有有效的更新版本就是内置入口。 */
    entry: () => readActive()?.entry ?? bundledEntry,
    /** 生效版本号。 */
    version: () => readActive()?.version ?? (bundledVersionMemo ??= packageVersion(bundledEntry)),
    bundledVersion: () => (bundledVersionMemo ??= packageVersion(bundledEntry)),
    /** 更新装下的版本;没有(正在用内置版本)时是 null。 */
    active: () => readActive() ?? null,
    activate(version, entry) {
      if (!ENTRY_PATTERN.test(entry)) throw new Error(`Unexpected OpenCLI entry: ${entry}`)
      mkdirSync(root, { recursive: true })
      const temp = `${activeFile}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version, entry, installedAt: Date.now() }, null, 2)}\n`)
      renameSync(temp, activeFile)
    },
    /** 退回内置版本。 */
    rollback() {
      rmSync(activeFile, { force: true })
    },
  }
}
