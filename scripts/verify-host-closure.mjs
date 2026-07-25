// 🔴 隔离闭包硬闸(计划 T4):把 dist-host/ 整树复制到**无任何祖先 node_modules** 的临时目录,
// 用系统 node 起 Host,跑通 readiness/health/catalog/start 全链并校验 SHA-256 清单。
// 这道闸的全部意义在于"无祖先 node_modules"——在仓库内跑永远会被仓库自己的依赖救活,证明不了闭包。
// 用法:node scripts/verify-host-closure.mjs   (先 npm run build:host)
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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

// 隔离根可覆盖:默认 os.tmpdir(),但本机 tmpdir 位于 C:\Users\<user>\AppData\...,
// 其祖先 C:\Users\<user>\node_modules 在 Node 的向上解析路径上——闸门的前提应结构性成立,
// 不能指望"碰巧那个 node_modules 里没有 opencli"。用 OPENCLI_CLOSURE_ROOT=C:/ 可拿到真隔离。
const isolationBase = process.env.OPENCLI_CLOSURE_ROOT ?? tmpdir()
const tmpRoot = mkdtempSync(join(isolationBase, 'opencli-closure-'))
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
  const ancestorHasNodeModules = (() => {
    let dir = tmpRoot
    for (let i = 0; i < 8; i += 1) {
      try { if (statSync(join(dir, 'node_modules')).isDirectory()) return dir } catch { /* 无则继续上溯 */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  })()
  check('隔离目录无祖先 node_modules', ancestorHasNodeModules === null, ancestorHasNodeModules ?? isolated)

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
