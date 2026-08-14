// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VkRuntimeInstallError, installVkRuntime, sha256File } from './vk-runtime-install.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function makeBundle({ corruptWheelSha = false, mediaAsr = false } = {}) {
  const bundle = tempDir('vk-bundle-')
  const wheel = join(bundle, 'video_knowledge-0.1.0-py3-none-any.whl')
  const uv = join(bundle, 'uv.exe')
  writeFileSync(wheel, 'wheel-bytes')
  writeFileSync(uv, 'uv-bytes')
  const requirementsName = mediaAsr ? 'requirements-media-asr.txt' : 'requirements-base.txt'
  const requirements = join(bundle, requirementsName)
  writeFileSync(requirements, 'requests==2.0 --hash=sha256:fixture\n')
  const modelManifest = join(bundle, 'asr-model-pack.json')
  const smokeAudio = join(bundle, 'runtime-asr-smoke.wav')
  if (mediaAsr) {
    writeFileSync(modelManifest, '{"schema":"fixture"}\n')
    writeFileSync(smokeAudio, 'wave')
  }
  writeFileSync(join(bundle, 'runtime-manifest.json'), JSON.stringify({
    schema: 'vk-runtime-bundle@2',
    source: { pythonLockSha256: 'c'.repeat(64) },
    wheel: {
      name: 'video_knowledge-0.1.0-py3-none-any.whl',
      sha256: corruptWheelSha ? 'f'.repeat(64) : sha256File(wheel),
    },
    uv: { name: 'uv.exe', sha256: sha256File(uv) },
    runtime: {
      contractSchema: 'vk-runtime-contract@1',
      pythonImplementation: 'cpython',
      pythonVersion: '3.12',
      pythonAbi: 'cp312',
      platform: 'x86_64-pc-windows-msvc',
      requirements: [{
        key: mediaAsr ? 'media-asr' : 'base',
        extras: mediaAsr ? ['media-asr'] : [],
        name: requirementsName,
        sha256: sha256File(requirements),
      }],
      modelPacks: mediaAsr ? [{
        id: 'local-asr', requiredExtra: 'media-asr',
        manifest: 'asr-model-pack.json', manifestSha256: sha256File(modelManifest),
        smoke: 'runtime-asr-smoke.wav', smokeSha256: sha256File(smokeAudio),
      }] : [],
    },
  }))
  return bundle
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill() { return true }
}

