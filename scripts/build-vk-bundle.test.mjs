// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildVkBundle, collectBundleSource } from './build-vk-bundle.mjs'

const temporaryDirectories = []

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function makeRepo(prefix, files) {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'vk-bundle-test@local.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'vk bundle test'], { cwd: repo })
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(repo, relativePath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo })
  return repo
}

function commit(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
  }
})

describe('build-vk-bundle provenance', () => {
  it('rejects tracked or untracked changes in the Python source', () => {
    const pythonRepo = makeRepo('vk-python-dirty-', { 'uv.lock': 'python-lock\n' })
    const pussyCatRepo = makeRepo('vk-pussycat-clean-', { 'package-lock.json': 'app-lock\n' })
    writeFileSync(join(pythonRepo, 'untracked.txt'), 'dirty')

    expect(() => collectBundleSource({
      pythonSourceDir: pythonRepo,
      pussyCatRoot: pussyCatRepo,
    })).toThrow(/Python source is dirty/)
  })

  it('rejects tracked or untracked changes in the PussyCat source', () => {
    const pythonRepo = makeRepo('vk-python-clean-', { 'uv.lock': 'python-lock\n' })
    const pussyCatRepo = makeRepo('vk-pussycat-dirty-', { 'package-lock.json': 'app-lock\n' })
    writeFileSync(join(pussyCatRepo, 'untracked.txt'), 'dirty')

    expect(() => collectBundleSource({
      pythonSourceDir: pythonRepo,
      pussyCatRoot: pussyCatRepo,
    })).toThrow(/PussyCat source is dirty/)
  })

  it('records source commits and lock/bundle hashes in the runtime manifest', () => {
    const pythonLock = 'python-lock\n'
    const pussyCatLock = 'app-lock\n'
    const wheelContent = 'fake-wheel'
    const modelManifest = '{"schema":"fixture"}\n'
    const smokeAudio = 'fixture-wave'
    const pythonRepo = makeRepo('vk-python-clean-', {
      'uv.lock': pythonLock,
      'src/video_knowledge/resources/asr-model-pack.json': modelManifest,
      'src/video_knowledge/resources/runtime-asr-smoke.wav': smokeAudio,
    })
    const pussyCatRepo = makeRepo('vk-pussycat-manifest-', { 'package-lock.json': pussyCatLock })
    const bundleFiles = mkdtempSync(join(tmpdir(), 'vk-bundle-files-'))
    temporaryDirectories.push(bundleFiles)
    const wheelPath = join(bundleFiles, 'video_knowledge-0.1.0-py3-none-any.whl')
    const outDir = join(bundleFiles, 'bundle-output')
    writeFileSync(wheelPath, wheelContent)

    const manifest = buildVkBundle({
      root: pussyCatRepo,
      pythonSourceDir: pythonRepo,
      wheelPath,
      uvPath: process.execPath,
      outDir,
      requirementsExporter: ({ extras }) => `profile=${extras.join('+') || 'base'}\n`,
    })
    const fromDisk = JSON.parse(readFileSync(join(outDir, 'runtime-manifest.json'), 'utf8'))

    expect(fromDisk).toEqual(manifest)
    expect(manifest.source).toEqual({
      pythonCommit: commit(pythonRepo),
      pythonDirty: false,
      pythonLockSha256: sha256(pythonLock),
      pussyCatCommit: commit(pussyCatRepo),
      pussyCatDirty: false,
      pussyCatLockSha256: sha256(pussyCatLock),
    })
    expect(manifest.wheel.sha256).toBe(sha256(wheelContent))
    expect(manifest.uv.sha256).toBe(sha256(readFileSync(process.execPath)))
    expect(manifest).toMatchObject({
      schema: 'vk-runtime-bundle@2',
      runtime: {
        contractSchema: 'vk-runtime-contract@1',
        pythonImplementation: 'cpython',
        pythonVersion: '3.12',
        pythonAbi: 'cp312',
        platform: 'x86_64-pc-windows-msvc',
      },
    })
    expect(manifest.runtime.requirements).toHaveLength(8)
    for (const requirements of manifest.runtime.requirements) {
      expect(requirements.sha256).toBe(sha256(readFileSync(join(outDir, requirements.name))))
    }
    expect(manifest.runtime.modelPacks).toEqual([{
      id: 'local-asr',
      requiredExtra: 'media-asr',
      manifest: 'asr-model-pack.json',
      manifestSha256: sha256(modelManifest),
      smoke: 'runtime-asr-smoke.wav',
      smokeSha256: sha256(smokeAudio),
    }])
  })
})
