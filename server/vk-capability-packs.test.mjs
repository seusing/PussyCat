// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectLocalAsrCache, projectCapabilityPacks } from './vk-capability-packs.mjs'

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

  it('reports reusable local files separately from a verified app model pack', () => {
    const root = mkdtempSync(join(tmpdir(), 'vk-capability-cache-'))
    const bundle = join(root, 'bundle')
    const cache = join(root, 'cache')
    mkdirSync(join(bundle, 'runtime'), { recursive: true })
    mkdirSync(join(cache, 'iic', 'asr-model'), { recursive: true })
    writeFileSync(join(bundle, 'runtime-manifest.json'), JSON.stringify({
      runtime: { modelPacks: [{ id: 'local-asr', manifest: 'asr-model-pack.json', manifestSha256: 'a'.repeat(64) }] },
    }))
    writeFileSync(join(bundle, 'asr-model-pack.json'), JSON.stringify({
      models: [{ directory: 'asr-model', files: [{ path: 'model.pt', size: 4, sha256: 'b'.repeat(64) }] }],
    }))
    writeFileSync(join(cache, 'iic', 'asr-model', 'model.pt'), 'data')

    const result = inspectLocalAsrCache({ bundleDir: bundle, home: root, env: { MODELSCOPE_CACHE: cache } })
    expect(result).toMatchObject({ state: 'available', reusableFiles: 1, totalFiles: 1 })
    const pack = localAsr(projectCapabilityPacks({
      activeRuntime: activeRuntime({ modelPacks: undefined, asrSmoke: undefined, ffmpegVersion: undefined }),
      localModelCache: result,
    }))
    expect(pack.detail).toContain('逐文件校验并复用')
    expect(pack.local_cache_state).toBe('available')
  })
})
