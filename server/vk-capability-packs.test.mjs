// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { projectCapabilityPacks } from './vk-capability-packs.mjs'

function localAsr(result) {
  return result.packs.find((pack) => pack.id === 'local-asr')
}

function activeRuntime(overrides = {}) {
  return {
    extras: ['media-asr'],
    capabilities: [{ capability: 'local_transcription', runtime: 'ready', detail: null }],
    modelPacks: [{
      id: 'local-asr',
      cacheRoot: 'C:\\runtime\\models\\asr\\pack',
      manifestSha256: 'a'.repeat(64),
    }],
    asrSmoke: { ready: true },
    ffmpegVersion: 'ffmpeg version 8.0',
    ...overrides,
  }
}

describe('video-knowledge capability pack projection', () => {
  it('keeps a legacy dependency-only ASR runtime partial', () => {
    const pack = localAsr(projectCapabilityPacks({
      activeRuntime: activeRuntime({ modelPacks: undefined, asrSmoke: undefined, ffmpegVersion: undefined }),
    }))

    expect(pack.state).toBe('partial')
    expect(pack.dependencies_installed).toBe(true)
    expect(pack.model_downloaded).toBe(false)
    expect(pack.detail).toContain('manifest')
  })

  it('marks local ASR installed only after model and offline smoke verification', () => {
    const pack = localAsr(projectCapabilityPacks({ activeRuntime: activeRuntime() }))

    expect(pack.state).toBe('installed')
    expect(pack.model_downloaded).toBe(true)
    expect(pack.detail).toContain('离线转写均已验证')
  })

  it('distinguishes a verified model from a missing smoke result', () => {
    const pack = localAsr(projectCapabilityPacks({
      activeRuntime: activeRuntime({ asrSmoke: null }),
    }))

    expect(pack.state).toBe('partial')
    expect(pack.model_downloaded).toBe(true)
    expect(pack.detail).toContain('smoke 尚未通过')
  })

  it('keeps runtime dependency failures visible after all files are present', () => {
    const pack = localAsr(projectCapabilityPacks({
      activeRuntime: activeRuntime({
        capabilities: [{ capability: 'local_transcription', runtime: 'missing_dependency', detail: 'funasr' }],
      }),
    }))

    expect(pack.state).toBe('partial')
    expect(pack.detail).toBe('缺少依赖: funasr')
  })
})
