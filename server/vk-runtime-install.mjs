// video-knowledge 版本化 runtime 安装核心(v2 阶段3,随 dist-host 发货)。
//
// 契约:
// - uv 路径**显式传入**(bundled),绝不依赖 PATH;
// - 安装前实际计算 wheel/uv 的 SHA-256 与 runtime-manifest.json 比对,
//   不匹配即类型化失败、绝不激活;
// - import → console → API 握手 → DB 迁移四门全绿 + 真实库先备份再迁移,
//   才原子切换 active.json;任何失败旧 runtime/旧 DB 原样可用;
// - 失败按 reasonCode 分类(sha-mismatch/offline/disk/path-too-long/smoke-*…),
//   stderr 尾部脱敏后随状态透出。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statfsSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { scrubSidecarText } from './vk-sidecar.mjs'
import {
  ownedRuntimeSizeBytes,
  writeActiveRuntime,
  writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'
import { normalizeRuntimeExtras } from './vk-capability-packs.mjs'
import {
  RUNTIME_RECEIPT_SCHEMA,
  RUNTIME_TARGET,
  runtimeContractFingerprint,
  runtimeModelPacksFor,
  runtimeRequirementsFor,
} from './vk-runtime-contract.mjs'

const MIN_FREE_BYTES = 1 * 1024 ** 3
const HEAVY_FREE_BYTES = 5 * 1024 ** 3

function legacyModelCacheRoots(home, env = process.env) {
  const roots = []
  if (typeof env.MODELSCOPE_CACHE === 'string' && env.MODELSCOPE_CACHE.trim()) {
    roots.push(env.MODELSCOPE_CACHE.trim())
  }
  const userCache = join(homedir(), '.cache', 'modelscope')
  roots.push(join(userCache, 'hub', 'models'), join(userCache, 'hub'))
  const appCache = join(resolve(home), 'models', 'asr')
  try {
    for (const entry of readdirSync(appCache, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(appCache, entry.name, 'models'))
    }
  } catch { /* no previous app-owned model packs */ }
  return [...new Set(roots.map((root) => resolve(root)))]
}

export class VkRuntimeInstallError extends Error {
  constructor(reasonCode, message, detail) {
    super(message)
    this.name = 'VkRuntimeInstallError'
    this.reasonCode = reasonCode
    if (detail) this.detail = detail
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function classifyUvFailure(text) {
  const lowered = text.toLowerCase()
  if (/(error sending request|getaddrinfo|dns error|connection (refused|reset)|network|tls handshake|timed out)/.test(lowered)) {
    return 'offline'
  }
  return 'install-failed'
}

function bundleFile(root, name) {
  if (typeof name !== 'string' || !name) return null
  const path = resolve(root, name)
  const rel = relative(root, path)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return path
}

function prefixedJson(output, prefix, reasonCode) {
  const line = output.split(/\r?\n/).findLast((item) => item.startsWith(prefix))
  if (!line) throw new VkRuntimeInstallError(reasonCode, `${reasonCode} 未返回结果`)
  try {
    return JSON.parse(line.slice(prefix.length))
  } catch {
    throw new VkRuntimeInstallError(reasonCode, `${reasonCode} 返回了损坏的结果`)
  }
}

export async function installVkRuntime({
  home,
  bundleDir,
  wheelPath,
  uvPath,
  manifestPath,
  version,
  python = '3.12',
  extras = [],
  log = () => {},
  spawnImpl = spawn,
  fetchImpl = fetch,
  env = process.env,
}) {
  const baseEnv = { ...process.env, ...env }
  let normalizedExtras
  try {
    normalizedExtras = normalizeRuntimeExtras(extras)
  } catch (error) {
    throw new VkRuntimeInstallError(error.reasonCode ?? 'invalid-runtime-extra', error.message)
  }
  const resolvedHome = resolve(home)
  const manifestFile = manifestPath ?? (bundleDir ? join(bundleDir, 'runtime-manifest.json') : undefined)
  if (!manifestFile || !existsSync(manifestFile)) {
    throw new VkRuntimeInstallError('bundle-missing', 'runtime-manifest.json 缺失,无法核验捆绑件')
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    throw new VkRuntimeInstallError('bundle-missing', 'runtime-manifest.json 损坏')
  }
  const requirements = runtimeRequirementsFor(manifest, normalizedExtras)
  const runtimeFingerprint = runtimeContractFingerprint(manifest, normalizedExtras)
  if (!requirements || !runtimeFingerprint) {
    throw new VkRuntimeInstallError(
      'bundle-contract-missing',
      '安装包缺少当前能力组合的锁定依赖契约',
    )
  }
  if (
    manifest?.runtime?.pythonImplementation !== RUNTIME_TARGET.pythonImplementation
    || manifest?.runtime?.pythonVersion !== RUNTIME_TARGET.pythonVersion
    || manifest?.runtime?.pythonAbi !== RUNTIME_TARGET.pythonAbi
    || manifest?.runtime?.platform !== RUNTIME_TARGET.platform
  ) {
    throw new VkRuntimeInstallError('unsupported-runtime-target', '安装包 runtime 目标与当前产品不一致')
  }
  const requirementsRoot = bundleDir ? resolve(bundleDir) : dirname(resolve(manifestFile))
  const wheel = wheelPath
    ? resolve(wheelPath)
    : bundleFile(requirementsRoot, manifest?.wheel?.name)
  const uv = uvPath
    ? resolve(uvPath)
    : bundleFile(requirementsRoot, manifest?.uv?.name)
  const requirementsPath = bundleFile(requirementsRoot, requirements.name)
  const selectedModelPacks = runtimeModelPacksFor(manifest, normalizedExtras)
  if (!wheel || !existsSync(wheel)) throw new VkRuntimeInstallError('bundle-missing', `wheel 不存在: ${manifest?.wheel?.name}`)
  if (!uv || !existsSync(uv)) throw new VkRuntimeInstallError('bundle-missing', `uv 不存在: ${manifest?.uv?.name}`)
  if (!requirementsPath || !existsSync(requirementsPath)) {
    throw new VkRuntimeInstallError('bundle-missing', `锁定依赖文件不存在: ${requirements.name}`)
  }
  const modelPackAssets = selectedModelPacks.map((pack) => ({
    ...pack,
    manifestPath: bundleFile(requirementsRoot, pack.manifest),
    smokePath: bundleFile(requirementsRoot, pack.smoke),
  }))
  for (const pack of modelPackAssets) {
    if (!pack.manifestPath || !existsSync(pack.manifestPath)) {
      throw new VkRuntimeInstallError('bundle-missing', `模型 manifest 不存在: ${pack.manifest}`)
    }
    if (!pack.smokePath || !existsSync(pack.smokePath)) {
      throw new VkRuntimeInstallError('bundle-missing', `ASR smoke 音频不存在: ${pack.smoke}`)
    }
  }

  // —— SHA 前置核验(不匹配即停止,绝不激活)——
  const wheelDigest = sha256File(wheel)
  if (manifest?.wheel?.sha256 !== wheelDigest) {
    throw new VkRuntimeInstallError(
      'sha-mismatch',
      'wheel SHA-256 与 manifest 不符,拒绝安装',
      `expected=${manifest?.wheel?.sha256} actual=${wheelDigest}`,
    )
  }
  const uvDigest = sha256File(uv)
  if (manifest?.uv?.sha256 !== uvDigest) {
    throw new VkRuntimeInstallError(
      'sha-mismatch',
      'uv SHA-256 与 manifest 不符,拒绝安装',
      `expected=${manifest?.uv?.sha256} actual=${uvDigest}`,
    )
  }
  const requirementsDigest = sha256File(requirementsPath)
  if (requirements.sha256 !== requirementsDigest) {
    throw new VkRuntimeInstallError(
      'sha-mismatch',
      '锁定依赖文件 SHA-256 与 manifest 不符,拒绝安装',
      `expected=${requirements.sha256} actual=${requirementsDigest}`,
    )
  }
  for (const pack of modelPackAssets) {
    const manifestDigest = sha256File(pack.manifestPath)
    const smokeDigest = sha256File(pack.smokePath)
    if (manifestDigest !== pack.manifestSha256 || smokeDigest !== pack.smokeSha256) {
      throw new VkRuntimeInstallError(
        'sha-mismatch',
        `模型能力包 ${pack.id} 与 manifest 不符,拒绝安装`,
      )
    }
  }
  log(
    `manifest 核验通过 wheel=${wheelDigest.slice(0, 12)}… `
    + `requirements=${requirementsDigest.slice(0, 12)}… uv=${uvDigest.slice(0, 12)}…`,
  )

  // —— 预检 ——
  if (resolvedHome.length > 100) {
    throw new VkRuntimeInstallError(
      'path-too-long',
      `home 路径过长(${resolvedHome.length} > 100):Windows MAX_PATH 下 runtime 会装完即坏`,
    )
  }
  for (const dir of ['runtime/versions', 'models', 'data', 'cache', 'temp']) {
    mkdirSync(join(resolvedHome, dir), { recursive: true })
  }
  const stats = statfsSync(resolvedHome)
  const freeBytes = stats.bavail * stats.bsize
  const required = normalizedExtras.includes('media-asr') ? HEAVY_FREE_BYTES : MIN_FREE_BYTES
  log(`磁盘预检 free=${(freeBytes / 1024 ** 3).toFixed(2)}GiB required>=${(required / 1024 ** 3).toFixed(2)}GiB`)
  if (freeBytes < required) {
    throw new VkRuntimeInstallError('disk', '磁盘可用空间不足')
  }

  const wheelLabel = (manifest?.wheel?.name ?? 'wheel').replace(/\.whl$/, '')
  const baseVersionLabel = version ?? wheelLabel
  // The fingerprint covers wheel, uv.lock export, target ABI and extras. A
  // capability upgrade therefore gets a fresh directory without deleting the
  // active runtime, even when the wheel itself did not change.
  const versionLabel = `${baseVersionLabel}+runtime-${runtimeFingerprint.slice(0, 12)}`
  const versionDir = join(resolvedHome, 'runtime', 'versions', versionLabel)
  // A normal explicit rebuild intentionally replaces its target directory.
  // Capability upgrades use a different fingerprinted target, so cleaning a
  // stale partial target cannot remove the old active runtime.
  if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true })

  const runStep = (step, command, argv, stepEnv = {}) => new Promise((resolveStep, rejectStep) => {
    log(`${step}: ${command.split(/[\\/]/).pop()} ${argv.join(' ')}`)
    const child = spawnImpl(command, argv, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Python otherwise writes redirected stdout with the active Windows
      // code page. Node decodes pipes as UTF-8, corrupting paths such as the
      // app-owned Chinese data directory before they reach later smoke steps.
      env: { ...baseEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...stepEnv },
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(scrubSidecarText(line.trim()))
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(scrubSidecarText(line.trim()))
    })
    child.once('error', (error) => rejectStep(new VkRuntimeInstallError('install-failed', `${step} 无法启动`, String(error?.message ?? error))))
    child.once('close', (code) => {
      if (code === 0) resolveStep(output)
      else {
        let reasonCode = step.startsWith('smoke')
          ? `smoke-${step.slice(6)}`
          : classifyUvFailure(output)
        if (step.startsWith('models-')) {
          try {
            reasonCode = prefixedJson(output, 'VK_MODEL_PACK_RESULT=', 'model-install-failed')?.reason
              ?? 'model-install-failed'
          } catch {
            reasonCode = 'model-install-failed'
          }
        } else if (step === 'pip-check') {
          reasonCode = 'pip-check-failed'
        }
        rejectStep(new VkRuntimeInstallError(
          reasonCode,
          `${step} 失败(exit ${code})`,
          scrubSidecarText(output.slice(-800)),
        ))
      }
    })
  })

  // —— venv + 安装(显式 uv;uv 输出=真实下载/初始化阶段,逐行透传 log)——
  await runStep('venv', uv, ['venv', '--python', python, versionDir])
  mkdirSync(versionDir, { recursive: true })
  const pythonExe = join(versionDir, 'Scripts', 'python.exe')
  await runStep('install-locked', uv, [
    'pip', 'install', '--link-mode', 'copy', '--python', pythonExe,
    '--no-deps', '--require-hashes', '-r', requirementsPath,
  ])
  await runStep('install-wheel', uv, [
    'pip', 'install', '--link-mode', 'copy', '--python', pythonExe,
    '--no-deps', wheel,
  ])
  const pipCheckOutput = await runStep('pip-check', uv, ['pip', 'check', '--python', pythonExe])

  const installedModelPacks = []
  let modelEnvironment = {}
  let asrSmoke = null
  for (const pack of modelPackAssets) {
    if (pack.id !== 'local-asr') continue
    const packRoot = join(resolvedHome, 'models', 'asr', pack.manifestSha256)
    const modelArgs = [
      '-m', 'video_knowledge.runtime_models', 'install',
      '--manifest', pack.manifestPath,
      '--expected-manifest-sha', pack.manifestSha256,
      '--pack-root', packRoot,
    ]
    for (const cacheRoot of legacyModelCacheRoots(resolvedHome, baseEnv)) {
      modelArgs.push('--legacy-cache', cacheRoot)
    }
    log(`models-asr: 检查本机缓存 ${Math.max(0, (modelArgs.length - 9) / 2)} 个位置，逐文件复用并校验`)
    const modelOutput = await runStep('models-asr', pythonExe, modelArgs)
    const modelResult = prefixedJson(modelOutput, 'VK_MODEL_PACK_RESULT=', 'model-install-failed')
    if (modelResult?.ready !== true || typeof modelResult?.cache_root !== 'string') {
      throw new VkRuntimeInstallError('model-install-failed', 'ASR 模型能力包未通过校验')
    }
    log(
      `models-asr: 校验完成 reused=${Number(modelResult.linked ?? 0) + Number(modelResult.copied ?? 0)} `
      + `downloaded=${Number(modelResult.downloaded ?? 0)}`,
    )
    // The installer owns this content-addressed path. Do not round-trip it
    // through child stdout when preparing the smoke environment.
    const verifiedModelCache = join(packRoot, 'models')
    modelEnvironment = { MODELSCOPE_CACHE: verifiedModelCache }
    const smokeOutput = await runStep('smoke-asr', pythonExe, [
      '-m', 'video_knowledge.runtime_smoke', '--audio', pack.smokePath,
    ], modelEnvironment)
    asrSmoke = prefixedJson(smokeOutput, 'VK_ASR_SMOKE_RESULT=', 'smoke-asr')
    if (asrSmoke?.ready !== true || !asrSmoke?.transcript) {
      throw new VkRuntimeInstallError('smoke-asr', '真实 ASR smoke 未产生转写')
    }
    installedModelPacks.push({
      id: pack.id,
      manifest: pack.manifest,
      manifestSha256: pack.manifestSha256,
      cacheRoot: verifiedModelCache,
      receipt: modelResult.receipt,
      reused: modelResult.reused === true,
      reusedFiles: Number(modelResult.linked ?? 0) + Number(modelResult.copied ?? 0),
      downloadedFiles: Number(modelResult.downloaded ?? 0),
    })
  }

  // —— 四门 smoke ——
  await runStep('smoke-import', pythonExe, ['-c', 'import video_knowledge, importlib.metadata as m; print("import ok", m.version("video-knowledge"))'])
  await runStep('smoke-console', pythonExe, ['-m', 'video_knowledge', '-h'])

  const smokeRoot = mkdtempSync(join(tmpdir(), 'vk-rt-smoke-'))
  let smokeMeta = null
  try {
    const token = 'runtime-smoke-token-0123456789abcdef'
    const gui = spawnImpl(pythonExe, ['-m', 'video_knowledge', 'gui', '--root', join(smokeRoot, 'data'), '--config-dir', join(smokeRoot, 'config'), '--port', '0', '--no-browser'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...baseEnv,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...modelEnvironment,
        VK_UI_TOKEN: token,
      },
    })
    try {
      const port = await new Promise((resolvePort, rejectPort) => {
        const timer = setTimeout(() => rejectPort(new VkRuntimeInstallError('smoke-api', 'gui ready 超时')), 30_000)
        let buffered = ''
        gui.stdout?.on('data', (chunk) => {
          buffered += chunk.toString('utf8')
          const match = /gui=http:\/\/127\.0\.0\.1:(\d+)/.exec(buffered)
          if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
        })
        gui.once('exit', (code) => rejectPort(new VkRuntimeInstallError('smoke-api', `gui 提前退出(${code})`)))
      })
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/meta`, { headers: { 'X-VK-Token': token } })
      const meta = await response.json()
      if (!response.ok || meta.service !== 'video-knowledge' || meta.shell_mode !== true) {
        throw new VkRuntimeInstallError('smoke-api', `meta 握手异常 status=${response.status}`)
      }
      if (normalizedExtras.includes('media-asr')) {
        const local = Array.isArray(meta.capabilities)
          ? meta.capabilities.find((item) => item?.capability === 'local_transcription')
          : null
        if (local?.runtime !== 'ready') {
          throw new VkRuntimeInstallError(
            'smoke-asr-capability',
            `本地转写能力未就绪: ${local?.detail ?? 'missing capability'}`,
          )
        }
      }
      smokeMeta = meta
      log(`smoke-api: handshake ok api_version=${meta.api_version}`)
    } finally {
      gui.kill('SIGKILL')
    }
    const migrateOut = await runStep('smoke-migrate', pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1]) / "vk.db"); print(json.dumps(migrate(conn, default_migrations_dir())))', join(smokeRoot, 'migrate-smoke')])
    if (!migrateOut.includes('"008"')) {
      throw new VkRuntimeInstallError('smoke-migrate', `迁移清单缺 008: ${migrateOut.trim().slice(-200)}`)
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true })
  }

  // —— 真实 DB:迁移前备份,失败还原(旧 DB 可继续启动)——
  const realDb = join(resolvedHome, 'data', 'vk.db')
  if (existsSync(realDb)) {
    const backup = `${realDb}.backup-${versionLabel.replace(/[^\w.-]/g, '_')}-${Date.now()}`
    copyFileSync(realDb, backup)
    log(`已备份真实库 -> ${backup.split(/[\\/]/).pop()}`)
    const result = spawnSync(pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1])); print(json.dumps(migrate(conn, default_migrations_dir())))', realDb], { shell: false, windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) {
      copyFileSync(backup, realDb)
      throw new VkRuntimeInstallError('db-migrate', '真实库迁移失败,已从备份还原', scrubSidecarText(String(result.stderr ?? '').slice(-500)))
    }
    log(`真实库迁移完成 applied=${result.stdout.trim()}`)
  }

  const packageInventoryOutput = await runStep('inventory-packages', pythonExe, [
    '-c',
    'import importlib.metadata as m,json; rows=sorted(({"name":d.metadata["Name"].lower(),"version":d.version} for d in m.distributions()),key=lambda row:row["name"]); print(json.dumps(rows,separators=(",",":"),sort_keys=True))',
  ])
  let packages
  try {
    packages = JSON.parse(packageInventoryOutput.trim())
  } catch {
    throw new VkRuntimeInstallError('inventory-failed', '已安装包清单无法解析')
  }
  const packageInventorySha256 = createHash('sha256')
    .update(JSON.stringify(packages))
    .digest('hex')
  const inventoryPath = join(versionDir, 'runtime-inventory.json')
  writeFileSync(inventoryPath, `${JSON.stringify({
    schema: 'vk-runtime-inventory@1',
    runtimeFingerprint,
    packages,
    packageInventorySha256,
    pipCheck: {
      status: 'passed',
      output: scrubSidecarText(pipCheckOutput.trim()).slice(-1_000),
    },
    modelPacks: installedModelPacks,
    asrSmoke,
  }, null, 2)}\n`, 'utf8')
  const runtimeSizeBytes = ownedRuntimeSizeBytes({
    home: resolvedHome,
    runtime: { source: 'app-owned', pythonPath: pythonExe },
  })

  // —— 原子切换 ——
  const receipt = writeRuntimeReceipt(resolvedHome, {
    schema: RUNTIME_RECEIPT_SCHEMA,
    source: 'app-owned',
    version: versionLabel,
    pythonPath: pythonExe,
    wheel: manifest?.wheel?.name,
    wheelSha256: manifest?.wheel?.sha256,
    uvSha256: manifest?.uv?.sha256,
    pythonLockSha256: manifest?.source?.pythonLockSha256,
    requirements: requirements.name,
    requirementsSha256: requirements.sha256,
    runtimeFingerprint,
    runtimeTarget: {
      pythonImplementation: manifest.runtime.pythonImplementation,
      pythonVersion: manifest.runtime.pythonVersion,
      pythonAbi: manifest.runtime.pythonAbi,
      platform: manifest.runtime.platform,
    },
    packageInventory: 'runtime-inventory.json',
    packageInventorySha256,
    runtimeSizeBytes,
    pipCheck: 'passed',
    modelPacks: installedModelPacks,
    asrSmoke,
    ffmpegVersion: asrSmoke?.ffmpeg ?? null,
    installedAt: new Date().toISOString(),
    extras: normalizedExtras,
    apiVersion: smokeMeta?.api_version ?? null,
    schemaVersion: smokeMeta?.processing_request_schema_version ?? null,
    capabilities: Array.isArray(smokeMeta?.capabilities) ? smokeMeta.capabilities : [],
  })
  writeActiveRuntime(resolvedHome, receipt)
  log(`active -> ${versionLabel}`)
  return { version: versionLabel, pythonPath: pythonExe }
}
