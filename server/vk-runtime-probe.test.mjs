// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverVkRuntimePaths, probeVkRuntime } from './vk-runtime-probe.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }
  kill() { this.emit('close', null, 'SIGKILL'); return true }
}

describe('runtime discovery and probe', () => {
  it('discovers only bounded owned/env/user-Python/developer venv candidates', () => {
    const userProfile = tempDir('vk-user-')
    const localAppData = join(userProfile, 'AppData', 'Local')
    const developer = join(userProfile, 'Developer', 'video-knowledge-m1', '.venv', 'Scripts')
    const userPython = join(localAppData, 'Programs', 'Python', 'Python312')
    const virtual = join(userProfile, 'virtual', 'Scripts')
    for (const dir of [developer, userPython, virtual]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'python.exe'), 'python')
    }
    const candidates = discoverVkRuntimePaths({
      home: join(localAppData, '爪爪-data'),
      env: { USERPROFILE: userProfile, LOCALAPPDATA: localAppData, VIRTUAL_ENV: join(userProfile, 'virtual') },
      allowExternalRuntime: true,
    })
    expect(candidates.map((item) => item.source).sort()).toEqual(['developer-venv', 'user-python', 'virtual-env'])
    expect(candidates.every((item) => item.pythonPath.endsWith('python.exe'))).toBe(true)

    expect(discoverVkRuntimePaths({
      home: join(localAppData, '爪爪-data'),
      env: { USERPROFILE: userProfile, LOCALAPPDATA: localAppData, VIRTUAL_ENV: join(userProfile, 'virtual') },
    })).toEqual([])
  })

  it('returns the public candidate contract and enforces API/schema minimums', async () => {
    const dir = tempDir('vk-probe-')
    const pythonPath = join(dir, 'python.exe')
    writeFileSync(pythonPath, 'python')
    const children = []
    const spawnImpl = () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.stdout.write('gui=http://127.0.0.1:45678\n'))
      return child
    }
    const compatible = await probeVkRuntime({
      pythonPath, source: 'virtual-env', spawnImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, package_version: '0.1.0',
        api_version: '1.4.0', processing_request_schema_version: '1.1.0',
        capabilities: [{ capability: 'query_ready', runtime: 'ready' }],
      }) }),
    })
    expect(compatible).toMatchObject({
      pythonPath, source: 'virtual-env', version: '0.1.0', apiVersion: '1.4.0',
      schemaVersion: '1.1.0', compatible: true, reason: null,
    })
    expect(compatible.capabilities).toHaveLength(1)
    expect(children[0].stderr.listenerCount('data')).toBeGreaterThan(0)

    const incompatible = await probeVkRuntime({
      pythonPath, source: 'virtual-env', spawnImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        service: 'video-knowledge', shell_mode: true, package_version: '0.1.0',
        api_version: '1.0.9', processing_request_schema_version: '1.1.0', capabilities: [],
      }) }),
    })
    expect(incompatible.compatible).toBe(false)
    expect(incompatible.reason).toBe('protocol-mismatch')
  })
})
