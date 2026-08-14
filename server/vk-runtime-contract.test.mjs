// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  enumerateRuntimeExtraProfiles,
  receiptMatchesCurrentBundle,
  runtimeContractFingerprint,
  runtimeRequirementsKey,
} from './vk-runtime-contract.mjs'

function manifest() {
  return {
    schema: 'vk-runtime-bundle@2',
    source: { pythonLockSha256: 'a'.repeat(64) },
    wheel: { sha256: 'b'.repeat(64) },
    uv: { sha256: 'c'.repeat(64) },
    runtime: {
      contractSchema: 'vk-runtime-contract@1',
      pythonImplementation: 'cpython',
      pythonVersion: '3.12',
      pythonAbi: 'cp312',
      platform: 'x86_64-pc-windows-msvc',
      requirements: enumerateRuntimeExtraProfiles().map((extras, index) => ({
        key: runtimeRequirementsKey(extras),
        extras,
        name: `requirements-${index}.txt`,
        sha256: String(index).padStart(64, '0'),
      })),
      modelPacks: [{
        id: 'local-asr', requiredExtra: 'media-asr',
        manifest: 'asr-model-pack.json', manifestSha256: 'e'.repeat(64),
        smoke: 'runtime-asr-smoke.wav', smokeSha256: 'f'.repeat(64),
      }],
    },
  }
}

describe('runtime dependency contract', () => {
  it('enumerates every canonical extras set exactly once', () => {
    const keys = enumerateRuntimeExtraProfiles().map(runtimeRequirementsKey)
    expect(keys).toHaveLength(8)
    expect(new Set(keys).size).toBe(8)
    expect(keys).toContain('base')
    expect(keys).toContain('media-asr+alignment-whisperx+diarization-pyannote')
  })

  it('fingerprints the exact lock profile and rejects a stale receipt', () => {
    const bundle = manifest()
    const extras = ['media-asr']
    const fingerprint = runtimeContractFingerprint(bundle, extras)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(receiptMatchesCurrentBundle({
      schema: 'vk-runtime-receipt@2',
      source: 'app-owned',
      extras,
      runtimeFingerprint: fingerprint,
    }, bundle)).toBe(true)
    expect(receiptMatchesCurrentBundle({
      schema: 'vk-runtime-receipt@2',
      source: 'app-owned',
      extras,
      runtimeFingerprint: 'd'.repeat(64),
    }, bundle)).toBe(false)
  })

  it('keeps a v1 receipt usable but never calls it current for a v2 bundle', () => {
    expect(receiptMatchesCurrentBundle({
      schema: 'vk-runtime-receipt@1',
      source: 'app-owned',
      wheelSha256: 'b'.repeat(64),
    }, manifest())).toBe(false)
  })
})
