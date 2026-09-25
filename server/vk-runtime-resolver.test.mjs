// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECEIPT_FILE,
  ownedRuntimeSizeBytes,
  ownedRuntimeSizeBytesAsync,
  pruneInvalidOwnedRuntimeDirs,
  removeOwnedRuntimeReceipt,
  removeOwnedRuntimeReceiptAsync,
  resolveActiveRuntime,
  writeActiveRuntime,
  writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'
import { runtimeContractFingerprint } from './vk-runtime-contract.mjs'

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function bundle(sha = 'a'.repeat(64)) {
  const dir = tempDir('vk-bundle-')
  writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify({
    wheel: { name: 'video_knowledge-0.1.0-py3-none-any.whl', sha256: sha },
    uv: { name: 'uv.exe', sha256: 'b'.repeat(64) },
  }))
  return dir
}

function contractBundle() {
  const dir = tempDir('vk-bundle-v2-')
  const manifest = {
    schema: 'vk-runtime-bundle@2',
    source: { pythonLockSha256: 'c'.repeat(64) },
    wheel: { name: 'video_knowledge-0.1.0-py3-none-any.whl', sha256: 'a'.repeat(64) },
    uv: { name: 'uv.exe', sha256: 'b'.repeat(64) },
    runtime: {
      contractSchema: 'vk-runtime-contract@1',
      pythonImplementation: 'cpython', pythonVersion: '3.12', pythonAbi: 'cp312',
      platform: 'x86_64-pc-windows-msvc',
      requirements: [{
        key: 'base', extras: [], name: 'requirements-base.txt', sha256: 'd'.repeat(64),
      }],
    },
  }
  writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify(manifest))
  return { dir, manifest }
}

function owned(home, { version = 'v1', sha = 'a'.repeat(64), installedAt = '2026-08-01T00:00:00Z' } = {}) {
  const dir = join(home, 'runtime', 'versions', version)
  const pythonPath = join(dir, 'Scripts', 'python.exe')
  mkdirSync(join(dir, 'Scripts'), { recursive: true })
  writeFileSync(pythonPath, 'python')
  const receipt = {
    schema: 'vk-runtime-receipt@1', source: 'app-owned', version, pythonPath,
    wheelSha256: sha, apiVersion: '1.4.0', schemaVersion: '1.1.0',
    capabilities: [], extras: [], installedAt,
  }
  writeRuntimeReceipt(home, receipt)
  return { dir, pythonPath, receipt }
}

