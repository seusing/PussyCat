// video-knowledge capability-pack catalog.
//
// Packs are deliberately a small, closed set.  The UI can ask for a pack id,
// but it must never be able to smuggle an arbitrary uv/pip extra into the
// runtime installer.

export const RUNTIME_EXTRA_ORDER = Object.freeze([
  'media-asr',
  'alignment-whisperx',
  'diarization-pyannote',
])

export const CAPABILITY_PACKS = Object.freeze([
  Object.freeze({
    id: 'local-asr',
    name: '本地语音识别',
    description: '为没有字幕的视频启用本地语音识别依赖。模型会在首次使用时按需处理。',
    size_label: '约 1.2 GB',
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
      // Dependency installation is not model download.  Keep this wording
      // explicit so a green pack cannot be read as a cached model guarantee.
      return '依赖已安装，首次使用可能下载模型'
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
  checkedAt = new Date().toISOString(),
} = {}) {
  const activeExtras = Array.isArray(activeRuntime?.extras) ? activeRuntime.extras : []
  // Do not reject legacy receipts containing an unknown extra while projecting
  // status; only incoming install requests are validated by normalizeRuntimeExtras.
  const installedExtras = [...new Set(activeExtras.filter((extra) => typeof extra === 'string'))]
  const targetExtras = normalizeRuntimeExtras(installingExtras)
  const capabilities = activeRuntime?.capabilities

  const packs = CAPABILITY_PACKS.map((pack) => {
    const installedCount = pack.extras.filter((extra) => installedExtras.includes(extra)).length
    const complete = installedCount === pack.extras.length
    const partial = installedCount > 0 && !complete
    const isInstalling = installing && pack.extras.some((extra) => targetExtras.includes(extra)) && !complete
    const capabilityEntries = capabilityForPack(pack, capabilities)
    const runtimeMissing = capabilityEntries.some(
      (entry) => entry.runtime === 'missing_dependency' || entry.state === 'missing_dependency',
    )
    let state = 'not-installed'
    if (!bundleAvailable) state = 'unavailable'
    else if (isInstalling) state = 'installing'
    else if (complete && runtimeMissing) state = 'partial'
    else if (complete) state = 'installed'
    else if (partial) state = 'partial'
    const detail = packDetail(pack, state, installedExtras, capabilities)
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
      model_downloaded: null,
    }
  })
  return { packs, checked_at: checkedAt }
}
