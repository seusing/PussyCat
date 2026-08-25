// Build the pinned video-knowledge wheel and uv executable into the Tauri resources.
// The manifest is also the provenance boundary for the Python source used by the bundle.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_CONTRACT_SCHEMA,
  RUNTIME_TARGET,
  enumerateRuntimeExtraProfiles,
  runtimeRequirementsFilename,
  runtimeRequirementsKey,
} from '../server/vk-runtime-contract.mjs'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_PYTHON_SOURCE_DIR = 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization'
const DEFAULT_WHEEL_NAME = 'video_knowledge-0.1.0-py3-none-any.whl'

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

export function exportLockedRequirements({
  uvPath,
  pythonSourceDir,
  extras,
  spawnSyncImpl = spawnSync,
}) {
  const args = [
    'export', '--locked', '--offline', '--no-dev', '--no-emit-project',
    '--no-annotate', '--no-header', '--format', 'requirements.txt',
    '--python', RUNTIME_TARGET.pythonVersion,
  ]
  for (const extra of extras) args.push('--extra', extra)
  const result = spawnSyncImpl(uvPath, args, {
    cwd: pythonSourceDir,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `[vk-bundle] requirements export failed (${runtimeRequirementsKey(extras)}): `
      + `${String(result.stderr ?? '').trim()}`,
    )
  }
  const normalized = String(result.stdout ?? '').replaceAll('\r\n', '\n')
  if (!normalized.trim()) {
    throw new Error(`[vk-bundle] requirements export is empty (${runtimeRequirementsKey(extras)})`)
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

export function buildWheel({
  uvPath,
  pythonSourceDir,
  wheelOutDir,
  spawnSyncImpl = spawnSync,
}) {
  const result = spawnSyncImpl(
    uvPath,
    ['build', '--wheel', '--out-dir', wheelOutDir],
    {
      cwd: pythonSourceDir,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `[vk-bundle] wheel build failed: ${String(result.stderr ?? '').trim()}`,
    )
  }
}

export function buildVkBundle(options = {}) {
  const root = options.root ?? projectRoot
  const uvPath = options.uvPath
    ?? process.env.VK_UV_PATH
    ?? 'C:\\Users\\Lauseusing\\.local\\bin\\uv.exe'
  const pythonSourceDir = options.pythonSourceDir
    ?? process.env.VK_PYTHON_SOURCE_DIR
    ?? DEFAULT_PYTHON_SOURCE_DIR
  const environmentWheelPath = process.env.VK_WHEEL_PATH?.trim() || undefined
  const explicitWheelPath = options.wheelPath !== undefined
    || Boolean(environmentWheelPath)
  const wheelPath = (options.wheelPath ?? environmentWheelPath)
    || join(pythonSourceDir, 'dist', DEFAULT_WHEEL_NAME)
  const modelManifestPath = options.modelManifestPath
    ?? join(pythonSourceDir, 'src', 'video_knowledge', 'resources', 'asr-model-pack.json')
  const modelSmokePath = options.modelSmokePath
    ?? join(pythonSourceDir, 'src', 'video_knowledge', 'resources', 'runtime-asr-smoke.wav')
  const outDir = options.outDir ?? join(root, 'src-tauri', 'resources', 'vk')
  const requirementsExporter = options.requirementsExporter ?? exportLockedRequirements
  const wheelBuilder = options.wheelBuilder ?? buildWheel
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync

  // Validate provenance before deleting the previous known-good bundle.
  const source = collectBundleSource({ pythonSourceDir, pussyCatRoot: root })
  const uvVersion = spawnSyncImpl(uvPath, ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (uvVersion.status !== 0) {
    throw new Error(`[vk-bundle] uv unavailable: ${uvPath}`)
  }
  if (!existsSync(modelManifestPath) || !existsSync(modelSmokePath)) {
    throw new Error('[vk-bundle] ASR model manifest or smoke audio is missing')
  }

  const requirementsPayloads = enumerateRuntimeExtraProfiles().map((extras) => ({
    key: runtimeRequirementsKey(extras),
    extras,
    name: runtimeRequirementsFilename(extras),
    content: requirementsExporter({ uvPath, pythonSourceDir, extras, spawnSyncImpl }),
  }))

  if (!explicitWheelPath) {
    wheelBuilder({
      uvPath,
      pythonSourceDir,
      wheelOutDir: dirname(wheelPath),
      spawnSyncImpl,
    })
  }
  if (!existsSync(wheelPath)) {
    throw new Error(`[vk-bundle] wheel is missing after build: ${wheelPath}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  copyFileSync(wheelPath, join(outDir, basename(wheelPath)))
  copyFileSync(uvPath, join(outDir, 'uv.exe'))
  copyFileSync(modelManifestPath, join(outDir, 'asr-model-pack.json'))
  copyFileSync(modelSmokePath, join(outDir, 'runtime-asr-smoke.wav'))
  for (const requirements of requirementsPayloads) {
    writeFileSync(join(outDir, requirements.name), requirements.content, 'utf8')
  }

  const manifest = {
    schema: 'vk-runtime-bundle@2',
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
    runtime: {
      contractSchema: RUNTIME_CONTRACT_SCHEMA,
      ...RUNTIME_TARGET,
      requirements: requirementsPayloads.map(({ key, extras, name }) => ({
        key,
        extras,
        name,
        sha256: sha256(join(outDir, name)),
      })),
      modelPacks: [{
        id: 'local-asr',
        requiredExtra: 'media-asr',
        manifest: 'asr-model-pack.json',
        manifestSha256: sha256(join(outDir, 'asr-model-pack.json')),
        smoke: 'runtime-asr-smoke.wav',
        smokeSha256: sha256(join(outDir, 'runtime-asr-smoke.wav')),
      }],
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
