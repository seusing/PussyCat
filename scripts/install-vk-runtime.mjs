// video-knowledge 版本化独立 runtime 安装器(阶段 5)。
//
// 布局(<home> = 爪爪数据根,按拍板 6 分目录):
//   <home>/runtime/versions/<version>/   uv venv(独立 CPython,系统 Python 原状不动)
//   <home>/runtime/active.json           唯一激活指针(tmp+rename 原子切换)
//   <home>/{models,data,cache,temp}
//
// 切换纪律:import → console → API 握手 → DB 迁移 smoke(临时库)四门全绿,
// 且真实 vk.db(若存在)先备份再迁移成功,才原子改写 active.json;
// 任何一步失败旧 runtime 与旧 DB 原样可用。
//
// 用法:node scripts/install-vk-runtime.mjs --wheel <path> --home <dir>
//        [--version <v>] [--python 3.12] [--extra media-asr]... [--simulate-broken-wheel]
import { spawnSync, spawn } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, statfsSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIN_FREE_BYTES = 1 * 1024 ** 3 // 基础 runtime 预检;重型模型步另有 5GB 预检

function parseArgs(argv) {
  const args = { extras: [], python: '3.12' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--wheel') args.wheel = argv[++i]
    else if (key === '--home') args.home = argv[++i]
    else if (key === '--version') args.version = argv[++i]
    else if (key === '--python') args.python = argv[++i]
    else if (key === '--extra') args.extras.push(argv[++i])
    else if (key === '--simulate-broken-wheel') args.simulateBroken = true
    else throw new Error(`unknown argument: ${key}`)
  }
  if (!args.wheel || !args.home) throw new Error('--wheel and --home are required')
  return args
}

function log(step, message) {
  console.log(`[vk-runtime] ${step}: ${message}`)
}

function fail(step, message) {
  console.error(`[vk-runtime] FAIL ${step}: ${message}`)
  console.error('[vk-runtime] 旧 runtime 与旧 DB 未被触碰,继续可用。')
  process.exit(1)
}

function run(step, command, argv, options = {}) {
  log(step, `${command} ${argv.join(' ')}`)
  const result = spawnSync(command, argv, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error) fail(step, String(result.error.message ?? result.error))
  // 真实下载/初始化输出原样透传(不造进度)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) fail(step, `exit ${result.status}`)
  return result
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home)
const wheel = resolve(args.wheel)
if (!existsSync(wheel)) fail('preflight', `wheel 不存在: ${wheel}`)

for (const dir of ['runtime/versions', 'models', 'data', 'cache', 'temp']) {
  mkdirSync(join(home, dir), { recursive: true })
}

// —— 路径长度预检 ——
// 实测:home 过深时 site-packages 内 260+ 字符的文件(如 jsonschema_specifications
// 的 vocabularies/format-annotation)uv 写得进(\\?\ 前缀)、Python io.open 读不出
// (未开 LongPathsEnabled 的 Windows 默认),表现为 runtime 装完即坏。
// 最深相对路径约 150 字符,home 超过 100 一律拒绝。
if (home.length > 100) {
  fail('preflight', `home 路径过长(${home.length} 字符,上限 100):Windows MAX_PATH 下 runtime 会装完即坏。换短路径(如 %LOCALAPPDATA%\\爪爪-data)。`)
}

// —— 磁盘预检 ——
const stats = statfsSync(home)
const freeBytes = stats.bavail * stats.bsize
log('preflight', `free=${(freeBytes / 1024 ** 3).toFixed(2)}GiB required>=${(MIN_FREE_BYTES / 1024 ** 3).toFixed(2)}GiB`)
if (freeBytes < MIN_FREE_BYTES) fail('preflight', '磁盘可用空间不足')
if (args.extras.includes('media-asr')) {
  const heavy = 5 * 1024 ** 3
  if (freeBytes < heavy) fail('preflight', `media-asr 需要 >=5GiB 可用空间(现有 ${(freeBytes / 1024 ** 3).toFixed(2)}GiB)`)
}

const wheelName = wheel.split(/[\\/]/).pop() ?? 'wheel'
const version = args.version ?? `${wheelName.replace(/\.whl$/, '')}+${Date.now()}`
const versionDir = join(home, 'runtime', 'versions', version)
if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true })

// —— venv(uv 管理的独立 CPython;绝不动系统 Python)——
run('venv', 'uv', ['venv', '--python', args.python, versionDir])
const pythonExe = join(versionDir, 'Scripts', 'python.exe')