describe('installVkRuntime', () => {
  it('SHA 不匹配 → sha-mismatch,零 spawn、绝不激活', async () => {
    const bundle = makeBundle({ corruptWheelSha: true })
    const home = tempDir('vk-home-')
    const spawns = []
    const error = await installVkRuntime({
      home, bundleDir: bundle,
      spawnImpl: (...args) => { spawns.push(args); throw new Error('must not spawn') },
    }).catch((err) => err)
    expect(error).toBeInstanceOf(VkRuntimeInstallError)
    expect(error.reasonCode).toBe('sha-mismatch')
    expect(spawns).toHaveLength(0)
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(false)
  })

  it('manifest 缺失 → bundle-missing', async () => {
    const home = tempDir('vk-home-')
    const error = await installVkRuntime({ home, bundleDir: tempDir('vk-empty-') }).catch((err) => err)
    expect(error.reasonCode).toBe('bundle-missing')
  })

  it('home 过长 → path-too-long(MAX_PATH 预检)', async () => {
    const bundle = makeBundle()
    const home = join(tempDir('vk-home-'), 'x'.repeat(120))
    const error = await installVkRuntime({ home, bundleDir: bundle }).catch((err) => err)
    expect(error.reasonCode).toBe('path-too-long')
  })

  it('网络类失败 → offline 分类,active 不写', async () => {
    const bundle = makeBundle()
    const home = tempDir('vk-home-')
    const error = await installVkRuntime({
      home, bundleDir: bundle,
      spawnImpl: () => {
        const child = new FakeChild()
        setTimeout(() => {
          child.stderr.write('error sending request for url (https://github.com/astral-sh/python-build-standalone)\n')
          child.emit('close', 1)
        }, 5)
        return child
      },
    }).catch((err) => err)
    expect(error).toBeInstanceOf(VkRuntimeInstallError)
    expect(error.reasonCode).toBe('offline')
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(false)
  })

  it('四门全绿后先写 app-owned receipt 再原子激活', async () => {
    const bundle = makeBundle()
    const home = tempDir('vk-home-')
    const spawnImpl = (_program, argv) => {
      const child = new FakeChild()
      queueMicrotask(() => {
        if (argv.includes('gui')) {
          child.stdout.write('gui=http://127.0.0.1:45678\n')
        } else {
          if (argv.some((arg) => String(arg).includes('migrate'))) child.stdout.write('["008"]\n')
          if (argv.some((arg) => String(arg).includes('importlib.metadata'))) child.stdout.write('[]\n')
          child.emit('close', 0)
        }
      })
      return child
    }
    const result = await installVkRuntime({
      home, bundleDir: bundle, spawnImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, package_version: '0.1.0',
        api_version: '1.4.0', processing_request_schema_version: '1.1.0',
        capabilities: [{ capability: 'query_ready', runtime: 'ready' }],
      }) }),
    })
    const versionDir = join(home, 'runtime', 'versions', result.version)
    const receipt = JSON.parse(readFileSync(join(versionDir, 'runtime-receipt.json'), 'utf8'))
    const active = JSON.parse(readFileSync(join(home, 'runtime', 'active.json'), 'utf8'))
    expect(receipt).toMatchObject({
      schema: 'vk-runtime-receipt@2', source: 'app-owned', version: result.version,
      apiVersion: '1.4.0', schemaVersion: '1.1.0',
      pythonLockSha256: 'c'.repeat(64),
      requirements: 'requirements-base.txt',
      runtimeSizeBytes: expect.any(Number),
      pipCheck: 'passed',
    })
    expect(receipt.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.packageInventorySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(active).toMatchObject({ source: 'app-owned', receiptPath: join(versionDir, 'runtime-receipt.json') })
  })

  it('installs only the hashed lock graph before installing the wheel without dependencies', async () => {
    const bundle = makeBundle()
    const home = tempDir('vk-home-')
    const calls = []
    const spawnImpl = (program, argv) => {
      calls.push([program, argv])
      const child = new FakeChild()
      queueMicrotask(() => {
        if (argv.includes('gui')) child.stdout.write('gui=http://127.0.0.1:45678\n')
        else {
          if (argv.some((arg) => String(arg).includes('migrate'))) child.stdout.write('["008"]\n')
          if (argv.some((arg) => String(arg).includes('importlib.metadata'))) child.stdout.write('[]\n')
          child.emit('close', 0)
        }
      })
      return child
    }
    await installVkRuntime({
      home,
      bundleDir: bundle,
      spawnImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, api_version: '1.4.0',
        processing_request_schema_version: '1.1.0', capabilities: [],
      }) }),
    })

    const installCalls = calls.filter(([_program, argv]) => argv[0] === 'pip' && argv[1] === 'install')
    expect(installCalls).toHaveLength(2)
    expect(installCalls[0][1]).toEqual(expect.arrayContaining([
      '--no-deps', '--require-hashes', '-r', join(bundle, 'requirements-base.txt'),
    ]))
    expect(installCalls[1][1]).toEqual(expect.arrayContaining(['--no-deps']))
    expect(installCalls[1][1]).not.toContain('--require-hashes')
    expect(calls.some(([_program, argv]) => argv[0] === 'pip' && argv[1] === 'check')).toBe(true)
  })

  it('materializes and smokes the pinned ASR model pack before activation', async () => {
    const bundle = makeBundle({ mediaAsr: true })
    const home = tempDir('vk-home-')
    const calls = []
    const logs = []
    const previousPackA = join(home, 'models', 'asr', 'previous-a', 'models')
    const previousPackB = join(home, 'models', 'asr', 'previous-b', 'models')
    const configuredCache = join(home, 'configured-modelscope-cache')
    mkdirSync(previousPackA, { recursive: true })
    mkdirSync(previousPackB, { recursive: true })
    const modelCache = join(home, 'models', 'asr', 'fixture', 'models')
    const spawnImpl = (program, argv, options) => {
      calls.push([program, argv, options])
      const child = new FakeChild()
      queueMicrotask(() => {
        if (argv.includes('gui')) child.stdout.write('gui=http://127.0.0.1:45678\n')
        else {
          if (argv.includes('video_knowledge.runtime_models')) {
            child.stdout.write(`VK_MODEL_PACK_RESULT=${JSON.stringify({
              ready: true, cache_root: modelCache, receipt: join(home, 'model-receipt.json'),
              reused: false, linked: 2, copied: 3, downloaded: 1,
            })}\n`)
          }
          if (argv.includes('video_knowledge.runtime_smoke')) {
            child.stdout.write(`VK_ASR_SMOKE_RESULT=${JSON.stringify({
              ready: true, transcript: '本地语音识别正常', ffmpeg: 'ffmpeg fixture',
            })}\n`)
          }
          if (argv.some((arg) => String(arg).includes('migrate'))) child.stdout.write('["008"]\n')
          if (argv.some((arg) => String(arg).includes('importlib.metadata'))) child.stdout.write('[]\n')
          child.emit('close', 0)
        }
      })
      return child
    }
    const result = await installVkRuntime({
      home,
      bundleDir: bundle,
      extras: ['media-asr'],
      spawnImpl,
      env: { ...process.env, MODELSCOPE_CACHE: configuredCache },
      log: (line) => logs.push(line),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, api_version: '1.4.0',
        processing_request_schema_version: '1.1.0',
        capabilities: [{ capability: 'local_transcription', runtime: 'ready' }],
      }) }),
    })
    const versionDir = join(home, 'runtime', 'versions', result.version)
    const receipt = JSON.parse(readFileSync(join(versionDir, 'runtime-receipt.json'), 'utf8'))

    expect(receipt.modelPacks).toEqual([expect.objectContaining({
      id: 'local-asr', cacheRoot: modelCache, reused: false,
      reusedFiles: 5, downloadedFiles: 1,
    })])
    expect(receipt.asrSmoke).toMatchObject({ ready: true, transcript: '本地语音识别正常' })
    expect(receipt.ffmpegVersion).toBe('ffmpeg fixture')
    const smokeCall = calls.find(([_program, argv]) => argv.includes('video_knowledge.runtime_smoke'))
    const modelCall = calls.find(([_program, argv]) => argv.includes('video_knowledge.runtime_models'))
    const guiCall = calls.find(([_program, argv]) => argv.includes('gui'))
    const legacyCacheArgs = modelCall[1].flatMap((arg, index, argv) => (
      arg === '--legacy-cache' ? [argv[index + 1]] : []
    ))
    expect(legacyCacheArgs).toEqual(expect.arrayContaining([configuredCache, previousPackA, previousPackB]))
    expect(modelCall[1].filter((arg) => arg === '--legacy-cache')).toHaveLength(legacyCacheArgs.length)
    expect(logs).toContain('models-asr: 校验完成 reused=5 downloaded=1')
    expect(smokeCall[2].env.MODELSCOPE_CACHE).toBe(modelCache)
    expect(guiCall[2].env.MODELSCOPE_CACHE).toBe(modelCache)
  })
})