describe('runtime resolver', () => {
  it('rejects active pointers outside the owned root or without a matching receipt', () => {
    const home = tempDir('vk-home-')
    const bundleDir = bundle()
    const outside = join(tempDir('outside-'), 'python.exe')
    writeFileSync(outside, 'python')
    mkdirSync(join(home, 'runtime'), { recursive: true })
    writeFileSync(join(home, 'runtime', 'active.json'), JSON.stringify({
      source: 'app-owned', version: 'v1', pythonPath: outside,
    }))
    expect(resolveActiveRuntime({ home, bundleDir, repair: false })).toBeNull()

    const candidate = owned(home)
    rmSync(join(candidate.dir, RECEIPT_FILE))
    writeActiveRuntime(home, candidate.receipt)
    expect(resolveActiveRuntime({ home, bundleDir, repair: false })).toBeNull()
  })

  it('recovers a missing active pointer from the newest valid owned receipt', () => {
    const home = tempDir('vk-home-')
    const bundleDir = bundle()
    owned(home, { version: 'older', installedAt: '2026-08-01T00:00:00Z' })
    const latest = owned(home, { version: 'latest', installedAt: '2026-08-02T00:00:00Z' })

    const active = resolveActiveRuntime({ home, bundleDir })
    expect(active).toMatchObject({ source: 'app-owned', version: 'latest', pythonPath: latest.pythonPath })
    expect(existsSync(join(home, 'runtime', 'active.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'runtime', 'active.json'), 'utf8')).version).toBe('latest')
  })

  it('accepts an explicitly marked external runtime whose receipt stays under app data', () => {
    const home = tempDir('vk-home-')
    const externalRoot = tempDir('vk-external-')
    const pythonPath = resolve(externalRoot, 'Scripts', 'python.exe')
    mkdirSync(resolve(externalRoot, 'Scripts'), { recursive: true })
    writeFileSync(pythonPath, 'python')
    const receipt = {
      schema: 'vk-runtime-receipt@1', source: 'external', version: '0.1.0', pythonPath,
      apiVersion: '1.4.0', schemaVersion: '1.1.0', capabilities: [],
      adoptedAt: '2026-08-02T00:00:00Z',
    }
    const withReceipt = writeRuntimeReceipt(home, receipt)
    writeActiveRuntime(home, withReceipt)

    expect(resolveActiveRuntime({ home, bundleDir: bundle(), repair: false })).toMatchObject({
      source: 'external', pythonPath,
    })

    writeRuntimeReceipt(home, { ...receipt, apiVersion: '1.0.9' })
    expect(resolveActiveRuntime({ home, bundleDir: bundle(), repair: false })).toBeNull()
  })

  it('keeps a valid v1 active runtime usable when a newer bundle is installed', () => {
    const home = tempDir('vk-home-')
    const candidate = owned(home, { version: 'known-good', sha: '9'.repeat(64) })
    writeActiveRuntime(home, candidate.receipt)
    const { dir } = contractBundle()

    expect(resolveActiveRuntime({ home, bundleDir: dir, repair: false })).toMatchObject({
      version: 'known-good',
      current: false,
      legacyUnreproducible: true,
    })
  })

  it('marks a v2 receipt current only when its inventory and fingerprint match the bundle', () => {
    const home = tempDir('vk-home-')
    const { dir: bundleDir, manifest } = contractBundle()
    const versionDir = join(home, 'runtime', 'versions', 'current')
    const pythonPath = join(versionDir, 'Scripts', 'python.exe')
    mkdirSync(join(versionDir, 'Scripts'), { recursive: true })
    writeFileSync(pythonPath, 'python')
    const runtimeFingerprint = runtimeContractFingerprint(manifest, [])
    writeFileSync(join(versionDir, 'runtime-inventory.json'), JSON.stringify({
      schema: 'vk-runtime-inventory@1', runtimeFingerprint,
      packageInventorySha256: 'e'.repeat(64), pipCheck: { status: 'passed' },
    }))
    const receipt = writeRuntimeReceipt(home, {
      schema: 'vk-runtime-receipt@2', source: 'app-owned', version: 'current', pythonPath,
      wheelSha256: manifest.wheel.sha256, uvSha256: manifest.uv.sha256,
      pythonLockSha256: manifest.source.pythonLockSha256,
      requirements: 'requirements-base.txt', requirementsSha256: 'd'.repeat(64),
      runtimeFingerprint, packageInventory: 'runtime-inventory.json',
      packageInventorySha256: 'e'.repeat(64), pipCheck: 'passed', extras: [],
      apiVersion: '1.4.0', schemaVersion: '1.1.0', installedAt: '2026-08-14T00:00:00Z',
    })
    writeActiveRuntime(home, receipt)

    expect(resolveActiveRuntime({ home, bundleDir, repair: false })).toMatchObject({
      version: 'current', current: true, legacyUnreproducible: false,
    })
  })

  it('never removes the active directory and removes only a validated sibling version', () => {
    const home = tempDir('vk-home-')
    const active = owned(home, { version: 'active' })
    const stale = owned(home, { version: 'stale' })
    const activeReceipt = writeRuntimeReceipt(home, active.receipt)
    const staleReceipt = writeRuntimeReceipt(home, stale.receipt)
    writeActiveRuntime(home, activeReceipt)

    expect(() => removeOwnedRuntimeReceipt({ home, runtime: activeReceipt }))
      .toThrow('活动 runtime 不允许清理')
    expect(removeOwnedRuntimeReceipt({ home, runtime: staleReceipt }))
      .toMatchObject({ version: 'stale', sizeBytes: expect.any(Number) })
    expect(existsSync(active.dir)).toBe(true)
    expect(existsSync(stale.dir)).toBe(false)
  })

  it('asynchronously removes only a validated inactive owned runtime', async () => {
    const home = tempDir('vk-home-')
    const active = owned(home, { version: 'active-async' })
    const stale = owned(home, { version: 'stale-async' })
    const activeReceipt = writeRuntimeReceipt(home, active.receipt)
    const staleReceipt = writeRuntimeReceipt(home, stale.receipt)
    writeActiveRuntime(home, activeReceipt)

    await expect(removeOwnedRuntimeReceiptAsync({ home, runtime: activeReceipt }))
      .rejects.toThrow('活动 runtime 不允许清理')
    await expect(removeOwnedRuntimeReceiptAsync({ home, runtime: staleReceipt }))
      .resolves.toEqual({ version: 'stale-async' })
    expect(existsSync(active.dir)).toBe(true)
    expect(existsSync(stale.dir)).toBe(false)
  })

  it('prunes invalid direct version directories while preserving valid and raw active directories', async () => {
    const home = tempDir('vk-home-')
    const valid = [
      owned(home, { version: 'valid-1' }),
      owned(home, { version: 'valid-2' }),
      owned(home, { version: 'valid-3' }),
    ]
    const invalid = owned(home, { version: 'invalid-receipt' })
    writeFileSync(join(invalid.dir, RECEIPT_FILE), '{broken')
    const interrupted = join(home, 'runtime', 'versions', 'interrupted')
    mkdirSync(interrupted, { recursive: true })
    writeFileSync(join(interrupted, 'partial.bin'), 'partial')
    const activeInvalid = owned(home, { version: 'active-invalid' })
    const activeReceipt = writeRuntimeReceipt(home, activeInvalid.receipt)
    writeActiveRuntime(home, activeReceipt)
    writeFileSync(join(activeInvalid.dir, RECEIPT_FILE), '{broken')

    const result = await pruneInvalidOwnedRuntimeDirs({ home, bundleDir: bundle() })

    expect(result.failures).toEqual([])
    expect(result.removed).toEqual(expect.arrayContaining([invalid.dir, interrupted]))
    for (const candidate of valid) expect(existsSync(candidate.dir)).toBe(true)
    expect(existsSync(invalid.dir)).toBe(false)
    expect(existsSync(interrupted)).toBe(false)
    expect(existsSync(activeInvalid.dir)).toBe(true)
  })

  it('continues pruning invalid directories after one asynchronous removal fails', async () => {
    const home = tempDir('vk-home-')
    const versions = join(home, 'runtime', 'versions')
    const first = join(versions, 'invalid-a')
    const second = join(versions, 'invalid-b')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const calls = []

    const result = await pruneInvalidOwnedRuntimeDirs({
      home,
      removeDirImpl: async (dir) => {
        calls.push(dir)
        if (calls.length === 1) throw new Error('directory busy')
        rmSync(dir, { recursive: true, force: false })
      },
    })

    expect(calls).toHaveLength(2)
    expect(result.failures).toEqual([expect.objectContaining({ error: 'directory busy' })])
    expect(existsSync(calls[0])).toBe(true)
    expect(existsSync(calls[1])).toBe(false)
  })

  it('asynchronously scans legacy runtime sizes without changing the reported total', async () => {
    const home = tempDir('vk-home-')
    const candidate = owned(home, { version: 'legacy-size' })
    writeFileSync(join(candidate.dir, 'payload.bin'), 'legacy-payload')

    expect(await ownedRuntimeSizeBytesAsync({ home, runtime: candidate.receipt }))
      .toBe(ownedRuntimeSizeBytes({ home, runtime: candidate.receipt }))
  })
})