// —— 安装 wheel(+按能力选装的重型 extras;uv 输出=真实下载/构建阶段)——
let installTarget = wheel
if (args.simulateBroken) {
  const broken = join(home, 'temp', 'broken.whl')
  writeFileSync(broken, 'this is not a wheel')
  installTarget = broken
  log('install', '注入模式:使用损坏的 wheel 验证失败路径')
}
const spec = args.extras.length
  ? `video-knowledge[${args.extras.join(',')}] @ file:///${installTarget.replace(/\\/g, '/')}`
  : installTarget
// link-mode=copy:硬链接模式在部分 Windows 路径形态(8.3 短名)下出现过包数据
// 文件缺失,runtime 必须自包含,统一实拷。
run('install', 'uv', ['pip', 'install', '--link-mode', 'copy', '--python', pythonExe, spec])

// —— smoke 1:import ——
run('smoke-import', pythonExe, ['-c', 'import video_knowledge, importlib.metadata as m; print("import ok", m.version("video-knowledge"))'])

// —— smoke 2:console ——
run('smoke-console', pythonExe, ['-m', 'video_knowledge', '-h'])

// —— smoke 3:API 握手(真 gui 进程 + token + /api/meta)——
const smokeRoot = mkdtempSync(join(tmpdir(), 'vk-smoke-'))
const token = 'runtime-smoke-token-0123456789abcdef'
await (async () => {
  const child = spawn(pythonExe, ['-m', 'video_knowledge', 'gui', '--root', join(smokeRoot, 'data'), '--config-dir', join(smokeRoot, 'config'), '--port', '0', '--no-browser'], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VK_UI_TOKEN: token },
  })
  let stderrTail = ''
  child.stderr.on('data', (chunk) => { stderrTail += chunk.toString('utf8') })
  try {
    const port = await new Promise((resolvePort, rejectPort) => {
      const timer = setTimeout(() => rejectPort(new Error(`ready 超时;stderr: ${stderrTail.slice(-500)}`)), 30_000)
      let buffered = ''
      child.stdout.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const match = /gui=http:\/\/127\.0\.0\.1:(\d+)/.exec(buffered)
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
      })
      child.once('exit', (code) => rejectPort(new Error(`gui 提前退出(${code});stderr: ${stderrTail.slice(-500)}`)))
    })
    const response = await fetch(`http://127.0.0.1:${port}/api/meta`, { headers: { 'X-VK-Token': token } })
    const meta = await response.json()
    if (!response.ok || meta.service !== 'video-knowledge' || meta.shell_mode !== true) {
      throw new Error(`meta 握手异常: status=${response.status} service=${meta.service} shell_mode=${meta.shell_mode}`)
    }
    log('smoke-api', `handshake ok api_version=${meta.api_version} package=${meta.package_version}`)
  } catch (error) {
    child.kill('SIGKILL')
    fail('smoke-api', String(error?.message ?? error))
  }
  child.kill('SIGKILL')
})()

// —— smoke 4:DB 迁移(临时库,001..007 全量)——
const migrateSnippet = 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1]) / "vk.db"); print(json.dumps(migrate(conn, default_migrations_dir())))'
const smokeMigrate = run('smoke-migrate', pythonExe, ['-c', migrateSnippet, join(smokeRoot, 'migrate-smoke')])
if (!smokeMigrate.stdout.includes('"007"')) fail('smoke-migrate', `迁移清单缺 007: ${smokeMigrate.stdout.trim()}`)

// —— 真实 DB:迁移前备份,失败还原,成功才允许切换 ——
const realDb = join(home, 'data', 'vk.db')
if (existsSync(realDb)) {
  const backup = `${realDb}.backup-${version.replace(/[^\w.-]/g, '_')}-${Date.now()}`
  copyFileSync(realDb, backup)
  log('db-migrate', `已备份真实库 -> ${backup}`)
  const result = spawnSync(pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1])); print(json.dumps(migrate(conn, default_migrations_dir())))', realDb], { shell: false, windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) {
    copyFileSync(backup, realDb)
    fail('db-migrate', `真实库迁移失败,已从备份还原: ${result.stderr?.slice(-400)}`)
  }
  log('db-migrate', `真实库迁移完成 applied=${result.stdout.trim()}`)
}

// —— 原子切换 active 指针 ——
const activePath = join(home, 'runtime', 'active.json')
const previous = existsSync(activePath) ? readFileSync(activePath, 'utf8') : null
const payload = JSON.stringify({
  version,
  pythonPath: pythonExe,
  wheel: wheelName,
  installedAt: new Date().toISOString(),
  extras: args.extras,
}, null, 2)
writeFileSync(`${activePath}.tmp`, payload, 'utf8')
renameSync(`${activePath}.tmp`, activePath)
log('activate', `active -> ${version}${previous ? '(替换旧指针)' : ''}`)
rmSync(smokeRoot, { recursive: true, force: true })
console.log(JSON.stringify({ vkRuntimeInstalled: true, version, pythonPath: pythonExe }))
