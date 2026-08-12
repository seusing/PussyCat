// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areStampArtifactsCurrent,
  createPackageStamp,
  stampArtifactPaths,
} from './package-app.mjs'

let temporaryDirectory

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('package stamp provenance', () => {
  it('embeds the bundle source and hashes every manifest, lock and artifact', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'package-stamp-'))
    const source = {
      pythonCommit: 'python-commit',
      pythonDirty: false,
      pythonLockSha256: 'python-lock-sha',
      pussyCatCommit: 'pussycat-commit',
      pussyCatLockSha256: 'manifest-lock-sha',
    }
    const manifestContent = `${JSON.stringify({ source })}\n`
    const lockContent = 'actual-package-lock'
    const artifactContent = 'installer-binary'
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json')
    const lockPath = join(temporaryDirectory, 'package-lock.json')
    const artifactPath = join(temporaryDirectory, 'PussyCat_setup.exe')
    writeFileSync(manifestPath, manifestContent)
    writeFileSync(lockPath, lockContent)
    writeFileSync(artifactPath, artifactContent)

    const stamp = createPackageStamp({
      name: 'PussyCat',
      source: { identity: 'app-source', commit: 'app-commit', dirty: false },
      startedAt: 1_700_000_000_000,
      fresh: [artifactPath],
      treeChangedDuringBuild: false,
      headAfter: 'unused',
      vkManifestPath: manifestPath,
      pussyCatLockPath: lockPath,
    })

    expect(stamp.videoKnowledgeSource).toEqual(source)
    expect(stamp.vkBundleManifestSha256).toBe(sha256(manifestContent))
    expect(stamp.pussyCatLockSha256).toBe(sha256(lockContent))
    expect(stamp.artifacts).toEqual([{ path: artifactPath, sha256: sha256(artifactContent) }])
  })

  it('reads artifact paths from both legacy and provenance-aware stamps', () => {
    expect(stampArtifactPaths({ artifacts: ['old.exe', { path: 'new.msi', sha256: 'sha' }] }))
      .toEqual(['old.exe', 'new.msi'])
  })

  it('accepts a provenance-aware artifact only while its path and hash match', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'package-artifact-check-'))
    const artifactPath = join(temporaryDirectory, 'PussyCat_setup.exe')
    writeFileSync(artifactPath, 'original-installer')
    const stamp = {
      artifacts: [{ path: artifactPath, sha256: sha256('original-installer') }],
    }

    expect(areStampArtifactsCurrent(stamp, [artifactPath])).toBe(true)

    writeFileSync(artifactPath, 'tampered-installer')
    expect(areStampArtifactsCurrent(stamp, [artifactPath])).toBe(false)
    expect(areStampArtifactsCurrent(stamp, [])).toBe(false)
  })

  it('keeps legacy string artifacts compatible by checking their path only', () => {
    expect(areStampArtifactsCurrent({ artifacts: ['legacy.exe'] }, ['legacy.exe'])).toBe(true)
    expect(areStampArtifactsCurrent({ artifacts: ['legacy.exe'] }, [])).toBe(false)
  })
})
