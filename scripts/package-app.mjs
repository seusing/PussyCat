// 打包安装包的唯一入口。`npm run package`。
//
// 存在的理由不是"少敲一条命令"——`npm run tauri build` 本来就一条。它存在是因为**这条命令
// 的失败与陈旧形态很难看出来**,而这个项目只能靠重装验证功能,拿到一个旧包的代价是
// 用户装完发现"改动没生效",再来回一轮。以下每一条都对应一次真实踩坑:
//
//   1. `npm run tauri build | tail` 会把退出码换成 tail 的 0 —— MSI 打包失败被当成功报出去过。
//      本脚本用 spawnSync 直接取 status,不经管道。
//   2. 构建失败时 bundle 目录里的**旧产物还在**,看起来跟成功一模一样。
//      本脚本记录构建起点时刻,产物 mtime 必须新于它,否则判失败。
//   3. productName 改过两次(OpenCLI App Clone → 抓抓 → 爪爪),目录里会同时躺着三代产物。
//      本脚本只保留当前 productName 的那一份,其余清掉,免得拿错。
//   4. version 恒为 0.1.0,不随提交递增,**无法从版本号判断新旧**。
//      本脚本把 commit + 时刻写进 stamp 文件,并在报告里打出来。
//   5. **Python 引擎(video-knowledge)在另一个仓库**,它的提交不会让本仓变脏 ——
//      只改 Python 时 `package:check` 会说"已是最新"直接跳过,装出来的包里还是旧 wheel。
//      `--force` 也救不了:本脚本从不重建 bundle,只会把 `resources/vk/` 里现成的 wheel
//      原样装进去。本脚本把 Python 仓 HEAD 折进源码身份,并在 bundle manifest 与
//      Python 源码不符时**拒绝打包**,附上该跑的命令。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePythonSourceDir } from './build-vk-bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = join(root, '.package-stamp.json')
const BUNDLE = join(root, 'src-tauri/target/release/bundle')
const VK_MANIFEST = join(root, 'src-tauri/resources/vk/runtime-manifest.json')
const PUSSYCAT_LOCK = join(root, 'package-lock.json')
const REBUILD_BUNDLE_HINT = 'node scripts/build-vk-bundle.mjs'

const args = new Set(process.argv.slice(2))
const CHECK_ONLY = args.has('--check')
const FORCE = args.has('--force')
const SKIP_GATES = args.has('--skip-gates')

function run(cmd, cmdArgs, { capture = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: 'utf8',
    // Windows 上 npm/npx 是 .cmd,shell:false 时 spawn 直接 ENOENT;显式写 npx.cmd 也不行——
    // Node 18.20+ 起禁止以 shell:false 执行 .cmd/.bat(EINVAL)。所以这里**必须** shell:true。
    //
    // 这与 Host 侧 run-manager 的 shell:false **不矛盾**:那里的 shell:false 是因为 argv 来自
    // HTTP 请求方,shell 展开等于把注入面敞开;而这里每一个命令与参数都是本文件里的字面量,
    // 没有任何外部输入流进来。照搬那条规则只会让脚本在 Windows 上跑不起来——
    // 规则要连着它成立的理由一起搬,不能只搬结论。
    shell: true,
    stdio: capture ? 'pipe' : 'inherit',
  })
  // spawnSync 找不到可执行文件时 status 是 null 而非非零 —— 那种情况也必须判失败,
  // 否则"npm 不在 PATH"会被当成构建通过。
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// git 走 shell:false 直连:它是 .exe 不是 .cmd,不需要上面那条 shell:true 的豁免,
// 而 `-C <仓库路径>` 里带空格时 shell 拼接会碎掉。失败必须炸 —— 静默返回空串会让
// "Python 仓不在那儿"伪装成"Python 仓在 HEAD 上没动过"。
function git(repoDir, ...gitArgs) {
  const r = spawnSync('git', ['-C', repoDir, ...gitArgs], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })
  if ((r.status ?? 1) !== 0) {
    throw new Error(`[package] git -C ${repoDir} ${gitArgs.join(' ')} 失败:${(r.stderr ?? '').trim()}`)
  }
  return (r.stdout ?? '').trim()
}

function productName() {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  return conf.productName
}

