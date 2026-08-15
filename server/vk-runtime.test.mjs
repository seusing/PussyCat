// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VkRuntimeManager } from './vk-runtime.mjs'
import { writeActiveRuntime, writeRuntimeReceipt } from './vk-runtime-resolver.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function bundleDir() {
  const dir = tempDir('vk-bundle-')
  writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify({
    schema: 'vk-runtime-bundle@1',
    wheel: { name: 'fixture.whl', sha256: 'a'.repeat(64) },
    uv: { name: 'uv.exe', sha256: 'b'.repeat(64) },
  }))
  return dir
}

function ownedRuntime(home, version, installedAt) {
  const versionDir = join(home, 'runtime', 'versions', version)
  const pythonPath = join(versionDir, 'Scripts', 'python.exe')
  mkdirSync(join(versionDir, 'Scripts'), { recursive: true })
  writeFileSync(pythonPath, `python-${version}`)
  writeFileSync(join(versionDir, 'payload.bin'), version.repeat(16))
  return writeRuntimeReceipt(home, {
    schema: 'vk-runtime-receipt@1', source: 'app-owned', version, pythonPath,
    wheelSha256: 'a'.repeat(64), apiVersion: '1.4.0', schemaVersion: '1.1.0',
    capabilities: [], extras: [], installedAt,
  })
}

