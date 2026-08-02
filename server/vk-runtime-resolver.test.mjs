// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECEIPT_FILE,
  resolveActiveRuntime,
  writeActiveRuntime,
  writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'

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
})
