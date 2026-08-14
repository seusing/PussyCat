// video-knowledge runtime 的唯一 active/receipt 解析器。
// owned runtime 只信 HOME/runtime/versions 内的 receipt；external runtime 必须显式标记，
// 且 receipt 仍由爪爪保存在 HOME/runtime/receipts，绝不写外部环境。
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
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

function externalReceiptPath(home, pythonPath) {
  const id = createHash('sha256').update(resolve(pythonPath).toLowerCase()).digest('hex').slice(0, 24)
  return join(resolve(home), 'runtime', 'receipts', `external-${id}.json`)
}

function receiptPathFor(home, runtime) {
  if (runtime.source === 'app-owned') {
    const versionDir = ownedVersionDir(home, runtime.pythonPath)
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
      const versionDir = ownedVersionDir(home, receipt.pythonPath)
      const inventoryName = receipt.packageInventory
      if (!versionDir || inventoryName !== 'runtime-inventory.json') return null
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

export function ownedRuntimeSizeBytes({ home, runtime } = {}) {
  if (!home || runtime?.source !== 'app-owned') return 0
  const versionDir = ownedVersionDir(home, runtime.pythonPath)
  return versionDir ? directorySizeBytes(versionDir) : 0
}

export function removeOwnedRuntimeReceipt({ home, runtime } = {}) {
  if (!home || runtime?.source !== 'app-owned') throw new Error('只能清理 app-owned runtime')
  const versionDir = ownedVersionDir(home, runtime.pythonPath)
  const receiptPath = versionDir ? join(versionDir, RECEIPT_FILE) : null
  if (!versionDir || !receiptPath) throw new Error('runtime 版本目录不在允许范围')
  const onDisk = validateReceipt(home, readJson(receiptPath))
  if (!onDisk || canonical(onDisk.receiptPath) !== canonical(runtime.receiptPath ?? receiptPath)) {
    throw new Error('runtime receipt 已失效')
  }
  const active = readJson(join(resolve(home), 'runtime', 'active.json'))
  if (
    active?.receiptPath && canonical(active.receiptPath) === canonical(receiptPath)
    || active?.pythonPath && canonical(active.pythonPath) === canonical(runtime.pythonPath)
  ) {
    throw new Error('活动 runtime 不允许清理')
  }
  const sizeBytes = directorySizeBytes(versionDir)
  rmSync(versionDir, { recursive: true, force: false })
  return { version: String(runtime.version ?? 'unknown'), sizeBytes }
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
