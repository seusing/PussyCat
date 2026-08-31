// video-knowledge runtime 的唯一 active/receipt 解析器。
// owned runtime 只信 HOME/runtime/versions 内的 receipt；external runtime 必须显式标记，
// 且 receipt 仍由爪爪保存在 HOME/runtime/receipts，绝不写外部环境。
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, promises as fsPromises, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  RUNTIME_RECEIPT_SCHEMA,
  receiptMatchesCurrentBundle,
} from './vk-runtime-contract.mjs'

export const RECEIPT_FILE = 'runtime-receipt.json'
const LEGACY_RECEIPT_SCHEMA = 'vk-runtime-receipt@1'
const RECEIPT_SCHEMAS = new Set([LEGACY_RECEIPT_SCHEMA, RUNTIME_RECEIPT_SCHEMA])
const ACTIVE_SCHEMA = 'vk-runtime-active@2'

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function canonical(path) {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function isWithin(root, path) {
  const rel = relative(canonical(root), canonical(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function manifestOf(bundleDir) {
  if (!bundleDir) return null
  return readJson(join(bundleDir, 'runtime-manifest.json'))
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function compatibleVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?/.exec(String(value ?? ''))
  return !!match && Number(match[1]) === 1 && Number(match[2]) >= 1
}

function ownedVersionDir(home, pythonPath) {
  if (!isAbsolute(pythonPath)) return null
  const versions = join(resolve(home), 'runtime', 'versions')
  const versionDir = dirname(dirname(resolve(pythonPath)))
  if (!isWithin(versions, versionDir)) return null
  const rel = relative(versions, versionDir)
  if (!rel || rel.startsWith('..') || rel.split(/[\\/]/).length !== 1) return null
  return versionDir
}

// —— 拆层布局(runtimeLayout: 'split')——
//
// 自包含布局把 2.4 GB 依赖和 493 KB 应用码绑成一个不可变单元:应用码一变就得重建整个
// 目录(硬链接克隆 41,646 个文件、实测 22~60 秒)。两者变化频率差几个数量级,绑在一起
// 是设计上的错配。
//
// 拆开之后:
//   runtime/bases/<环境指纹>/     venv,只有第三方依赖,不含我们的包;按环境指纹共享
//   runtime/versions/<版本标签>/  receipt + inventory + app/(2 MB 的应用层)
//   active.json                   仍然指向一个版本标签,末尾一次原子切换,回滚不变
//
// 解释器用底座的,应用层经 PYTHONPATH 前置。自包含布局的 receipt 一个字段都不用改,
// 两种形态并存 —— 老 runtime 不作废是硬要求,它们可能是用户唯一能跑的那一个。
const SPLIT_LAYOUT = 'split'
const APP_DIR_NAME = 'app'

/** 版本目录只认单段标签,与 ownedVersionDir 同样严:不许分隔符、不许 `.`/`..`。 */
function versionDirForLabel(home, label) {
  if (typeof label !== 'string' || !label || label === '.' || label === '..') return null
  if (/[\\/]/.test(label)) return null
  const versions = join(resolve(home), 'runtime', 'versions')
  const dir = join(versions, label)
  return isWithin(versions, dir) ? dir : null
}

/** 底座目录同样只认 runtime/bases 下的单段名。 */
function baseDirFor(home, basePath) {
  if (typeof basePath !== 'string' || !isAbsolute(basePath)) return null
  const bases = join(resolve(home), 'runtime', 'bases')
  const dir = resolve(basePath)
  if (!isWithin(bases, dir)) return null
  const rel = relative(bases, dir)
  if (!rel || rel.startsWith('..') || rel.split(/[\\/]/).length !== 1) return null
  return dir
}

function isSplitReceipt(receipt) {
  return receipt?.runtimeLayout === SPLIT_LAYOUT
}

/** receipt 对应的版本目录 —— 拆层时由标签推导,自包含时仍由 pythonPath 推导。 */
function ownedVersionDirFor(home, receipt) {
  return isSplitReceipt(receipt)
    ? versionDirForLabel(home, receipt.version)
    : ownedVersionDir(home, receipt.pythonPath)
}

function directorySizeBytes(path) {
  let total = 0
  let entries
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += directorySizeBytes(child)
    else if (entry.isFile()) {
      try { total += statSync(child).size } catch { /* file changed during inspection */ }
    }
  }
  return total
}

// Runtime version listings are requested while the app is still polling
// /health.  Legacy receipts have no recorded size, so scan them with the
// promise-based fs API to yield between directories instead of monopolizing
// the Node event loop on multi-gigabyte environments.
async function directorySizeBytesAsync(path) {
  let entries
  try { entries = await fsPromises.readdir(path, { withFileTypes: true }) } catch { return 0 }
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directorySizeBytesAsync(child)
    else if (entry.isFile()) {
      try { total += (await fsPromises.stat(child)).size } catch { /* file changed during inspection */ }
    }
  }
  return total
}

function externalReceiptPath(home, pythonPath) {
  const id = createHash('sha256').update(resolve(pythonPath).toLowerCase()).digest('hex').slice(0, 24)
  return join(resolve(home), 'runtime', 'receipts', `external-${id}.json`)
}

function receiptPathFor(home, runtime) {
  if (runtime.source === 'app-owned') {
    const versionDir = ownedVersionDirFor(home, runtime)
    return versionDir ? join(versionDir, RECEIPT_FILE) : null
  }
  if (runtime.source === 'external') return externalReceiptPath(home, runtime.pythonPath)
  return null
}

function validateReceipt(home, receipt, { bundleManifest = null } = {}) {
  if (!receipt || !RECEIPT_SCHEMAS.has(receipt.schema)) return null
  if (!['app-owned', 'external'].includes(receipt.source)) return null
  if (typeof receipt.pythonPath !== 'string' || !isAbsolute(receipt.pythonPath)) return null
  if (!existsSync(receipt.pythonPath)) return null
  try { if (!statSync(receipt.pythonPath).isFile()) return null } catch { return null }
  const expectedReceiptPath = receiptPathFor(home, receipt)
  if (!expectedReceiptPath) return null
  if (receipt.source === 'app-owned') {
    if (!receipt.wheelSha256) return null
    if (receipt.schema === RUNTIME_RECEIPT_SCHEMA) {
      if (
        typeof receipt.runtimeFingerprint !== 'string'
        || typeof receipt.pythonLockSha256 !== 'string'
        || typeof receipt.requirementsSha256 !== 'string'
        || typeof receipt.packageInventorySha256 !== 'string'
        || receipt.pipCheck !== 'passed'
      ) return null
      const versionDir = ownedVersionDirFor(home, receipt)
      const inventoryName = receipt.packageInventory
      if (!versionDir || inventoryName !== 'runtime-inventory.json') return null
      if (isSplitReceipt(receipt)) {
        // 拆层的 pythonPath 指向共享底座,不再落在版本目录里 —— 自包含布局靠
        // "解释器就在版本目录下"这一条把 receipt 和它描述的环境锁在一起,拆层后
        // 这条不成立了,得显式验:底座在 runtime/bases 下、解释器确实属于那个底座、
        // 应用层就在本版本目录里且真有我们的包。少验一条,一份 receipt 就能给
        // 任意解释器背书。
        const baseDir = baseDirFor(home, receipt.basePath)
        if (!baseDir || !existsSync(baseDir)) return null
        if (!isWithin(baseDir, resolve(receipt.pythonPath))) return null
        const appDir = join(versionDir, APP_DIR_NAME)
        if (typeof receipt.appPath !== 'string') return null
        if (canonical(receipt.appPath) !== canonical(appDir)) return null
        if (!existsSync(join(appDir, 'video_knowledge', '__init__.py'))) return null
      }
      const inventoryPath = join(versionDir, inventoryName)
      if (sha256(inventoryPath) === null) return null
      const inventory = readJson(inventoryPath)
      if (
        inventory?.runtimeFingerprint !== receipt.runtimeFingerprint
        || inventory?.packageInventorySha256 !== receipt.packageInventorySha256
        || inventory?.pipCheck?.status !== 'passed'
      ) return null
      if (Array.isArray(receipt.extras) && receipt.extras.includes('media-asr')) {
        const modelPack = Array.isArray(receipt.modelPacks)
          ? receipt.modelPacks.find((item) => item?.id === 'local-asr')
          : null
        if (
          !modelPack
          || typeof modelPack.cacheRoot !== 'string'
          || !isAbsolute(modelPack.cacheRoot)
          || !isWithin(join(resolve(home), 'models', 'asr'), modelPack.cacheRoot)
          || typeof modelPack.manifestSha256 !== 'string'
          || receipt.asrSmoke?.ready !== true
          || typeof receipt.ffmpegVersion !== 'string'
        ) return null
        const modelReceipt = readJson(join(dirname(modelPack.cacheRoot), 'model-pack-receipt.json'))
        if (
          modelReceipt?.schema !== 'vk-asr-model-pack-receipt@1'
          || modelReceipt?.status !== 'verified'
          || modelReceipt?.manifestSha256 !== modelPack.manifestSha256
        ) return null
      }
    }
  } else if (!compatibleVersion(receipt.apiVersion) || !compatibleVersion(receipt.schemaVersion)) {
    return null
  }
  const current = receiptMatchesCurrentBundle(receipt, bundleManifest)
  return {
    ...receipt,
    receiptPath: expectedReceiptPath,
    current,
    legacyUnreproducible: receipt.source === 'app-owned' && receipt.schema === LEGACY_RECEIPT_SCHEMA,
  }
}

function validateActive(home, active, options) {
  if (!active || !['app-owned', 'external'].includes(active.source)) return null
  const expectedReceiptPath = receiptPathFor(home, active)
  if (!expectedReceiptPath) return null
  if (active.receiptPath && canonical(active.receiptPath) !== canonical(expectedReceiptPath)) return null
  const receipt = validateReceipt(home, readJson(expectedReceiptPath), options)
  if (!receipt) return null
  if (canonical(receipt.pythonPath) !== canonical(active.pythonPath)) return null
  if (String(receipt.version ?? '') !== String(active.version ?? '')) return null
  if (receipt.source !== active.source) return null
  return receipt
}

function migrateLegacyOwnedReceipt(home, active) {
  if (!active || (active.source && active.source !== 'app-owned')) return null
  if (typeof active.pythonPath !== 'string' || !existsSync(active.pythonPath)) return null
  const versionDir = ownedVersionDir(home, active.pythonPath)
  if (!versionDir) return null
  if (!active.wheelSha256) return null
  const receipt = {
    schema: LEGACY_RECEIPT_SCHEMA,
    source: 'app-owned',
    version: String(active.version ?? 'unknown'),
    pythonPath: resolve(active.pythonPath),
    wheel: active.wheel ?? null,
    wheelSha256: active.wheelSha256,
    uvSha256: active.uvSha256 ?? null,
    apiVersion: active.apiVersion ?? null,
    schemaVersion: active.schemaVersion ?? null,
    capabilities: Array.isArray(active.capabilities) ? active.capabilities : [],
    extras: Array.isArray(active.extras) ? active.extras : [],
    installedAt: active.installedAt ?? new Date().toISOString(),
    migratedFrom: 'vk-runtime-active@1',
  }
  return writeRuntimeReceipt(home, receipt)
}

export function writeRuntimeReceipt(home, receipt) {
  const schema = receipt.schema
    ?? (receipt.runtimeFingerprint ? RUNTIME_RECEIPT_SCHEMA : LEGACY_RECEIPT_SCHEMA)
  if (!RECEIPT_SCHEMAS.has(schema)) throw new Error('runtime receipt schema 不支持')
  const normalized = { ...receipt, schema, pythonPath: resolve(receipt.pythonPath) }
  const path = receiptPathFor(home, normalized)
  if (!path) throw new Error('runtime receipt path 不在允许范围')
  atomicJson(path, normalized)
  return { ...normalized, receiptPath: path }
}

export function writeActiveRuntime(home, runtime) {
  const receiptPath = runtime.receiptPath ?? receiptPathFor(home, runtime)
  if (!receiptPath) throw new Error('runtime receipt 缺失')
  const active = {
    schema: ACTIVE_SCHEMA,
    source: runtime.source,
    version: String(runtime.version ?? 'unknown'),
    pythonPath: resolve(runtime.pythonPath),
    receiptPath,
    activatedAt: new Date().toISOString(),
  }
  // 拆层时解释器与应用层分处两地,只记 pythonPath 会让 sidecar 拿着底座去跑——
  // 那里面根本没有我们的包。
  if (isSplitReceipt(runtime)) {
    active.runtimeLayout = SPLIT_LAYOUT
    active.appPath = resolve(runtime.appPath)
    // 底座也要写进来。回收是按引用判的,active.json 不指名道姓,正在跑的那个底座就
    // 只能靠 receipt 保它 —— 版本目录一旦损坏,回收就会把活人脚下的地板拆了。
    active.basePath = resolve(runtime.basePath)
  }
  atomicJson(join(resolve(home), 'runtime', 'active.json'), active)
  return active
}

export function listOwnedRuntimeReceipts({ home, bundleDir } = {}) {
  if (!home) return []
  const versions = join(resolve(home), 'runtime', 'versions')
  if (!existsSync(versions)) return []
  const bundleManifest = manifestOf(bundleDir)
  const receipts = []
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const receipt = validateReceipt(home, readJson(join(versions, entry.name, RECEIPT_FILE)), { bundleManifest })
    if (receipt) receipts.push(receipt)
  }
  return receipts.sort((a, b) => String(b.installedAt ?? '').localeCompare(String(a.installedAt ?? '')))
}

// 体积报的是**删掉它真正释放的字节**。拆层后共享底座不算在任何一个版本头上——
// 把 2.4 GB 记到每个 2 MB 的版本上,清理界面就会承诺一个它兑现不了的数字。
export function ownedRuntimeSizeBytes({ home, runtime } = {}) {
  if (!home || runtime?.source !== 'app-owned') return 0
  const versionDir = ownedVersionDirFor(home, runtime)
  return versionDir ? directorySizeBytes(versionDir) : 0
}

export async function ownedRuntimeSizeBytesAsync({ home, runtime } = {}) {
  if (!home || runtime?.source !== 'app-owned') return 0
  const versionDir = ownedVersionDirFor(home, runtime)
  return versionDir ? directorySizeBytesAsync(versionDir) : 0
}

export function removeOwnedRuntimeReceipt({ home, runtime } = {}) {
  if (!home || runtime?.source !== 'app-owned') throw new Error('只能清理 app-owned runtime')
  const versionDir = ownedVersionDirFor(home, runtime)
  const receiptPath = versionDir ? join(versionDir, RECEIPT_FILE) : null
  if (!versionDir || !receiptPath) throw new Error('runtime 版本目录不在允许范围')
  const onDisk = validateReceipt(home, readJson(receiptPath))
  if (!onDisk || canonical(onDisk.receiptPath) !== canonical(runtime.receiptPath ?? receiptPath)) {
    throw new Error('runtime receipt 已失效')
  }
  const active = readJson(join(resolve(home), 'runtime', 'active.json'))
  const sameReceipt = active?.receiptPath
    && canonical(active.receiptPath) === canonical(receiptPath)
  // pythonPath 这条只对自包含布局成立 —— 那里解释器唯一标识一个 runtime。拆层之后
  // **所有版本共用同一个底座解释器**,拿它当身份会把每个版本都判成"正在用",清理
  // 于是全线拒绝。拆层的身份是版本目录,也就是 receiptPath。
  const samePython = !isSplitReceipt(onDisk)
    && active?.pythonPath
    && canonical(active.pythonPath) === canonical(runtime.pythonPath)
  if (sameReceipt || samePython) {
    throw new Error('活动 runtime 不允许清理')
  }
  const sizeBytes = directorySizeBytes(versionDir)
  rmSync(versionDir, { recursive: true, force: false })
  return { version: String(runtime.version ?? 'unknown'), sizeBytes }
}

// —— 底座回收 ——
//
// 底座共享之后,删一个版本目录不再释放依赖:清理逻辑照旧只动 versions/,底座会一直
// 堆着。堆积速率不高(只有依赖真的变了才会多一个),但这是**我们自己引入的**泄漏,
// 不能留给"以后再说"。
//
// 判据只认引用:一个底座只要还有任意一份**有效** receipt 指着它,或它正是 active.json
// 用的那个,就留下。这和 Nix 的 GC roots 是同一件事——不数引用就只能靠人记得。
export function pruneUnreferencedBases({ home, dryRun = false } = {}) {
  if (!home) return []
  const bases = join(resolve(home), 'runtime', 'bases')
  if (!existsSync(bases)) return []
  const referenced = new Set()
  const keep = (value) => {
    const dir = baseDirFor(home, value)
    if (dir) referenced.add(canonical(dir))
  }
  // active.json 单独保一次:它指的那个底座正在被跑着的进程用,哪怕 receipt 一时读不出来。
  keep(readJson(join(resolve(home), 'runtime', 'active.json'))?.basePath)
  const versions = join(resolve(home), 'runtime', 'versions')
  if (existsSync(versions)) {
    for (const entry of readdirSync(versions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const receipt = readJson(join(versions, entry.name, RECEIPT_FILE))
      if (!isSplitReceipt(receipt)) continue
      // 用 validateReceipt 而不是直接读字段:一份自称指着某底座的坏 receipt 不该
      // 让那个底座永远留着。但它也只是不保而已,真正的删除仍要过下面那道范围检查。
      if (validateReceipt(home, receipt)) keep(receipt.basePath)
    }
  }
  const removed = []
  for (const entry of readdirSync(bases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(bases, entry.name)
    if (referenced.has(canonical(dir))) continue
    if (!baseDirFor(home, dir)) continue      // 越界的一律不碰
    removed.push(dir)
    if (!dryRun) rmSync(dir, { recursive: true, force: true })
  }
  return removed
}

export function resolveActiveRuntime({ home, bundleDir, repair = true } = {}) {
  if (!home) return null
  const bundleManifest = manifestOf(bundleDir)
  const activePath = join(resolve(home), 'runtime', 'active.json')
  const rawActive = readJson(activePath)
  let active = validateActive(home, rawActive, { bundleManifest })
  if (!active && rawActive) {
    const migrated = migrateLegacyOwnedReceipt(home, rawActive)
    if (migrated) {
      writeActiveRuntime(home, migrated)
      active = validateActive(home, readJson(activePath), { bundleManifest })
    }
  }
  if (active || !repair) return active
  const candidates = listOwnedRuntimeReceipts({ home, bundleDir })
  const recovered = candidates.find((receipt) => receipt.current) ?? candidates[0] ?? null
  if (!recovered) return null
  writeActiveRuntime(home, recovered)
  return recovered
}
