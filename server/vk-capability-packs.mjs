// video-knowledge capability-pack catalog.
//
// Packs are deliberately a small, closed set.  The UI can ask for a pack id,
// but it must never be able to smuggle an arbitrary uv/pip extra into the
// runtime installer.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

export const RUNTIME_EXTRA_ORDER = Object.freeze([
  'media-asr',
  'alignment-whisperx',
  'diarization-pyannote',
])

export const CAPABILITY_PACKS = Object.freeze([
  Object.freeze({
    id: 'local-asr',
    name: '本地语音识别',
    description: '为没有字幕的视频安装并校验本地语音识别依赖与模型。',
    size_label: '依赖约 1.9 GiB + 模型约 2.0 GiB',
    extras: Object.freeze(['media-asr']),
    capabilities: Object.freeze(['local_transcription', 'media_asr']),
  }),
  Object.freeze({
    id: 'precision-transcript',
    name: '精准转写',
    description: '启用逐词时间轴和说话人分离依赖。',
    size_label: '约 +329 MB',
    extras: Object.freeze(['alignment-whisperx', 'diarization-pyannote']),
    capabilities: Object.freeze([
      'word_timestamps',
      'alignment',
      'alignment_whisperx',
      'speaker_diarization',
      'diarization',
      'diarization_pyannote',
    ]),
  }),
])

const PACK_BY_ID = new Map(CAPABILITY_PACKS.map((pack) => [pack.id, pack]))
const EXTRA_INDEX = new Map(RUNTIME_EXTRA_ORDER.map((extra, index) => [extra, index]))

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function safeFile(path, expectedSize) {
  try {
    return statSync(path).isFile() && statSync(path).size === expectedSize
  } catch {
    return false
  }
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:[\\/]/.test(rel))
}

/**
 * Inspect common ModelScope locations without hashing multi-gigabyte files on
 * every status poll.  Exact SHA-256 verification still happens in the
 * Python installer; this projection tells the user whether that installer
 * can reuse local files and how many files need attention.
 */
export function inspectLocalAsrCache({ bundleDir, home, env = process.env } = {}) {
  const runtimeManifest = bundleDir ? readJson(join(bundleDir, 'runtime-manifest.json')) : null
  const pack = Array.isArray(runtimeManifest?.runtime?.modelPacks)
    ? runtimeManifest.runtime.modelPacks.find((item) => item?.id === 'local-asr')
    : null
  if (!pack?.manifest || !bundleDir) {
    return { state: 'unknown', reusableFiles: 0, totalFiles: 0, missingFiles: [], mismatchedFiles: [], root: null }
  }
  const manifestPath = resolve(bundleDir, pack.manifest)
  if (!inside(bundleDir, manifestPath) || !existsSync(manifestPath)) {
    return { state: 'unknown', reusableFiles: 0, totalFiles: 0, missingFiles: [], mismatchedFiles: [], root: null }
  }
  const manifest = readJson(manifestPath)
  const models = Array.isArray(manifest?.models) ? manifest.models : []
  const roots = []
  if (home && pack.manifestSha256) roots.push(join(resolve(home), 'models', 'asr', pack.manifestSha256, 'models'))
  if (typeof env?.MODELSCOPE_CACHE === 'string' && env.MODELSCOPE_CACHE.trim()) roots.push(env.MODELSCOPE_CACHE.trim())
  const userCache = join(homedir(), '.cache', 'modelscope')
  roots.push(join(userCache, 'hub', 'models'), join(userCache, 'hub'))
  const uniqueRoots = [...new Set(roots.map((root) => resolve(root)))]
  const missingFiles = []
  const mismatchedFiles = []
  let reusableFiles = 0
  let totalFiles = 0
  let selectedRoot = null
  for (const model of models) {
    const files = Array.isArray(model?.files) ? model.files : []
    for (const file of files) {
      totalFiles += 1
      const candidates = uniqueRoots.flatMap((root) => [
        join(root, 'iic', String(model.directory ?? ''), String(file.path ?? '')),
        join(root, String(model.directory ?? ''), String(file.path ?? '')),
      ])
      const exactSize = candidates.find((candidate) => safeFile(candidate, Number(file.size)))
      if (exactSize) {
        reusableFiles += 1
        if (!selectedRoot) selectedRoot = exactSize.slice(0, exactSize.length - (String(file.path ?? '').length + 1))
        continue
      }
      const existing = candidates.find((candidate) => {
        try { return statSync(candidate).isFile() } catch { return false }
      })
      ;(existing ? mismatchedFiles : missingFiles).push(`${model.directory}/${file.path}`)
    }
  }
  const appPackReceipt = home && pack.manifestSha256
    ? readJson(join(resolve(home), 'models', 'asr', pack.manifestSha256, 'model-pack-receipt.json'))
    : null
  const verified = appPackReceipt?.schema === 'vk-asr-model-pack-receipt@1'
    && appPackReceipt?.status === 'verified'
    && appPackReceipt?.manifestSha256 === pack.manifestSha256
    && reusableFiles === totalFiles
  const state = verified ? 'verified' : reusableFiles === totalFiles ? 'available' : reusableFiles > 0 ? 'partial' : 'missing'
  return {
    state,
    reusableFiles,
    totalFiles,
    missingFiles,
    mismatchedFiles,
    root: selectedRoot,
    manifestSha256: pack.manifestSha256 ?? null,
  }
}

