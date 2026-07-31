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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = join(root, '.package-stamp.json')
const BUNDLE = join(root, 'src-tauri/target/release/bundle')

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

function git(...gitArgs) {
  return run('git', gitArgs, { capture: true }).stdout.trim()
}

function productName() {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  return conf.productName
}

function readStamp() {
  if (!existsSync(STAMP)) return undefined
  try { return JSON.parse(readFileSync(STAMP, 'utf8')) } catch { return undefined }
}

/** 当前源码身份:commit + 工作区是否有未提交改动(脏则带 -dirty,永远与已提交态不等值)。 */
function sourceIdentity() {
  const commit = git('rev-parse', 'HEAD')
  const dirty = git('status', '--porcelain') !== ''
  return dirty ? `${commit}-dirty` : commit
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

const name = productName()
const identity = sourceIdentity()
const stamp = readStamp()
const artifacts = currentArtifacts(name)
const upToDate = !!stamp && stamp.source === identity && stamp.productName === name && artifacts.length > 0

if (CHECK_ONLY) {
  // 供钩子/脚本调用:0 = 已是最新无需打包,1 = 需要打包。**不做任何构建。**
  if (upToDate) {
    console.log(`[package] 已是最新:${name} @ ${identity.slice(0, 12)}(${stamp.builtAt})`)
    process.exit(0)
  }
  console.log(`[package] 需要打包:源码 ${identity.slice(0, 12)}${stamp ? `,上次打包 ${String(stamp.source).slice(0, 12)}` : '(从未打包)'}`)
  process.exit(1)
}

if (upToDate && !FORCE) {
  console.log(`[package] 跳过:安装包已对应当前源码 ${identity.slice(0, 12)}`)
  for (const a of artifacts) console.log(`  ${a}`)
  console.log('[package] 需要强制重打请加 --force')
  process.exit(0)
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

mkdirSync(dirname(STAMP), { recursive: true })
writeFileSync(STAMP, `${JSON.stringify({
  productName: name,
  source: identity,
  commit: git('rev-parse', 'HEAD'),
  builtAt: new Date(startedAt).toISOString(),
  artifacts: fresh,
}, null, 2)}\n`)

console.log(`\n[package] ✅ ${name} 打包完成`)
console.log(`[package] 源码 ${identity}`)
for (const a of fresh) console.log(`  ${a}`)
if (identity.endsWith('-dirty')) {
  console.log('[package] ⚠️ 工作区有未提交改动,这个包对应的不是任何一个提交。')
}
