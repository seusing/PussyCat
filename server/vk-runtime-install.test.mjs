// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

function makeBundle({ corruptWheelSha = false } = {}) {
  const bundle = tempDir('vk-bundle-')
  const wheel = join(bundle, 'video_knowledge-0.1.0-py3-none-any.whl')
  const uv = join(bundle, 'uv.exe')
  writeFileSync(wheel, 'wheel-bytes')
  writeFileSync(uv, 'uv-bytes')
  writeFileSync(join(bundle, 'runtime-manifest.json'), JSON.stringify({
    wheel: {
      name: 'video_knowledge-0.1.0-py3-none-any.whl',
      sha256: corruptWheelSha ? 'f'.repeat(64) : sha256File(wheel),
    },
    uv: { name: 'uv.exe', sha256: sha256File(uv) },
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
      schema: 'vk-runtime-receipt@1', source: 'app-owned', version: result.version,
      apiVersion: '1.4.0', schemaVersion: '1.1.0',
    })
    expect(active).toMatchObject({ source: 'app-owned', receiptPath: join(versionDir, 'runtime-receipt.json') })
  })
})
