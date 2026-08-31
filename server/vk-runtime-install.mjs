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
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statfsSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { scrubSidecarText } from './vk-sidecar.mjs'
import {
  ownedRuntimeSizeBytes,
  pruneUnreferencedBases,
  writeActiveRuntime,
  writeRuntimeReceipt,
} from './vk-runtime-resolver.mjs'
import { normalizeRuntimeExtras } from './vk-capability-packs.mjs'
import {
  RUNTIME_RECEIPT_SCHEMA,
  RUNTIME_TARGET,
  runtimeContractFingerprint,
  runtimeEnvironmentFingerprint,
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

// —— 依赖复用:硬链接克隆兄弟 runtime ——
//
// venv 有 2.3 GB / 41,558 个文件,其中应用 wheel 只占 493 KB。只改代码时把依赖重装
// 一遍是纯浪费:实测复制要几分钟,而硬链接同样这 41,558 个文件只要 15.4 秒、磁盘增量
// 为 0(两个目录各自看到完整一份,数据块共享)。
//
// **链的是兄弟 runtime 目录,不是 uv 缓存**——所以不能改用 `--link-mode hardlink`:
// 那样 venv 会依赖 uv 缓存活着,`uv cache clean` 一执行就废。链到兄弟目录则两边都是
// 本应用自己的目录,删掉任一个另一个照常(硬链接计数)。
//
// 原子性与回滚不受影响:仍然是"建新目录 → 全部门禁通过 → 末尾切 active.json"。
const LONG_PATH_PREFIX = `${'\\'.repeat(2)}?${'\\'}`

/** Windows 长路径前缀。本机 LongPathsEnabled=0,site-packages 深处会 WinError 3。 */
function longPath(path) {
  const absolute = resolve(path)
  return absolute.startsWith(LONG_PATH_PREFIX) ? absolute : `${LONG_PATH_PREFIX}${absolute}`
}

/** 把 sourceDir 硬链接克隆到 targetDir。失败即抛,由调用方清理并回落全量安装。 */
export function hardlinkCloneDir(sourceDir, targetDir, fsImpl = {
  mkdirSync, readdirSync, linkSync, copyFileSync,
}) {
  let dirs = 0
  let files = 0
  const walk = (from, to) => {
    // 逐层建目录,**不能用 recursive:true**:带长路径前缀时它会向上递归,
    // 把前缀本身当目录去建,报"文件名、目录名或卷标语法不正确"。
    try {
      fsImpl.mkdirSync(longPath(to))
      dirs += 1
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    for (const entry of fsImpl.readdirSync(from, { withFileTypes: true })) {
      const child = join(from, entry.name)
      const mirror = join(to, entry.name)
      if (entry.isDirectory()) {
        walk(child, mirror)
        continue
      }
      files += 1
      try {
        fsImpl.linkSync(longPath(child), longPath(mirror))
      } catch {
        // 跨卷、超出单文件链接数上限等:退回复制,别让整次克隆失败。
        fsImpl.copyFileSync(longPath(child), longPath(mirror))
      }
    }
  }
  walk(sourceDir, targetDir)
  return { dirs, files }
}

export const BASE_RECEIPT_FILE = 'base-receipt.json'
export const BASE_RECEIPT_SCHEMA = 'vk-runtime-base@1'

/** 底座目录:按环境指纹寻址,依赖一个字节没变就是同一个底座。 */
export function baseDirForFingerprint(home, environmentFingerprint) {
  return join(resolve(home), 'runtime', 'bases', String(environmentFingerprint).slice(0, 16))
}

/** 底座可用的判据 —— 三条都要:解释器在、receipt 记着同一个环境指纹、里面**没有**
 *  我们自己的包。第三条不是洁癖:底座留着旧版 video_knowledge 的话,一旦 PYTHONPATH
 *  没传到(漏一个 spawn 点就会),跑的就是旧代码,而且一声不吭。 */
export function baseIsReady(baseDir, environmentFingerprint) {
  const python = join(baseDir, 'Scripts', 'python.exe')
  if (!existsSync(python)) return false
  try {
    const receipt = JSON.parse(readFileSync(join(baseDir, BASE_RECEIPT_FILE), 'utf8'))
    return receipt?.schema === BASE_RECEIPT_SCHEMA
      && receipt?.environmentFingerprint === environmentFingerprint
      && receipt?.appFree === true
  } catch {
    return false
  }
}

/** 找一个可以拿来克隆依赖的兄弟 runtime:环境指纹一致、且 python.exe 真在。
 *
 * 只认 receipt 里显式记着的环境指纹。老 receipt 没有这个字段,于是第一次装新版仍走
 * 全量——这是对的:那些目录是用旧口径装的,没有依据断言它们的依赖与现在一致。
 */
export function reusableRuntimeDonor(
  home, environmentFingerprint, excludeDir,
  fsImpl = { readdirSync, readFileSync, existsSync },
) {
  if (!environmentFingerprint) return null
  const versionsDir = join(resolve(home), 'runtime', 'versions')
  let entries
  try {
    entries = fsImpl.readdirSync(versionsDir, { withFileTypes: true })
  } catch {
    return null           // 首次安装,还没有 versions 目录
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(versionsDir, entry.name)
    if (excludeDir && resolve(dir) === resolve(excludeDir)) continue
    if (!fsImpl.existsSync(join(dir, 'Scripts', 'python.exe'))) continue
    try {
      const receipt = JSON.parse(fsImpl.readFileSync(join(dir, 'runtime-receipt.json'), 'utf8'))
      if (receipt?.environmentFingerprint === environmentFingerprint) {
        return { dir, label: entry.name }
      }
    } catch { /* 没有 receipt 或读不动:当它不可复用 */ }
  }
  return null
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
  // 环境指纹 = 契约指纹去掉 wheel。相同即"那 2.3 GB 依赖没变",可以直接克隆兄弟。
  const environmentFingerprint = runtimeEnvironmentFingerprint(manifest, normalizedExtras)
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

  // 每步耗时。装一次两分钟,想知道两分钟花在哪就得有这个;此前日志只在内存里、
  // 跑完即失,事后只能靠重测倒推,同一个问题得重测两遍。
  const stepTimings = []
  const runStep = (step, command, argv, stepEnv = {}) => new Promise((resolveStep, rejectStep) => {
    const stepStartedAt = Date.now()
    const finish = (outcome) => {
      const seconds = (Date.now() - stepStartedAt) / 1000
      stepTimings.push({ step, seconds: Number(seconds.toFixed(1)), outcome })
      log(`${step}: ${outcome} ${seconds.toFixed(1)}s`)
    }
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
    child.once('error', (error) => {
      finish('无法启动')
      rejectStep(new VkRuntimeInstallError('install-failed', `${step} 无法启动`, String(error?.message ?? error)))
    })
    child.once('close', (code) => {
      finish(code === 0 ? '完成' : `失败(exit ${code})`)
      if (code === 0) resolveStep(output)
      else {
        let reasonCode = step.startsWith('smoke')
          ? `smoke-${step.slice(6)}`
          : classifyUvFailure(output)
        if (step === 'models-ocr') {
          // OCR 模型走自己的结果前缀,别拿 ASR 的去解析——解析不到会把具体原因吞成通用码。
          try {
            reasonCode = prefixedJson(output, 'VK_OCR_MODEL_RESULT=', 'ocr-model-install-failed')?.reason
              ?? 'ocr-model-install-failed'
          } catch {
            reasonCode = 'ocr-model-install-failed'
          }
        } else if (step.startsWith('models-')) {
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

  // —— 底座 + 应用层(显式 uv;uv 输出=真实下载/初始化阶段,逐行透传 log)——
  //
  // 2.4 GB 依赖与 493 KB 应用码变化频率差几个数量级,不该绑成同一个不可变单元。
  // 依赖进按环境指纹寻址的**底座**、跨版本共享;应用码进版本目录的 app/,靠 PYTHONPATH
  // 前置。依赖没变时这一段只剩装那 493 KB(实测 175 个文件、不到 1 秒),原先要克隆
  // 41,646 个文件、22~60 秒。
  //
  // 既有保证一条没动:仍是新的版本目录、仍跑全套门禁、仍在末尾才切 active.json。
  // 老的自包含 runtime 继续有效——解析器两种形态都认。
  const baseDir = baseDirForFingerprint(resolvedHome, environmentFingerprint)
  const pythonExe = join(baseDir, 'Scripts', 'python.exe')
  const appDir = join(versionDir, 'app')
  if (baseIsReady(baseDir, environmentFingerprint)) {
    log(`reuse-base: 复用底座 ${baseDir.split(/[\\/]/).pop()}(环境指纹一致,依赖零动作)`)
    stepTimings.push({ step: 'reuse-base', seconds: 0, outcome: '完成' })
  } else {
    // 底座要重建。优先从环境指纹一致的老 runtime 硬链接克隆(22 秒),没有再全量装
    // (拷 2.4 GB,几分钟)。克隆来的目录里带着我们自己的包,必须摘掉——底座只放依赖。
    rmSync(baseDir, { recursive: true, force: true })
    const donor = reusableRuntimeDonor(resolvedHome, environmentFingerprint, versionDir)
    let clonedFromDonor = false
    if (donor) {
      const startedAt = Date.now()
      log(`base-clone: 从 ${donor.label} 硬链接依赖(环境指纹一致,跳过重装)`)
      try {
        // hardlinkCloneDir 逐层建目录、**不能用 recursive**(长路径前缀会让它向上
        // 递归去建前缀本身)。所以父目录得先备好:第一次拆层安装时 runtime/bases
        // 还不存在,少了这一行克隆会以 ENOENT 失败、静默回落全量装 —— 真机上就是
        // 这么退化的,过渡成本从 20 秒变成 230 秒。
        mkdirSync(dirname(baseDir), { recursive: true })
        const { dirs, files } = hardlinkCloneDir(donor.dir, baseDir)
        clonedFromDonor = true
        const cloneSeconds = (Date.now() - startedAt) / 1000
        stepTimings.push({
          step: 'base-clone', seconds: Number(cloneSeconds.toFixed(1)), outcome: '完成',
        })
        log(`base-clone: 硬链接 ${files} 个文件 / ${dirs} 个目录,用时 ${cloneSeconds.toFixed(1)}s`)
        await runStep('base-strip-app', uv, [
          'pip', 'uninstall', '--python', pythonExe, 'video-knowledge',
        ])
      } catch (error) {
        // 回落是安全的(照样装得出一个能用的 runtime),但**代价是 20 秒变几分钟**。
        // 只写一行 log 太容易被忽略——记进耗时表,它会出现在末尾那行耗时排行里。
        stepTimings.push({ step: 'base-clone', seconds: 0, outcome: '失败,回落全量安装' })
        log(`base-clone: 克隆失败,回落全量安装(${String(error?.message ?? error).slice(0, 160)})`)
        rmSync(baseDir, { recursive: true, force: true })
        clonedFromDonor = false
      }
    }
    if (!clonedFromDonor) {
      await runStep('base-venv', uv, ['venv', '--python', python, baseDir])
      await runStep('base-install-locked', uv, [
        'pip', 'install', '--link-mode', 'copy', '--python', pythonExe,
        '--no-deps', '--require-hashes', '-r', requirementsPath,
      ])
    }
    // 「底座里没有我们的包」是承重条件,不能靠"我们没装过"来推定 —— 克隆那条路里
    // 它本来就在。当场验一次,验不过就不写 receipt,这个底座下次也不会被复用。
    await runStep('base-verify-clean', pythonExe, [
      '-c',
      'import importlib.util, sys;'
      + ' sys.exit(1 if importlib.util.find_spec("video_knowledge") else 0)',
    ])
    // 目录归 uv venv 建,但我们要往里写文件,不该把"外部工具一定建好了"当前提。
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(join(baseDir, BASE_RECEIPT_FILE), `${JSON.stringify({
      schema: BASE_RECEIPT_SCHEMA,
      environmentFingerprint,
      requirementsSha256: requirements.sha256,
      appFree: true,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
  }
  mkdirSync(versionDir, { recursive: true })
  // 应用层:493 KB 的包单独装到版本目录里,靠 PYTHONPATH 前置于底座。这一步是
  // 每次更新真正变的**全部**内容,实测 175 个文件 / 不到 1 秒。
  await runStep('install-app', uv, [
    'pip', 'install', '--target', appDir, '--python', pythonExe, '--no-deps', wheel,
  ])
  // 从这里起所有 spawn 都要带上应用层,否则跑的是一个没有我们包的底座。
  // 挂到 baseEnv 上而不是逐处传:漏一处的后果是"import 不到"或更糟的"跑了旧代码"。
  baseEnv.PYTHONPATH = appDir
  // `uv pip check` 只比对**发行版名字**。Windows 上我们装的是 onnxruntime-directml
  // (走 GPU),它提供的正是 `onnxruntime` 这个导入包,但发行版叫另一个名字,于是
  // faster-whisper 声明的 `onnxruntime>=1.14,<2` 被判成「未安装」——一个功能完全正常
  // 的环境被判不兼容,安装中止、从未激活,用户那边就是「解析引擎有更新」点几次都不消失。
  //
  // 只放行这一种替换,且不靠名字放行:必须**真的 import 得到** onnxruntime 才算数。
  // 「导入得到」比「名字对得上」是更强的证据,其余任何不兼容照旧中止。
  // 拆层之后 `uv pip check` 看的是**底座的 site-packages**,里面没有我们的包 ——
  // 它检的是依赖之间彼此相容,检不到我们 wheel 自己声明的依赖。
  //
  // 这不是漏检:requirements 是从我们的 lockfile `uv export` 出来的,wheel 一旦增删
  // 依赖,requirements 就变 → requirementsSha256 变 → 环境指纹变 → 底座重建。
  // 「我们的依赖都装齐了」这件事是被指纹结构性捕获的,不靠这一步。
  let pipCheckOutput = ''
  // 豁免另立字段,**不改 pipCheck 的取值**。pipCheck 是结论(环境合不合格),校验器
  // (vk-runtime-resolver 的 validateReceipt)按 === 'passed' 判 receipt 有效;把结论
  // 改成 'passed-with-onnxruntime-directml' 会让刚装好的 receipt 被判无效,
  // resolveActiveRuntime 随即走修复分支、挑一个旧 runtime 盖回 active.json ——
  // 真机上就这么表现为「装成功了但横幅还在」。豁免是**注解**,不是结论。
  let pipCheckExemption = null
  try {
    pipCheckOutput = await runStep('pip-check', uv, ['pip', 'check', '--python', pythonExe])
  } catch (error) {
    const lines = String(error?.detail ?? '')
      .split(/\r?\n/)
      .filter((line) => line.includes('but it') && line.includes('installed'))
    const onlyOnnxruntime = lines.length > 0
      && lines.every((line) => /requires `onnxruntime[^`]*`/.test(line))
    if (!onlyOnnxruntime) throw error
    await runStep('pip-check-onnxruntime', pythonExe, [
      '-c', 'import onnxruntime; print(onnxruntime.__version__)',
    ])
    pipCheckExemption = 'onnxruntime-directml'
    log('pip-check: faster-whisper 声明的 onnxruntime 由 onnxruntime-directml 提供，'
      + '已实测 import 通过，按兼容处理')
  }

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
  // —— OCR 模型:安装期取齐并校验字节 ——
  // rapidocr 3.x 不把模型打进 wheel,首次用到时才去 ModelScope 下。留到用户第一次解析
  // 视频时下载,要么让他干等、要么离线直接失败;而且这三个文件的 sha256 要随视觉证据
  // 落库,必须是校验过的那一份。这一步本来就在联网装依赖,不新增网络依赖点。
  //
  // 放在硬链接克隆之后:克隆来的兄弟 runtime 已经带着模型,那时这步会报 reused。
  // **这一步失败不中止安装**。OCR 模型只服务烧录字幕这一个能力,ASR/转写/问答都不需要
  // 它;为了 15 MB 的下载打嗝就把整次更新作废、让用户停在旧引擎上,代价完全不成比例
  // ——真机上就这么废掉过一次:装好的 runtime 因为这步失败没写 receipt、从未激活,
  // 用户只看到「解析引擎有更新」的横幅点两次都不消失。
  //
  // 降级路径是安全的:模型缺失时运行期 `_pinned_model_params` 返回空,rapidocr 会按
  // **同样钉死的 PP-OCRv4** 现下一份,只是首次用到时多等十几秒,版本不会跑偏。
  let ocrModels = null
  try {
    const ocrOutput = await runStep('models-ocr', pythonExe, ['-m', 'video_knowledge.runtime_ocr_models'])
    ocrModels = prefixedJson(ocrOutput, 'VK_OCR_MODEL_RESULT=', 'ocr-model-install-failed')
  } catch (error) {
    log(`models-ocr: 预取失败(${error?.reasonCode ?? 'unknown'}),不阻断安装；`
      + '烧录字幕首次使用时会自动补下')
  }
  if (ocrModels?.ready === true) {
    log(`models-ocr: ${ocrModels.reused ? '复用已有' : '已下载'} ${(ocrModels.files ?? []).length} 个模型`)
  }

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
    const result = spawnSync(pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1])); print(json.dumps(migrate(conn, default_migrations_dir())))', realDb], {
      shell: false, windowsHide: true, encoding: 'utf8',
      // 这一处原先没传 env,继承的是 process.env —— 拆层之后那里面没有 PYTHONPATH,
      // 于是迁移脚本 import 不到我们的包。
      env: { ...baseEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
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
      exemption: pipCheckExemption,
      output: scrubSidecarText(pipCheckOutput.trim()).slice(-1_000),
    },
    modelPacks: installedModelPacks,
    asrSmoke,
  }, null, 2)}\n`, 'utf8')
  // 拆层后这里报的是**版本目录**的体积(几 MB),也就是删掉它真正释放的字节;
  // 共享底座不记在任何一个版本头上。
  const runtimeSizeBytes = ownedRuntimeSizeBytes({
    home: resolvedHome,
    runtime: {
      source: 'app-owned', pythonPath: pythonExe,
      runtimeLayout: 'split', version: versionLabel,
    },
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
    // 记下环境指纹,下次装新 wheel 时才找得到可复用的兄弟。
    environmentFingerprint,
    runtimeTarget: {
      pythonImplementation: manifest.runtime.pythonImplementation,
      pythonVersion: manifest.runtime.pythonVersion,
      pythonAbi: manifest.runtime.pythonAbi,
      platform: manifest.runtime.platform,
    },
    runtimeLayout: 'split',
    basePath: baseDir,
    appPath: appDir,
    packageInventory: 'runtime-inventory.json',
    packageInventorySha256,
    runtimeSizeBytes,
    pipCheck: 'passed',
    pipCheckExemption,
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
  // 放在激活**之后**:此刻 active.json 已经指向新版本,再回收才不会误删正在用的底座。
  try {
    const pruned = pruneUnreferencedBases({ home: resolvedHome })
    if (pruned.length) log(`prune-bases: 回收 ${pruned.length} 个无人引用的底座`)
  } catch (error) {
    // 回收失败只是留下垃圾,不该让一次成功的安装变成失败。
    log(`prune-bases: 跳过(${String(error?.message ?? error).slice(0, 120)})`)
  }
  // 耗时排行直接进日志:下次问"更新为什么要两分钟",看这一行就够,不必再重测一遍。
  const totalSeconds = stepTimings.reduce((sum, item) => sum + item.seconds, 0)
  const ranked = [...stepTimings].sort((a, b) => b.seconds - a.seconds)
  log(`timing: 合计 ${totalSeconds.toFixed(1)}s —— ${
    ranked.map((item) => `${item.step} ${item.seconds}s`).join(' / ')
  }`)
  return { version: versionLabel, pythonPath: pythonExe, stepTimings }
}
