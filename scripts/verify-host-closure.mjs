// 🔴 隔离闭包硬闸(计划 T4):把 dist-host/ 整树复制到**无任何祖先 node_modules** 的临时目录,
// 用系统 node 起 Host,跑通 readiness/health/catalog/start 全链并校验 SHA-256 清单。
// 这道闸的全部意义在于"无祖先 node_modules"——在仓库内跑永远会被仓库自己的依赖救活,证明不了闭包。
// 用法:node scripts/verify-host-closure.mjs   (先 npm run build:host)
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distHost = join(root, 'dist-host')
const ORIGIN = 'http://127.0.0.1:5173'
const READY_TIMEOUT_MS = 30_000
const RUN_TIMEOUT_MS = 90_000

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

function startHost(entry) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, OPENCLI_HOST_PORT: '0' },
    shell: false,
    windowsHide: true,
  })
  let stderrTail = ''
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-2000) })
  const ready = new Promise((resolvePromise, rejectPromise) => {
    let buf = ''
    const timer = setTimeout(() => rejectPromise(new Error(`readiness 超时;stdout=${buf} stderr=${stderrTail}`)), READY_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      buf += chunk
      for (const line of buf.split('\n')) {
        if (!line.includes('opencliHostReady')) continue
        clearTimeout(timer)
        try { resolvePromise(JSON.parse(line)) } catch (e) { rejectPromise(e) }
        return
      }
    })
    child.once('error', (e) => { clearTimeout(timer); rejectPromise(e) })
    child.once('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`Host 提前退出(${code});stderr=${stderrTail}`)) })
  })
  return { child, ready, stderrTail: () => stderrTail }
}

// 读 SSE 直到 done 事件(不依赖 EventSource,用 fetch body reader)
async function waitForDone(baseUrl, runId) {
  const res = await fetch(`${baseUrl}/events`, { headers: { Origin: ORIGIN } })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let at
    while ((at = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, at)
      pending = pending.slice(at + 2)
      const type = block.match(/^event: (.+)$/m)?.[1]
      const data = block.match(/^data: (.+)$/m)?.[1]
      if (type === 'done' && data) {
        const evt = JSON.parse(data)
        if (evt.runId === runId) { await reader.cancel(); return evt }
      }
    }
  }
  await reader.cancel()
  throw new Error('等待 done 事件超时')
}

