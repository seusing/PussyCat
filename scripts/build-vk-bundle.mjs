// Build the pinned video-knowledge wheel and uv executable into the Tauri resources.
// The manifest is also the provenance boundary for the Python source used by the bundle.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_PYTHON_SOURCE_DIR = 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization'

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function git(repoDir, ...args) {
  const result = spawnSync('git', ['-C', repoDir, ...args], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git -C ${repoDir} ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return (result.stdout ?? '').trim()
}

function cleanCommit(repoDir, label) {
  const commit = git(repoDir, 'rev-parse', 'HEAD')
  const changes = git(repoDir, 'status', '--porcelain=v1', '--untracked-files=all')
  if (changes) {
    throw new Error(`[vk-bundle] ${label} source is dirty: ${repoDir}\n${changes}`)
  }
  return commit
}

export function collectBundleSource({ pythonSourceDir, pussyCatRoot }) {
  const pythonCommit = cleanCommit(pythonSourceDir, 'Python')
  const pussyCatCommit = cleanCommit(pussyCatRoot, 'PussyCat')

  const pythonLock = join(pythonSourceDir, 'uv.lock')
  const pussyCatLock = join(pussyCatRoot, 'package-lock.json')
  return {
    pythonCommit,
    pythonDirty: false,
    pythonLockSha256: existsSync(pythonLock) ? sha256(pythonLock) : null,
    pussyCatCommit,
    pussyCatDirty: false,
    pussyCatLockSha256: existsSync(pussyCatLock) ? sha256(pussyCatLock) : null,
  }
}

export function buildVkBundle({
  root = projectRoot,
  wheelPath = process.env.VK_WHEEL_PATH
    ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\dist\\video_knowledge-0.1.0-py3-none-any.whl',
  uvPath = process.env.VK_UV_PATH ?? 'C:\\Users\\Lauseusing\\.local\\bin\\uv.exe',
  pythonSourceDir = process.env.VK_PYTHON_SOURCE_DIR ?? DEFAULT_PYTHON_SOURCE_DIR,
  outDir = join(root, 'src-tauri', 'resources', 'vk'),
} = {}) {
  // Validate provenance before deleting the previous known-good bundle.
  const source = collectBundleSource({ pythonSourceDir, pussyCatRoot: root })
  const uvVersion = spawnSync(uvPath, ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (uvVersion.status !== 0) {
    throw new Error(`[vk-bundle] uv unavailable: ${uvPath}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  copyFileSync(wheelPath, join(outDir, basename(wheelPath)))
  copyFileSync(uvPath, join(outDir, 'uv.exe'))

  const manifest = {
    schema: 'vk-runtime-bundle@1',
    generatedAt: new Date().toISOString(),
    source,
    wheel: {
      name: basename(wheelPath),
      version: (/-([\d.]+)-py3/.exec(basename(wheelPath)) ?? [null, 'unknown'])[1],
      sha256: sha256(join(outDir, basename(wheelPath))),
    },
    uv: {
      name: 'uv.exe',
      version: (uvVersion.stdout ?? '').trim(),
      sha256: sha256(join(outDir, 'uv.exe')),
    },
  }
  writeFileSync(
    join(outDir, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  console.log(
    `[vk-bundle] ${manifest.wheel.name} ${manifest.wheel.sha256.slice(0, 12)}... + ${manifest.uv.version} -> ${outDir}`,
  )
  return manifest
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    buildVkBundle()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
