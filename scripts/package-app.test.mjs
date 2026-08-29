// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areStampArtifactsCurrent,
  createPackageStamp,
  describeVkManifestDrift,
  isVkBundleManifestCurrent,
  readPythonSource,
  stampArtifactPaths,
} from './package-app.mjs'

let temporaryDirectory
const repositories = []

/** 与 build-vk-bundle 写进 manifest.source 的 Python 三字段同形。commit 用真实长度的 SHA:
 *  报错文案要 slice(0, 12),短字符串会让断言测不到截断后的样子。 */
const PYTHON_SOURCE = {
  pythonCommit: '0773898580000000000000000000000000000000',
  pythonDirty: false,
  pythonLockSha256: 'python-lock-sha',
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** build-vk-bundle 产出的 manifest 形状,只保留 drift 检查看得见的那部分。 */
function manifestFor(source) {
  return `${JSON.stringify({ schema: 'vk-runtime-bundle@2', source }, null, 2)}\n`
}

function makeRepo(prefix, files) {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  repositories.push(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'package-app-test@local.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'package app test'], { cwd: repo })
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(repo, relativePath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo })
  return repo
}

function headOf(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
  while (repositories.length > 0) {
    rmSync(repositories.pop(), { recursive: true, force: true })
  }
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

  it('accepts the VK bundle manifest only while its bytes match the package stamp', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'package-manifest-check-'))
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json')
    const manifestContent = manifestFor(PYTHON_SOURCE)
    writeFileSync(manifestPath, manifestContent)
    const stamp = { vkBundleManifestSha256: sha256(manifestContent) }

    expect(isVkBundleManifestCurrent(stamp, manifestPath, PYTHON_SOURCE)).toBe(true)

    writeFileSync(manifestPath, `${manifestContent} `)
    expect(isVkBundleManifestCurrent(stamp, manifestPath, PYTHON_SOURCE)).toBe(false)
  })

  it('treats a legacy stamp without a VK bundle manifest hash as stale', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'package-manifest-legacy-'))
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json')
    writeFileSync(manifestPath, manifestFor(PYTHON_SOURCE))

    expect(isVkBundleManifestCurrent({}, manifestPath, PYTHON_SOURCE)).toBe(false)
  })

  // 第 5 类陈旧:Python 引擎在另一个仓库,它一动本仓的 stamp 哈希一个字节都不会变。
  it('rejects a byte-identical manifest once the Python source has moved on', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'package-manifest-python-'))
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json')
    const manifestContent = manifestFor(PYTHON_SOURCE)
    writeFileSync(manifestPath, manifestContent)
    const stamp = { vkBundleManifestSha256: sha256(manifestContent) }

    expect(isVkBundleManifestCurrent(stamp, manifestPath, PYTHON_SOURCE)).toBe(true)
    expect(isVkBundleManifestCurrent(
      stamp,
      manifestPath,
      { ...PYTHON_SOURCE, pythonCommit: 'feedfacefeedfacefeedfacefeedfacefeedface' },
    )).toBe(false)
  })
})

describe('VK bundle manifest drift', () => {
  function manifestPathWith(prefix, source) {
    temporaryDirectory = mkdtempSync(join(tmpdir(), prefix))
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json')
    writeFileSync(manifestPath, manifestFor(source))
    return manifestPath
  }

  it('agrees when the manifest matches the live Python source', () => {
    const manifestPath = manifestPathWith('vk-drift-agree-', PYTHON_SOURCE)

    expect(describeVkManifestDrift(PYTHON_SOURCE, manifestPath)).toBeUndefined()
  })

  it('names both commits when the Python source has moved on', () => {
    const manifestPath = manifestPathWith('vk-drift-commit-', PYTHON_SOURCE)

    const drift = describeVkManifestDrift(
      { ...PYTHON_SOURCE, pythonCommit: 'feedfacefeedfacefeedfacefeedfacefeedface' },
      manifestPath,
    )
    expect(drift).toContain('077389858000')
    expect(drift).toContain('feedfacefeed')
  })

  it('reports drift when only the Python lock changed', () => {
    const manifestPath = manifestPathWith('vk-drift-lock-', PYTHON_SOURCE)

    expect(describeVkManifestDrift(
      { ...PYTHON_SOURCE, pythonLockSha256: 'other-lock-sha' },
      manifestPath,
    )).toMatch(/uv\.lock/)
  })

  it('refuses a dirty Python working tree — a bundle can only come from a clean commit', () => {
    const manifestPath = manifestPathWith('vk-drift-dirty-', PYTHON_SOURCE)

    expect(describeVkManifestDrift({ ...PYTHON_SOURCE, pythonDirty: true }, manifestPath))
      .toMatch(/未提交改动/)
  })

  it('reports a manifest that was itself built from a dirty Python tree', () => {
    const manifestPath = manifestPathWith(
      'vk-drift-dirty-manifest-',
      { ...PYTHON_SOURCE, pythonDirty: true },
    )

    expect(describeVkManifestDrift(PYTHON_SOURCE, manifestPath)).toMatch(/脏的 Python 工作区/)
  })

  it('reports a missing bundle rather than throwing', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'vk-drift-missing-'))

    expect(describeVkManifestDrift(PYTHON_SOURCE, join(temporaryDirectory, 'absent.json')))
      .toMatch(/从未构建过/)
  })

  it('rejects a manifest with no source provenance and one that is not JSON', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'vk-drift-malformed-'))
    const legacyPath = join(temporaryDirectory, 'legacy.json')
    const brokenPath = join(temporaryDirectory, 'broken.json')
    writeFileSync(legacyPath, `${JSON.stringify({ schema: 'vk-runtime-bundle@1' })}\n`)
    writeFileSync(brokenPath, 'not json at all')

    expect(describeVkManifestDrift(PYTHON_SOURCE, legacyPath)).toMatch(/source 溯源字段/)
    expect(describeVkManifestDrift(PYTHON_SOURCE, brokenPath)).toMatch(/不是合法 JSON/)
  })
})

describe('Python source identity', () => {
  it('reads the commit, dirty flag and uv.lock hash from the live Python repo', () => {
    const lock = 'python-lock\n'
    const repo = makeRepo('package-python-source-', { 'uv.lock': lock })

    expect(readPythonSource(repo)).toEqual({
      pythonCommit: headOf(repo),
      pythonDirty: false,
      pythonLockSha256: sha256(lock),
    })

    writeFileSync(join(repo, 'untracked.py'), 'print(1)')
    expect(readPythonSource(repo).pythonDirty).toBe(true)
  })

  it('reports a null lock hash when the Python repo has no uv.lock', () => {
    const repo = makeRepo('package-python-no-lock-', { 'README.md': 'no lock here\n' })

    expect(readPythonSource(repo).pythonLockSha256).toBeNull()
  })
})