// 隔离根**自动挑选**:闸门的前提是"无任何祖先 node_modules",而 os.tmpdir() 通常在
// C:\Users\<user>\AppData\... 之下,C:\Users\<user>\node_modules 就在 Node 的向上解析路径上
// (本机就是如此)。要人肉记得带 OPENCLI_CLOSURE_ROOT 才 8/8 的闸门等于半废——
// 裸跑必红会训练出"这条红是正常的"的坏习惯,红灯就此失去意义。
// 依次尝试:显式覆盖 → tmpdir → tmpdir 的各级祖先 → 仓库所在盘根;取第一个既满足条件又可写的。
function ancestorWithNodeModules(dir) {
  let cur = resolve(dir)
  for (let i = 0; i < 32; i += 1) {
    try { if (statSync(join(cur, 'node_modules')).isDirectory()) return cur } catch { /* 无则继续上溯 */ }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function candidateRoots() {
  const out = []
  if (process.env.OPENCLI_CLOSURE_ROOT) out.push(process.env.OPENCLI_CLOSURE_ROOT)
  out.push(tmpdir())
  let cur = resolve(tmpdir())
  for (let i = 0; i < 32; i += 1) {
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
    out.push(cur)
  }
  out.push(parse(resolve(root)).root)
  return [...new Set(out.map((p) => resolve(p)))]
}

let tmpRoot = null
let isolationBase = null
const rejectedRoots = []
for (const base of candidateRoots()) {
  const blocker = ancestorWithNodeModules(base)
  if (blocker) { rejectedRoots.push(`${base} → 祖先 node_modules: ${blocker}`); continue }
  try {
    tmpRoot = mkdtempSync(join(base, 'opencli-closure-'))
    isolationBase = base
    break
  } catch (error) {
    rejectedRoots.push(`${base} → 不可写(${error.code ?? error.message})`)
  }
}
if (!tmpRoot) {
  console.error('❌ 找不到无祖先 node_modules 且可写的隔离根;试过:')
  for (const line of rejectedRoots) console.error(`   - ${line}`)
  console.error('   用 OPENCLI_CLOSURE_ROOT=<某个干净目录> 显式指定。')
  process.exit(1)
}
// 被跳过的候选要说出来:显式设了 OPENCLI_CLOSURE_ROOT 却被跳过时,静默忽略最坑人。
for (const line of rejectedRoots) console.log(`[closure] 跳过候选 ${line}`)
console.log(`[closure] 隔离根:${isolationBase}`)
const isolated = join(tmpRoot, 'host')
let child

try {
  // 0) 清单校验(在原树上做,证明构建产物自洽)
  const manifest = JSON.parse(readFileSync(join(distHost, 'runtime-manifest.json'), 'utf8'))
  const files = walk(distHost).filter((p) => !p.endsWith('runtime-manifest.json'))
  let mismatch = 0
  for (const entry of manifest.files) {
    const p = join(distHost, entry.path)
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
    if (actual !== entry.sha256) mismatch += 1
  }
  check('runtime-manifest 文件数一致', files.length === manifest.fileCount, `实际 ${files.length} / 清单 ${manifest.fileCount}`)
  check('runtime-manifest SHA-256 全部匹配', mismatch === 0, `不匹配 ${mismatch} 个`)

  // 1) 复制到无祖先 node_modules 的隔离目录
  cpSync(distHost, isolated, { recursive: true })
  // 复制之后**再查一遍**:选根时干净不代表现在干净(选根与复制之间隔着 I/O)。
  // 这条依然是真检查,不是走过场——它证的是"这次跑的隔离前提确实成立"。
  const ancestorHasNodeModules = ancestorWithNodeModules(tmpRoot)
  check('隔离目录无祖先 node_modules', ancestorHasNodeModules === null,
    ancestorHasNodeModules ? `被 ${ancestorHasNodeModules} 污染` : `根=${isolationBase}${rejectedRoots.length ? `(跳过 ${rejectedRoots.length} 个候选)` : ''}`)

  // 2) 起 Host
  const started = startHost(join(isolated, 'server', 'index.mjs'))
  child = started.child
  const ready = await started.ready
  check('readiness JSON 合法且端口有效', ready.opencliHostReady === true && Number.isInteger(ready.port) && ready.port > 0,
    `port=${ready.port} opencli=${ready.opencliVersion} policy=${ready.policyCommands}`)
  const baseUrl = `http://127.0.0.1:${ready.port}`

  // 3) /health
  const health = await fetch(`${baseUrl}/health`, { headers: { Origin: ORIGIN } })
  check('GET /health 200', health.status === 200)

  // 4) /catalog —— 真 spawn 内置 opencli list,证明 opencli 闭包成立
  const catalogRes = await fetch(`${baseUrl}/catalog`, { headers: { Origin: ORIGIN } })
  const catalog = catalogRes.ok ? await catalogRes.json() : null
  check('GET /catalog 200 且命令数 > 1000（真 spawn 内置 opencli）',
    catalogRes.status === 200 && (catalog?.commands?.length ?? 0) > 1000,
    `status=${catalogRes.status} commands=${catalog?.commands?.length ?? 'n/a'}`)

  // 5) /start 真跑一条只读命令,等 done
  const runId = crypto.randomUUID()
  const donePromise = waitForDone(baseUrl, runId)
  const startRes = await fetch(`${baseUrl}/start`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, commandKey: '36kr/news', argv: ['36kr', 'news', '-f', 'json'] }),
  })
  check('POST /start 202', startRes.status === 202, `status=${startRes.status}`)
  const done = await donePromise
  check('run 终态 success 且有结果行', done.outcome === 'success' && (done.result?.length ?? 0) > 0,
    `outcome=${done.outcome} rows=${done.result?.length ?? 0}`)
} catch (error) {
  check('执行未抛异常', false, error instanceof Error ? error.message : String(error))
} finally {
  child?.kill('SIGKILL')
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响判定 */ }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== 闭包硬闸:${checks.length - failed.length}/${checks.length} 通过 ===`)
process.exit(failed.length === 0 ? 0 : 1)