function readStamp() {
  if (!existsSync(STAMP)) return undefined
  try { return JSON.parse(readFileSync(STAMP, 'utf8')) } catch { return undefined }
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Accept both legacy string artifacts and provenance-aware { path, sha256 } artifacts. */
export function stampArtifactPaths(stampValue) {
  if (!Array.isArray(stampValue?.artifacts)) return []
  return stampValue.artifacts
    .map((artifact) => typeof artifact === 'string' ? artifact : artifact?.path)
    .filter((artifact) => typeof artifact === 'string' && artifact.length > 0)
}

/**
 * Legacy stamps only prove an artifact path. New stamps also prove its bytes.
 * A provenance-aware entry must therefore still be present in currentArtifacts
 * and match the SHA-256 captured at package time.
 */
export function areStampArtifactsCurrent(stampValue, currentArtifactPaths) {
  if (!Array.isArray(stampValue?.artifacts) || stampValue.artifacts.length === 0) return true
  return stampValue.artifacts.every((artifact) => {
    if (typeof artifact === 'string') return currentArtifactPaths.includes(artifact)
    if (!artifact
      || typeof artifact.path !== 'string'
      || typeof artifact.sha256 !== 'string'
      || !currentArtifactPaths.includes(artifact.path)
      || !existsSync(artifact.path)) return false
    return sha256(artifact.path) === artifact.sha256
  })
}

/**
 * 活体 Python 源码身份。字段与 build-vk-bundle 写进 manifest.source 的三个 Python 字段
 * **逐一对应** —— 两边算法不一致的话,这里的比对就等于没比。
 */
export function readPythonSource(pythonSourceDir = resolvePythonSourceDir()) {
  const lock = join(pythonSourceDir, 'uv.lock')
  return {
    pythonCommit: git(pythonSourceDir, 'rev-parse', 'HEAD'),
    pythonDirty: git(pythonSourceDir, 'status', '--porcelain=v1', '--untracked-files=all') !== '',
    pythonLockSha256: existsSync(lock) ? sha256(lock) : null,
  }
}

/**
 * bundle 里那份 manifest 还能代表当前 Python 源码吗?不能就返回原因(可直接打给用户),
 * 能就返回 undefined。
 *
 * 只盯 Python 三字段。manifest 里的 pussyCatCommit **故意不看**:bundle 建好之后本仓还会
 * 继续提交,拿它当门会逼着每提交一次就重建一次 wheel,那是另一种错。
 */
export function describeVkManifestDrift(pythonSource, vkManifestPath = VK_MANIFEST) {
  if (!existsSync(vkManifestPath)) {
    return `VK bundle 不存在(${vkManifestPath})—— 从未构建过`
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(vkManifestPath, 'utf8'))
  } catch {
    return `VK bundle manifest 不是合法 JSON(${vkManifestPath})`
  }
  const bundled = manifest?.source
  if (!bundled || typeof bundled !== 'object') {
    return 'VK bundle manifest 没有 source 溯源字段(schema 太旧)'
  }
  if (pythonSource.pythonDirty) {
    return 'Python 源码工作区有未提交改动 —— bundle 只能从干净的提交构建'
  }
  if (bundled.pythonDirty !== false) {
    return 'VK bundle manifest 记录它建自一个脏的 Python 工作区'
  }
  if (bundled.pythonCommit !== pythonSource.pythonCommit) {
    return `VK bundle 建自 Python ${String(bundled.pythonCommit).slice(0, 12)},`
      + `当前 Python 源码是 ${pythonSource.pythonCommit.slice(0, 12)}`
  }
  if (bundled.pythonLockSha256 !== pythonSource.pythonLockSha256) {
    return 'VK bundle 的 uv.lock 与当前 Python 源码不一致'
  }
  return undefined
}

export function isVkBundleManifestCurrent(
  stampValue,
  vkManifestPath = VK_MANIFEST,
  pythonSource = readPythonSource(),
) {
  return existsSync(vkManifestPath)
    && typeof stampValue?.vkBundleManifestSha256 === 'string'
    && stampValue.vkBundleManifestSha256 === sha256(vkManifestPath)
    // stamp 哈希只证明"manifest 自打包以来没被动过",证明不了"它还配得上现在的 Python 源码"。
    // 只改 Python 时 manifest 一个字节都不会变,少了这一步就正是第 5 条踩的坑。
    && describeVkManifestDrift(pythonSource, vkManifestPath) === undefined
}

export function createPackageStamp({
  name,
  source,
  startedAt,
  fresh,
  treeChangedDuringBuild,
  headAfter,
  vkManifestPath = VK_MANIFEST,
  pussyCatLockPath = PUSSYCAT_LOCK,
}) {
  const vkManifest = JSON.parse(readFileSync(vkManifestPath, 'utf8'))
  if (!vkManifest?.source || typeof vkManifest.source !== 'object') {
    throw new Error('[package] vk runtime manifest is missing source provenance')
  }
  return {
    productName: name,
    source: source.identity,
    commit: source.commit,
    dirty: source.dirty,
    ...(treeChangedDuringBuild ? { treeChangedDuringBuild: true, headAfterBuild: headAfter } : {}),
    builtAt: new Date(startedAt).toISOString(),
    videoKnowledgeSource: vkManifest.source,
    vkBundleManifestSha256: sha256(vkManifestPath),
    pussyCatLockSha256: existsSync(pussyCatLockPath) ? sha256(pussyCatLockPath) : null,
    artifacts: fresh.map((path) => ({ path, sha256: sha256(path) })),
  }
}