describe('VkRuntimeManager', () => {
  it('已装状态下 install() 不带 rebuild 是幂等的 —— 但带上就必须真重建', async () => {
    // 这条钉的是一个真实 bug:界面上那个按钮只在已装时才显示成「重建」,而 install()
    // 在已装时直接静默返回。按钮没禁用、没变灰,点了就是没反应。
    const home = tempDir('vk-home-')
    let installs = 0
    const stopped = []
    const manager = new VkRuntimeManager({
      home,
      bundleDir: bundleDir(),
      installImpl: async () => {
        installs += 1
        const python = join(home, 'runtime', 'versions', 'v1', 'Scripts', 'python.exe')
        mkdirSync(join(home, 'runtime', 'versions', 'v1', 'Scripts'), { recursive: true })
        writeFileSync(python, 'stub')
        writeActiveRuntime(home, writeRuntimeReceipt(home, {
          schema: 'vk-runtime-receipt@1', source: 'app-owned', version: 'v1', pythonPath: python,
          wheelSha256: 'a'.repeat(64), apiVersion: '1.4.0', schemaVersion: '1.1.0',
          capabilities: [], extras: [], installedAt: '2026-08-02T00:00:00Z',
        }))
        return { version: 'v1', pythonPath: python }
      },
    })

    await manager.install()
    expect(installs).toBe(1)

    await manager.install()                       // 幂等:不重装
    expect(installs).toBe(1)

    await manager.install({ rebuild: true, beforeRebuild: async () => { stopped.push('sidecar') } })
    expect(installs).toBe(2)                      // 真的重建了
    // 重建要删版本目录,Windows 上跑着的 python.exe 会锁住它 —— 必须先停 sidecar。
    expect(stopped).toEqual(['sidecar'])
  })

  it('无捆绑件 → not-available(bundle-missing)', () => {
    const manager = new VkRuntimeManager({ home: tempDir('vk-home-'), bundleDir: undefined })
    expect(manager.status()).toMatchObject({ state: 'not-available', reasonCode: 'bundle-missing' })
  })

  it('有捆绑件无 active → not-installed;安装成功后 installed(读 active 指针)', async () => {
    const home = tempDir('vk-home-')
    const manager = new VkRuntimeManager({
      home,
      bundleDir: bundleDir(),
      installImpl: async ({ log }) => {
        log('step one')
        const python = join(home, 'runtime', 'versions', 'v1', 'Scripts', 'python.exe')
        mkdirSync(join(home, 'runtime', 'versions', 'v1', 'Scripts'), { recursive: true })
        writeFileSync(python, 'stub')
        const receipt = writeRuntimeReceipt(home, {
          schema: 'vk-runtime-receipt@1', source: 'app-owned', version: 'v1', pythonPath: python,
          wheelSha256: 'a'.repeat(64), apiVersion: '1.4.0', schemaVersion: '1.1.0',
          capabilities: [], extras: [], installedAt: '2026-08-02T00:00:00Z',
        })
        writeActiveRuntime(home, receipt)
        return { version: 'v1', pythonPath: python }
      },
    })
    expect(manager.status().state).toBe('not-installed')
    await manager.install()
    const status = manager.status()
    expect(status.state).toBe('installed')
    expect(status.version).toBe('v1')
    expect(status).toMatchObject({
      source: 'app-owned', pythonPath: expect.stringContaining('python.exe'),
      capabilities: [], extras: [],
    })
    expect(status.log).toContain('step one')
  })

  it('安装失败 → failed(带 reasonCode 与日志),可重试;单飞不并发', async () => {
    let calls = 0
    let release
    const gate = new Promise((resolveGate) => { release = resolveGate })
    const manager = new VkRuntimeManager({
      home: tempDir('vk-home-'),
      bundleDir: bundleDir(),
      installImpl: async ({ log }) => {
        calls += 1
        log('trying')
        await gate
        const error = new Error('磁盘可用空间不足')
        error.reasonCode = 'disk'
        throw error
      },
    })
    const first = manager.install().catch((err) => err)
    const second = manager.install().catch((err) => err)   // 单飞:共享同一次
    expect(manager.status().state).toBe('installing')
    release()
    await first
    await second
    expect(calls).toBe(1)
    const status = manager.status()
    expect(status.state).toBe('failed')
    expect(status.reasonCode).toBe('disk')
    expect(status.log).toContain('trying')
  })

  it('能力升级失败时保留旧 active 为可用状态', async () => {
    const home = tempDir('vk-home-')
    const python = join(home, 'runtime', 'versions', 'v1', 'Scripts', 'python.exe')
    mkdirSync(join(home, 'runtime', 'versions', 'v1', 'Scripts'), { recursive: true })
    writeFileSync(python, 'stub')
    const receipt = writeRuntimeReceipt(home, {
      schema: 'vk-runtime-receipt@1', source: 'app-owned', version: 'v1', pythonPath: python,
      wheelSha256: 'a'.repeat(64), capabilities: [], extras: ['media-asr'],
      installedAt: '2026-08-02T00:00:00Z',
    })
    writeActiveRuntime(home, receipt)
    const manager = new VkRuntimeManager({
      home,
      bundleDir: bundleDir(),
      installImpl: async () => {
        const error = new Error('ASR smoke 未通过')
        error.reasonCode = 'smoke-asr'
        throw error
      },
    })

    await expect(manager.install({ rebuild: true })).rejects.toThrow('ASR smoke 未通过')
    expect(manager.status()).toMatchObject({
      state: 'installed',
      version: 'v1',
      reasonCode: null,
      summary: expect.stringContaining('现有解析引擎仍可使用'),
      lastInstallFailure: { reasonCode: 'smoke-asr', summary: 'ASR smoke 未通过' },
    })
  })

  it('安装进行中拒绝 adopt，防止两个流程竞写 active 指针', async () => {
    let release
    const gate = new Promise((resolveGate) => { release = resolveGate })
    const pythonPath = 'C:\\fixture\\developer\\.venv\\Scripts\\python.exe'
    const manager = new VkRuntimeManager({
      home: tempDir('vk-home-'), bundleDir: bundleDir(),
      env: { OPENCLI_HOST_VK_ALLOW_EXTERNAL_RUNTIME: '1' },
      installImpl: async () => { await gate },
      discoverImpl: () => [{ pythonPath, source: 'developer-venv' }],
      probeImpl: async ({ source }) => ({
        pythonPath, source, version: '0.1.0', apiVersion: '1.4.0', schemaVersion: '1.1.0',
        capabilities: [], compatible: true, reason: null,
      }),
    })
    await manager.detect()
    const installing = manager.install()
    const error = await manager.adopt(pythonPath).catch((item) => item)
    expect(error).toMatchObject({ statusCode: 409, reasonCode: 'runtime-busy' })
    release()
    await installing
  })

  it('检测标出当前环境，切回 app-owned 时保留其来源而非伪装成 external', async () => {
    const home = tempDir('vk-home-')
    const bundle = bundleDir()
    const ownedPython = join(home, 'runtime', 'versions', 'v1', 'Scripts', 'python.exe')
    mkdirSync(join(home, 'runtime', 'versions', 'v1', 'Scripts'), { recursive: true })
    writeFileSync(ownedPython, 'stub')
    const owned = writeRuntimeReceipt(home, {
      schema: 'vk-runtime-receipt@1', source: 'app-owned', version: 'v1', pythonPath: ownedPython,
      wheelSha256: 'a'.repeat(64), apiVersion: '1.4.0', schemaVersion: '1.1.0',
      capabilities: [], extras: [], installedAt: '2026-08-02T00:00:00Z',
    })
    writeActiveRuntime(home, owned)
    const manager = new VkRuntimeManager({
      home,
      bundleDir: bundle,
      discoverImpl: () => [{ pythonPath: ownedPython, source: 'app-owned' }],
      probeImpl: async ({ source }) => ({
        pythonPath: ownedPython, source, version: 'v1', apiVersion: '1.4.0',
        schemaVersion: '1.1.0', capabilities: [], compatible: true, reason: null,
      }),
    })
    const detected = await manager.detect()
    expect(detected.candidates[0]).toMatchObject({ active: true, source: 'app-owned' })
    await manager.adopt(ownedPython)
    expect(manager.status()).toMatchObject({ source: 'app-owned', pythonPath: ownedPython })
  })

  it('生产模式不发现也不接管外部 runtime', async () => {
    const pythonPath = 'C:\\fixture\\developer\\.venv\\Scripts\\python.exe'
    const manager = new VkRuntimeManager({
      home: tempDir('vk-home-'), bundleDir: bundleDir(), env: {},
      discoverImpl: () => [{ pythonPath, source: 'developer-venv' }],
      probeImpl: async () => ({
        pythonPath, source: 'developer-venv', compatible: true,
        apiVersion: '1.4.0', schemaVersion: '1.1.0', capabilities: [],
      }),
    })

    expect((await manager.detect()).candidates).toEqual([])
    const error = await manager.adopt(pythonPath).catch((item) => item)
    expect(error).toMatchObject({ statusCode: 400, reasonCode: 'candidate-not-detected' })
  })

  it('lists sizes, rolls back atomically, and cleans all but active plus one fallback', async () => {
    const home = tempDir('vk-home-')
    const first = ownedRuntime(home, 'v1', '2026-08-01T00:00:00Z')
    const second = ownedRuntime(home, 'v2', '2026-08-02T00:00:00Z')
    const third = ownedRuntime(home, 'v3', '2026-08-03T00:00:00Z')
    writeActiveRuntime(home, third)
    const manager = new VkRuntimeManager({ home, bundleDir: bundleDir() })

    expect((await manager.versions()).versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 'v3', active: true, removable: false }),
      expect.objectContaining({ version: 'v2', retainedForRollback: true, removable: false }),
      expect.objectContaining({ version: 'v1', removable: true, sizeBytes: expect.any(Number) }),
    ]))

    const stoppedAfterSwitch = []
    const rolledBack = await manager.rollback('v1', {
      afterActivate: async () => { stoppedAfterSwitch.push(manager.status().version) },
    })
    expect(rolledBack.version).toBe('v1')
    expect(stoppedAfterSwitch).toEqual(['v1'])

    const cleaned = await manager.cleanup()
    expect(cleaned.removed).toEqual([expect.objectContaining({ version: 'v2' })])
    expect(cleaned.reclaimedBytes).toBeGreaterThan(0)
    expect(existsSync(join(home, 'runtime', 'versions', 'v1'))).toBe(true)
    expect(existsSync(join(home, 'runtime', 'versions', 'v3'))).toBe(true)
    expect(existsSync(join(home, 'runtime', 'versions', 'v2'))).toBe(false)
    expect(first.version).toBe('v1')
    expect(second.version).toBe('v2')
  })

  it('rejects rollback to an unknown or invalid runtime receipt', async () => {
    const manager = new VkRuntimeManager({ home: tempDir('vk-home-'), bundleDir: bundleDir() })
    const error = await manager.rollback('missing').catch((item) => item)
    expect(error).toMatchObject({ statusCode: 404, reasonCode: 'runtime-version-not-found' })
  })

  it('uses the installed receipt size instead of rescanning a current runtime', async () => {
    const home = tempDir('vk-home-')
    const original = ownedRuntime(home, 'sized', '2026-08-03T00:00:00Z')
    const sized = writeRuntimeReceipt(home, { ...original, runtimeSizeBytes: 123_456 })
    writeActiveRuntime(home, sized)
    const manager = new VkRuntimeManager({ home, bundleDir: bundleDir() })

    expect((await manager.versions()).versions).toEqual([
      expect.objectContaining({ version: 'sized', sizeBytes: 123_456 }),
    ])
  })
})
