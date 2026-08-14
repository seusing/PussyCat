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

export function runtimeContractFingerprint(manifest, extras = []) {
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
  const target = {
    pythonImplementation: manifest.runtime.pythonImplementation,
    pythonVersion: manifest.runtime.pythonVersion,
    pythonAbi: manifest.runtime.pythonAbi,
    platform: manifest.runtime.platform,
  }
  const payload = {
    schema: RUNTIME_CONTRACT_SCHEMA,
    wheelSha256: manifest.wheel.sha256,
    uvSha256: manifest.uv.sha256,
    pythonLockSha256: sourceLockSha256,
    requirementsSha256: requirements.sha256,
    extras: normalizedExtras,
    modelPacks,
    target,
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