/**
 * 源码身份快照。**只在开头取一次,全程复用。**
 *
 * 曾经的 bug:identity 在脚本开头算、commit 在写 stamp 时又算一遍,中间隔着 1-2 分钟的构建。
 * 构建期间只要有人提交,两个字段就指向不同的 commit —— 而 stamp 存在的全部意义就是回答
 * 「这个包是哪个提交打的」,两字段自相矛盾时它一句话都不可信。
 * 实测撞到过一次(source=c713e2b 而 commit=a8fe82d),不是理论风险。
 *
 * 身份里**必须**带上 Python 引擎的 commit:安装包装的是两个仓库的产物,只认本仓等于
 * 把"只改了 Python"整类改动判成"无事发生"(见开头第 5 条)。`resources/vk/` 被 gitignore,
 * 指望它把 Python 改动带脏本仓是指望不上的。
 */
function sourceSnapshot(pythonSource = readPythonSource()) {
  const commit = git(root, 'rev-parse', 'HEAD')
  const changed = [
    ...git(root, 'diff', '--name-only', '-z', 'HEAD').split('\0'),
    ...git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean).sort()
  const dirty = changed.length > 0
  const vk = `+vk-${pythonSource.pythonCommit}${pythonSource.pythonDirty ? '-dirty' : ''}`
  if (!dirty) return { commit, dirty, pythonSource, identity: `${commit}${vk}` }

  // `HEAD-dirty` 无法区分同一提交上的两次不同修改，会让 package:check
  // 把旧安装包误判为最新。路径、内容和删除标记共同组成工作区身份。
  const digest = createHash('sha256')
  for (const relativePath of changed) {
    digest.update(relativePath)
    digest.update('\0')
    const absolutePath = join(root, relativePath)
    if (existsSync(absolutePath)) digest.update(readFileSync(absolutePath))
    else digest.update('<deleted>')
    digest.update('\0')
  }
  return { commit, dirty, pythonSource, identity: `${commit}-dirty-${digest.digest('hex')}${vk}` }
}

/** 现有产物(只认当前 productName 的那一份)。 */
function currentArtifacts(name) {
  const out = []
  for (const [dir, suffix] of [['nsis', '-setup.exe'], ['msi', '.msi']]) {
    const d = join(BUNDLE, dir)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (f.startsWith(`${name}_`) && f.endsWith(suffix)) out.push(join(d, f))
    }
  }
  return out
}

/** 清掉不属于当前 productName 的产物 —— 改名后的历代残留。 */
function pruneForeignArtifacts(name) {
  const removed = []
  for (const dir of ['nsis', 'msi']) {
    const d = join(BUNDLE, dir)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (f.startsWith(`${name}_`)) continue
      const p = join(d, f)
      if (!statSync(p).isFile()) continue
      rmSync(p)
      removed.push(f)
    }
  }
  return removed
}