export class VkCapabilityPackError extends Error {
  constructor(message, reasonCode = 'invalid-capability-pack') {
    super(message)
    this.name = 'VkCapabilityPackError'
    this.statusCode = 400
    this.reasonCode = reasonCode
  }
}

export function getCapabilityPack(packId) {
  if (typeof packId !== 'string' || !PACK_BY_ID.has(packId)) {
    throw new VkCapabilityPackError(`未知能力包: ${String(packId ?? '') || '(empty)'}`)
  }
  return PACK_BY_ID.get(packId)
}

/**
 * Validate and canonicalise runtime extras.  The order is stable so the same
 * cumulative set receives the same version identity regardless of the order
 * in which packs were requested.
 */
export function normalizeRuntimeExtras(extras = []) {
  if (!Array.isArray(extras)) {
    throw new VkCapabilityPackError('runtime extras 必须是数组', 'invalid-runtime-extra')
  }
  const unique = new Set()
  for (const extra of extras) {
    if (typeof extra !== 'string' || !EXTRA_INDEX.has(extra)) {
      throw new VkCapabilityPackError(`不允许的 runtime extra: ${String(extra)}`, 'invalid-runtime-extra')
    }
    unique.add(extra)
  }
  return [...unique].sort((a, b) => EXTRA_INDEX.get(a) - EXTRA_INDEX.get(b))
}

export function mergeRuntimeExtras(...groups) {
  return normalizeRuntimeExtras(groups.flat())
}

function runtimeCapabilityEntries(capabilities) {
  return Array.isArray(capabilities)
    ? capabilities.filter((item) => item && typeof item === 'object')
    : []
}

function capabilityForPack(pack, capabilities) {
  const wanted = new Set(pack.capabilities)
  return runtimeCapabilityEntries(capabilities).filter((item) => wanted.has(item.capability))
}

function missingDependencyText(entries) {
  const details = entries
    .filter((entry) => entry.runtime === 'missing_dependency' || entry.state === 'missing_dependency')
    .map((entry) => typeof entry.detail === 'string' ? entry.detail.trim() : '')
    .filter(Boolean)
  return details.length ? `缺少依赖: ${[...new Set(details)].join('、')}` : '运行时依赖尚未就绪'
}

function packDetail(pack, state, installedExtras, capabilities) {
  const entries = capabilityForPack(pack, capabilities)
  const missing = pack.extras.filter((extra) => !installedExtras.includes(extra))
  if (state === 'unavailable') return '当前安装包没有可用的 video-knowledge runtime'
  if (state === 'installing') return `正在安装: ${missing.length ? missing.join('、') : pack.extras.join('、')}`
  if (state === 'partial') {
    const dependencyMissing = entries.some((entry) => entry.runtime === 'missing_dependency' || entry.state === 'missing_dependency')
      ? missingDependencyText(entries)
      : `还缺少: ${missing.join('、')}`
    return dependencyMissing
  }
  if (state === 'installed') {
    if (pack.id === 'local-asr') {
      const local = entries.find((entry) => entry.capability === 'local_transcription')
      if (local?.runtime === 'missing_dependency' || local?.state === 'missing_dependency') {
        return missingDependencyText([local])
      }
      return '依赖、模型、FFmpeg 与离线转写均已验证'
    }
    return '依赖已安装'
  }
  return `待安装: ${missing.join('、')}`
}

