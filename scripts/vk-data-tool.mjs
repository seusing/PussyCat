// 爪爪 × video-knowledge 数据生命周期工具(阶段 5)。
//
// 子命令:
//   report            各目录体量 + 磁盘余量(预检口)
//   verify            DB integrity_check + artifact 文件悬空检查(经 active runtime 的 Python 执行 SQL,零新依赖)
//   export --out <zip> 显式清理前的知识库导出(data 目录整体)
//   clean  --cache --temp --uploads [--yes]  分类清理(默认 dry-run)
//   purge  --yes      显式清理整个知识库(卸载保留的反向口;之后 artifact/index/LinkEdge/upload/cache 记录数=0)
//
// 用法:node scripts/vk-data-tool.mjs <sub> --home <dir> [...]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join, resolve } from 'node:path'

function parse(argv) {
  const [sub, ...rest] = argv
  const args = { sub, flags: new Set(), values: {} }
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]
    if (key === '--home' || key === '--out') args.values[key.slice(2)] = rest[++i]
    else if (key.startsWith('--')) args.flags.add(key.slice(2))
    else throw new Error(`unknown argument: ${key}`)
  }
  if (!args.sub) throw new Error('missing subcommand (report|verify|export|clean|purge)')
  if (!args.values.home) throw new Error('--home is required')
  return args
}

function dirBytes(path) {
  if (!existsSync(path)) return 0
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? dirBytes(child) : statSync(child).size
  }
  return total
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(3)}GiB`
}

function activePython(home) {
  const activePath = join(home, 'runtime', 'active.json')
  if (!existsSync(activePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(activePath, 'utf8'))
    return typeof parsed.pythonPath === 'string' && existsSync(parsed.pythonPath) ? parsed.pythonPath : null
  } catch {
    return null
  }
}

const VERIFY_SNIPPET = String.raw`
import json, sqlite3, sys
from pathlib import Path
home = Path(sys.argv[1])
db = home / "data" / "vk.db"
out = {"db_exists": db.is_file()}
if db.is_file():
    conn = sqlite3.connect(db)
    out["integrity"] = conn.execute("PRAGMA integrity_check").fetchone()[0]
    def count(table):
        try:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.Error:
            return None
    out["counts"] = {t: count(t) for t in ("artifacts", "search_documents", "link_edges", "pipeline_runs")}
    dangling = []
    try:
        for (uri,) in conn.execute("SELECT storage_uri FROM artifacts"):
            if not (home / "data" / uri).is_file():
                dangling.append(uri)
    except sqlite3.Error:
        pass
    out["dangling_artifact_files"] = dangling
uploads = home / "data" / "uploads"
out["upload_files"] = len(list(uploads.iterdir())) if uploads.is_dir() else 0
print(json.dumps(out, ensure_ascii=False))
`

const args = parse(process.argv.slice(2))
const home = resolve(args.values.home)
const dirs = ['runtime', 'models', 'data', 'cache', 'temp']

if (args.sub === 'report') {
  const stats = statfsSync(existsSync(home) ? home : '.')
  console.log(`[vk-data] home=${home}`)
  for (const name of dirs) {
    console.log(`[vk-data] ${name.padEnd(8)} ${gib(dirBytes(join(home, name)))}`)
  }
  console.log(`[vk-data] disk-free ${gib(stats.bavail * stats.bsize)}`)
  process.exit(0)
}

if (args.sub === 'verify') {
  const python = activePython(home)
  if (!python) {
    console.error('[vk-data] verify 需要 active runtime(runtime/active.json)')
    process.exit(1)
  }
  const result = spawnSync(python, ['-c', VERIFY_SNIPPET, home], { shell: false, windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stderr)
    process.exit(1)
  }
  const verdict = JSON.parse(result.stdout.trim())
  console.log(JSON.stringify(verdict, null, 2))
  const clean = (!verdict.db_exists || (verdict.integrity === 'ok' && verdict.dangling_artifact_files.length === 0))
  process.exit(clean ? 0 : 1)
}

if (args.sub === 'export') {
  const out = args.values.out
  if (!out) throw new Error('--out <zip> is required')
  const data = join(home, 'data')
  if (!existsSync(data)) throw new Error(`没有可导出的知识库: ${data}`)
  const result = spawnSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', resolve(out), '-C', home, 'data'], { shell: false, windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stderr)
    process.exit(1)
  }
  console.log(`[vk-data] exported -> ${resolve(out)}`)
  process.exit(0)
}

if (args.sub === 'clean') {
  const targets = ['cache', 'temp', 'uploads'].filter((name) => args.flags.has(name))
  if (targets.length === 0) throw new Error('choose at least one of --cache --temp --uploads')
  for (const name of targets) {
    const path = name === 'uploads' ? join(home, 'data', 'uploads') : join(home, name)
    const bytes = dirBytes(path)
    if (!args.flags.has('yes')) {
      console.log(`[vk-data] dry-run: would clean ${name} (${gib(bytes)}) at ${path}`)
      continue
    }
    rmSync(path, { recursive: true, force: true })
    console.log(`[vk-data] cleaned ${name} (${gib(bytes)})`)
  }
  process.exit(0)
}

if (args.sub === 'purge') {
  if (!args.flags.has('yes')) {
    console.log('[vk-data] purge 是显式清理整个知识库(data/cache/temp/models)。先 export 再加 --yes。')
    process.exit(1)
  }
  for (const name of ['data', 'cache', 'temp', 'models']) {
    rmSync(join(home, name), { recursive: true, force: true })
    console.log(`[vk-data] purged ${name}`)
  }
  process.exit(0)
}

throw new Error(`unknown subcommand: ${args.sub}`)