export function main() {
const name = productName()
const source = sourceSnapshot()
const identity = source.identity
const stamp = readStamp()
const artifacts = currentArtifacts(name)
const vkDrift = describeVkManifestDrift(source.pythonSource)
const upToDate = !!stamp
  && stamp.source === identity
  && stamp.productName === name
  && artifacts.length > 0
  && areStampArtifactsCurrent(stamp, artifacts)
  && isVkBundleManifestCurrent(stamp, VK_MANIFEST, source.pythonSource)

if (CHECK_ONLY) {
  // 供钩子/脚本调用:0 = 已是最新无需打包,1 = 需要打包。**不做任何构建。**
  if (upToDate) {
    console.log(`[package] 已是最新:${name} @ ${identity.slice(0, 12)}(${stamp.builtAt})`)
    process.exit(0)
  }
  console.log(`[package] 需要打包:源码 ${identity.slice(0, 12)}${stamp ? `,上次打包 ${String(stamp.source).slice(0, 12)}` : '(从未打包)'}`)
  if (vkDrift) console.log(`[package] 且需要先重建 VK bundle:${vkDrift}`)
  process.exit(1)
}

if (upToDate && !FORCE) {
  console.log(`[package] 跳过:安装包已对应当前源码 ${identity.slice(0, 12)}`)
  for (const a of artifacts) console.log(`  ${a}`)
  console.log('[package] 需要强制重打请加 --force')
  process.exit(0)
}

// —— 门:不打包一个跟 Python 源码对不上的 bundle ——
// 放在类型检查/测试**之前**,也放在 --force 之后:本脚本从不自己重建 bundle,
// 而 --force 恰恰是"我知道它旧了,照打"的意思 —— 那正是把旧 wheel 装进包里的路径。
// 这里不代跑 build-vk-bundle:它会先 rm 掉整个 resources/vk/ 再重建,uv 不可用或
// Python 仓是脏的时候用户会连原来那份能用的 bundle 都没了。宁可停下来说清楚。
if (vkDrift) {
  console.error(`\n[package] ❌ ${vkDrift}`)
  console.error('[package] 继续打包只会把一个与 Python 源码不符的 wheel 装进安装包。')
  console.error('[package] 先重建 bundle,再打包:')
  console.error(`[package]   ${REBUILD_BUNDLE_HINT}`)
  console.error('[package]   npm run package -- --force')
  process.exit(1)
}

// —— 门:不打包一个红的构建 ——
if (!SKIP_GATES) {
  for (const [label, cmd, cmdArgs] of [
    ['类型检查', 'npx', ['tsc', '--noEmit']],
    ['单元测试', 'npx', ['vitest', 'run']],
    ['legacy 基线闸', 'npm', ['run', 'check:legacy']],
  ]) {
    console.log(`\n[package] ${label}…`)
    const { status } = run(cmd, cmdArgs)
    if (status !== 0) {
      console.error(`[package] ❌ ${label}失败(退出码 ${status})。**不打包红的构建。**`)
      process.exit(1)
    }
  }
}

// 构建起点:产物 mtime 必须新于它,否则说明这次构建根本没产出、目录里是上一次的旧文件。
const startedAt = Date.now()

console.log('\n[package] tauri build…')
const build = run('npm', ['run', 'tauri', 'build'])
if (build.status !== 0) {
  console.error(`[package] ❌ 构建失败(退出码 ${build.status})`)
  process.exit(1)
}

const fresh = currentArtifacts(name).filter((p) => statSync(p).mtimeMs >= startedAt)
if (fresh.length === 0) {
  // 这一条是本脚本存在的核心理由之一:构建"成功"但没有新产物,几乎总是意味着
  // 某个 bundler 静默失败或产物名变了。绝不能把上一次的旧包当成本次结果报出去。
  console.error('[package] ❌ 构建退出码为 0,但没有任何**新于本次构建起点**的产物。')
  console.error('[package] 目录里的文件是上一次留下的,不代表本次结果。')
  process.exit(1)
}

const pruned = pruneForeignArtifacts(name)
if (pruned.length > 0) console.log(`\n[package] 已清理历代改名残留:${pruned.join(', ')}`)

// 构建期间 HEAD 变了吗?变了说明产物来源是**混合态**:构建读盘就发生在这段时间里,
// 拿到的可能是变更前、变更后,甚至半新半旧。不失败(产物是真的,多半就是想要的那个),
// 但必须如实记下并显眼地说 —— 本脚本的承诺是"能说清这个包是哪个提交打的",
// 说不清时就要说说不清,不能默默给一个好看的 commit。
const sourceAfter = sourceSnapshot()
const headAfter = sourceAfter.commit
const treeChangedDuringBuild = sourceAfter.identity !== source.identity

mkdirSync(dirname(STAMP), { recursive: true })
const packageStamp = createPackageStamp({
  name,
  source,
  startedAt,
  fresh,
  treeChangedDuringBuild,
  headAfter,
})
writeFileSync(STAMP, `${JSON.stringify(packageStamp, null, 2)}\n`)

console.log(`\n[package] ✅ ${name} 打包完成`)
console.log(`[package] 源码 ${identity}`)
for (const a of fresh) console.log(`  ${a}`)
if (source.dirty) {
  console.log('[package] ⚠️ 工作区有未提交改动,这个包对应的不是任何一个提交。')
}
if (treeChangedDuringBuild) {
  console.log(`[package] ⚠️ 构建期间 HEAD 从 ${source.commit.slice(0, 12)} 变成了 ${headAfter.slice(0, 12)}。`)
  console.log('[package] 这个包的来源是混合态,归属说不清。建议重跑一次以拿到可归属的产物。')
}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    // 读不到 Python 仓是最常见的一种:退出码 1 对 --check 恰好就是"需要打包",
    // 保守方向正确 —— 但要把原因打出来,别只剩一个裸退出码。
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