/**
 * Project the active runtime into the small API shape consumed by the UI.
 * `activeRuntime.extras` is authoritative for package installation. Runtime
 * capability entries only refine a package to partial when the sidecar says a
 * dependency is still unavailable.
 */
export function projectCapabilityPacks({
  activeRuntime = null,
  bundleAvailable = true,
  installingExtras = [],
  installing = false,
  localModelCache = null,
  checkedAt = new Date().toISOString(),
} = {}) {
  const activeExtras = Array.isArray(activeRuntime?.extras) ? activeRuntime.extras : []
  // Do not reject legacy receipts containing an unknown extra while projecting
  // status; only incoming install requests are validated by normalizeRuntimeExtras.
  const installedExtras = [...new Set(activeExtras.filter((extra) => typeof extra === 'string'))]
  const targetExtras = normalizeRuntimeExtras(installingExtras)
  const capabilities = activeRuntime?.capabilities
  const activeReceiptHasAsrModel = Array.isArray(activeRuntime?.modelPacks)
    && activeRuntime.modelPacks.some((item) => (
      item?.id === 'local-asr'
      && typeof item.cacheRoot === 'string'
      && item.cacheRoot.length > 0
      && typeof item.manifestSha256 === 'string'
      && item.manifestSha256.length > 0
    ))
  const asrModelReady = activeReceiptHasAsrModel || localModelCache?.state === 'verified'
  const asrSmokeReady = activeRuntime?.asrSmoke?.ready === true
    && typeof activeRuntime?.ffmpegVersion === 'string'
    && activeRuntime.ffmpegVersion.length > 0

  const packs = CAPABILITY_PACKS.map((pack) => {
    const installedCount = pack.extras.filter((extra) => installedExtras.includes(extra)).length
    const complete = installedCount === pack.extras.length
    const partial = installedCount > 0 && !complete
    const isInstalling = installing && pack.extras.some((extra) => targetExtras.includes(extra)) && !complete
    const capabilityEntries = capabilityForPack(pack, capabilities)
    const runtimeMissing = capabilityEntries.some(
      (entry) => entry.runtime === 'missing_dependency' || entry.state === 'missing_dependency',
    )
    const modelMissing = pack.id === 'local-asr' && complete && !asrModelReady
    const smokeMissing = pack.id === 'local-asr' && complete && !asrSmokeReady
    let state = 'not-installed'
    if (!bundleAvailable) state = 'unavailable'
    else if (isInstalling) state = 'installing'
    else if (complete && (runtimeMissing || modelMissing || smokeMissing)) state = 'partial'
    else if (complete) state = 'installed'
    else if (partial) state = 'partial'
    const cacheState = pack.id === 'local-asr' ? localModelCache?.state : null
    const detail = modelMissing && cacheState === 'available'
      ? `已发现本地模型缓存（${localModelCache.reusableFiles}/${localModelCache.totalFiles} 个文件），安装时逐文件校验并复用`
      : modelMissing && cacheState === 'partial'
        ? `已发现本地模型缓存（${localModelCache.reusableFiles}/${localModelCache.totalFiles} 个文件），只补齐缺失或不匹配文件`
        : modelMissing
          ? '依赖已存在，但模型尚未按当前 manifest 校验'
      : smokeMissing
        ? '模型已校验，但 FFmpeg 与离线转写 smoke 尚未通过'
        : packDetail(pack, state, installedExtras, capabilities)
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      size_label: pack.size_label,
      state,
      detail,
      installed_extras: installedExtras,
      // These fields are useful to non-UI callers and make the dependency vs
      // model distinction machine-readable without changing the UI contract.
      extras: [...pack.extras],
      dependencies_installed: complete,
      model_downloaded: pack.id === 'local-asr' ? asrModelReady : null,
      local_cache_state: pack.id === 'local-asr' ? cacheState : null,
      local_cache_files: pack.id === 'local-asr' && localModelCache
        ? { reusable: localModelCache.reusableFiles, total: localModelCache.totalFiles }
        : null,
    }
  })
  return { packs, checked_at: checkedAt }
}
