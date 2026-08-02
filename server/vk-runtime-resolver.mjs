// video-knowledge runtime 的唯一 active/receipt 解析器。
// owned runtime 只信 HOME/runtime/versions 内的 receipt；external runtime 必须显式标记，
// 且 receipt 仍由爪爪保存在 HOME/runtime/receipts，绝不写外部环境。
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const RECEIPT_FILE = 'runtime-receipt.json'
const RECEIPT_SCHEMA = 'vk-runtime-receipt@1'
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
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return null
  if (!['app-owned', 'external'].includes(receipt.source)) return null
  if (typeof receipt.pythonPath !== 'string' || !isAbsolute(receipt.pythonPath)) return null
  if (!existsSync(receipt.pythonPath)) return null
  try { if (!statSync(receipt.pythonPath).isFile()) return null } catch { return null }
  const expectedReceiptPath = receiptPathFor(home, receipt)
  if (!expectedReceiptPath) return null
  if (receipt.source === 'app-owned') {
    if (!receipt.wheelSha256) return null
    if (bundleManifest?.wheel?.sha256 && receipt.wheelSha256 !== bundleManifest.wheel.sha256) return null
  } else if (!compatibleVersion(receipt.apiVersion) || !compatibleVersion(receipt.schemaVersion)) {
    return null
  }
  return { ...receipt, receiptPath: expectedReceiptPath }
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

function migrateLegacyOwnedReceipt(home, active, bundleManifest) {
  if (!active || (active.source && active.source !== 'app-owned')) return null
  if (typeof active.pythonPath !== 'string' || !existsSync(active.pythonPath)) return null
  const versionDir = ownedVersionDir(home, active.pythonPath)
  if (!versionDir) return null
  if (!active.wheelSha256 || active.wheelSha256 !== bundleManifest?.wheel?.sha256) return null
  const receipt = {
    schema: RECEIPT_SCHEMA,
    source: 'app-owned',
    version: String(active.version ?? 'unknown'),
    pythonPath: resolve(active.pythonPath),
    wheel: active.wheel ?? bundleManifest?.wheel?.name ?? null,
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
  const normalized = { ...receipt, schema: RECEIPT_SCHEMA, pythonPath: resolve(receipt.pythonPath) }
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

export function resolveActiveRuntime({ home, bundleDir, repair = true } = {}) {
  if (!home) return null
  const bundleManifest = manifestOf(bundleDir)
  const activePath = join(resolve(home), 'runtime', 'active.json')
  const rawActive = readJson(activePath)
  let active = validateActive(home, rawActive, { bundleManifest })
  if (!active && rawActive) {
    const migrated = migrateLegacyOwnedReceipt(home, rawActive, bundleManifest)
    if (migrated) {
      writeActiveRuntime(home, migrated)
      active = validateActive(home, readJson(activePath), { bundleManifest })
    }
  }
  if (active || !repair) return active
  const recovered = listOwnedRuntimeReceipts({ home, bundleDir })[0] ?? null
  if (!recovered) return null
  writeActiveRuntime(home, recovered)
  return recovered
}
