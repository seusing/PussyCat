import { createHash } from 'node:crypto'
import {
  RUNTIME_EXTRA_ORDER,
  normalizeRuntimeExtras,
} from './vk-capability-packs.mjs'

export const RUNTIME_CONTRACT_SCHEMA = 'vk-runtime-contract@1'
export const RUNTIME_RECEIPT_SCHEMA = 'vk-runtime-receipt@2'
export const RUNTIME_TARGET = Object.freeze({
  pythonImplementation: 'cpython',
  pythonVersion: '3.12',
  pythonAbi: 'cp312',
  platform: 'x86_64-pc-windows-msvc',
})

export function runtimeRequirementsKey(extras = []) {
  const normalized = normalizeRuntimeExtras(extras)
  return normalized.length ? normalized.join('+') : 'base'
}

export function runtimeRequirementsFilename(extras = []) {
  return `requirements-${runtimeRequirementsKey(extras).replaceAll('+', '-')}.txt`
}

export function enumerateRuntimeExtraProfiles() {
  const profiles = []
  const count = 2 ** RUNTIME_EXTRA_ORDER.length
  for (let mask = 0; mask < count; mask += 1) {
    profiles.push(RUNTIME_EXTRA_ORDER.filter((_extra, index) => (mask & (1 << index)) !== 0))
  }
  return profiles.sort((left, right) => (
    left.length - right.length
    || runtimeRequirementsKey(left).localeCompare(runtimeRequirementsKey(right))
  ))
}

export function runtimeRequirementsFor(manifest, extras = []) {
  const key = runtimeRequirementsKey(extras)
  const entries = Array.isArray(manifest?.runtime?.requirements)
    ? manifest.runtime.requirements
    : []
  const entry = entries.find((candidate) => (
    candidate?.key === key
    && runtimeRequirementsKey(candidate?.extras ?? []) === key
  ))
  return entry ?? null
}

export function runtimeModelPacksFor(manifest, extras = []) {
  const normalized = new Set(normalizeRuntimeExtras(extras))
  const packs = Array.isArray(manifest?.runtime?.modelPacks)
    ? manifest.runtime.modelPacks
    : []
  return packs
    .filter((pack) => typeof pack?.requiredExtra === 'string' && normalized.has(pack.requiredExtra))
    .map((pack) => ({
      id: pack.id,
      requiredExtra: pack.requiredExtra,
      manifest: pack.manifest,
      manifestSha256: pack.manifestSha256,
      smoke: pack.smoke,
      smokeSha256: pack.smokeSha256,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

/** 契约指纹的公共前半段:依赖环境本身,**不含应用 wheel**。
 *
 * 拆出来是为了区分两类更新。整个 venv 有 2.3 GB / 41,558 个文件,其中应用代码只占
 * 493 KB;而原先的指纹把两者算在一起,于是只改代码也会算出一个新指纹 → 新目录 →
 * 把 2.3 GB 依赖重装一遍(实测几分钟)。环境指纹相同就说明"那堆 asr/whisperx 一个
 * 字节没变",装依赖这一步可以整个跳过。
 *
 * 返回 null 的条件与契约指纹一致——两者共用同一份校验,不能一个认一个不认。
 */
function fingerprintInputs(manifest, extras) {
  const normalizedExtras = normalizeRuntimeExtras(extras)
  const requirements = runtimeRequirementsFor(manifest, normalizedExtras)
  const modelPacks = runtimeModelPacksFor(manifest, normalizedExtras)
  const sourceLockSha256 = manifest?.source?.pythonLockSha256
  if (
    manifest?.runtime?.contractSchema !== RUNTIME_CONTRACT_SCHEMA
    || !manifest?.wheel?.sha256
    || !manifest?.uv?.sha256
    || !sourceLockSha256
    || !requirements?.sha256
    || (normalizedExtras.includes('media-asr') && modelPacks.length !== 1)
    || modelPacks.some((pack) => (
      !pack.id || !pack.manifest || !pack.manifestSha256 || !pack.smoke || !pack.smokeSha256
    ))
  ) {
    return null
  }
  return {
    normalizedExtras,
    environment: {
      schema: RUNTIME_CONTRACT_SCHEMA,
      uvSha256: manifest.uv.sha256,
      pythonLockSha256: sourceLockSha256,
      requirementsSha256: requirements.sha256,
      extras: normalizedExtras,
      modelPacks,
      target: {
        pythonImplementation: manifest.runtime.pythonImplementation,
        pythonVersion: manifest.runtime.pythonVersion,
        pythonAbi: manifest.runtime.pythonAbi,
        platform: manifest.runtime.platform,
      },
    },
    wheelSha256: manifest.wheel.sha256,
  }
}

export function runtimeEnvironmentFingerprint(manifest, extras = []) {
  const inputs = fingerprintInputs(manifest, extras)
  if (!inputs) return null
  return createHash('sha256').update(JSON.stringify(inputs.environment)).digest('hex')
}

export function runtimeContractFingerprint(manifest, extras = []) {
  const inputs = fingerprintInputs(manifest, extras)
  if (!inputs) return null
  // 载荷保持与拆分前逐字段一致(顺序也一样),否则已装 runtime 的指纹会全部对不上,
  // 所有人下次启动都被判为"有更新"并白重装一次。
  const payload = {
    schema: inputs.environment.schema,
    wheelSha256: inputs.wheelSha256,
    uvSha256: inputs.environment.uvSha256,
    pythonLockSha256: inputs.environment.pythonLockSha256,
    requirementsSha256: inputs.environment.requirementsSha256,
    extras: inputs.environment.extras,
    modelPacks: inputs.environment.modelPacks,
    target: inputs.environment.target,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function receiptMatchesCurrentBundle(receipt, manifest) {
  if (!receipt || receipt.source !== 'app-owned' || !manifest) return false
  if (receipt.schema === RUNTIME_RECEIPT_SCHEMA) {
    const expected = runtimeContractFingerprint(manifest, receipt.extras ?? [])
    return !!expected && receipt.runtimeFingerprint === expected
  }
  // A v1 receipt can remain usable as a rollback candidate, but it never
  // proves the dependency contract shipped by a v2 bundle.
  if (manifest.schema === 'vk-runtime-bundle@1') {
    return !!receipt.wheelSha256 && receipt.wheelSha256 === manifest?.wheel?.sha256
  }
  return false
}
