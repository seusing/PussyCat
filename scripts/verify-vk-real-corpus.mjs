// 阶段 6 · 真实语料验证(零模型调用零费用):真 Node Host + 真 sidecar 指向
// 既有 M4 真实知识库(10 条帕鲁笔记,vk.db 643 行索引),验证「任务恢复展示 +
// 产物 + 知识库查询」在 shell 契约面上的真实表现。只读使用:不提交任何任务。
// 前置:vk.db 已备份(调用方负责)。
// 用法:node scripts/verify-vk-real-corpus.mjs [corpusRoot] [configDir]
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'http://127.0.0.1:5173'
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const corpusRoot = process.argv[2] ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-data\\m4-corpus'
const configDir = process.argv[3] ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\config'
const pythonPath = 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\.venv\\Scripts\\python.exe'

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function pythonPidsOf(parentPid) {
  try {
    const out = execFileSync(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Where-Object { $_.Name -like 'python*' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8' },
    )
    return out.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter(Number.isFinite)
  } catch {
    return []
  }
}

function processAlive(pid) {
  try {
    const out = execFileSync('C:\\Windows\\System32\\tasklist.exe', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

const host = spawn(process.execPath, [join(projectRoot, 'server', 'index.mjs')], {
  shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OPENCLI_HOST_PORT: '0',
    OPENCLI_HOST_VK_PYTHON: pythonPath,
    OPENCLI_HOST_VK_ROOT: corpusRoot,
    OPENCLI_HOST_VK_CONFIG_DIR: configDir,
  },
})
let hostStderr = ''
host.stderr.on('data', (chunk) => { hostStderr += chunk.toString('utf8') })
const readyLine = await new Promise((resolveReady, rejectReady) => {
  const timer = setTimeout(() => rejectReady(new Error(`host readiness timeout; ${hostStderr.slice(-300)}`)), 20_000)
  let buffered = ''
  host.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    if (buffered.includes('opencliHostReady')) { clearTimeout(timer); resolveReady(buffered.split(/\r?\n/).find((l) => l.includes('opencliHostReady'))) }
  })
  host.once('exit', (code) => rejectReady(new Error(`host exited early (${code})`)))
})

let exitCode = 1
let pythonPids = []
try {
  const base = `http://127.0.0.1:${JSON.parse(readyLine).port}`
  const headers = { Origin: ORIGIN }

  // 历史任务重现(vk.db 真源):10 条真实入库 run 应可列出
  const rows = await (await fetch(`${base}/vk/v1/jobs`, { headers })).json()
  pythonPids = pythonPidsOf(host.pid)
  const doneRuns = rows.filter((row) => row.kind === 'run' && row.status === 'done')
  check('historical real runs listed from vk.db', doneRuns.length >= 10, `done runs=${doneRuns.length} total rows=${rows.length}`)
  const totalCost = doneRuns.reduce((sum, row) => sum + (row.cost_cny ?? 0), 0)
  check('real ledger costs surface on rows', totalCost > 1, `sum=${totalCost.toFixed(4)} CNY(历史已付,非本次)`)

  // 单条 run 视图:产物重建 + 零绝对路径
  const target = doneRuns.find((row) => (row.cost_cny ?? 0) > 0) ?? doneRuns[0]
  const view = await (await fetch(`${base}/vk/v1/jobs/${target.job_id}`, { headers })).json()
  check('run view rebuilds outputs', typeof view.outputs?.note_path === 'string' && view.outputs.note_path.startsWith('out_'), `note=${view.outputs?.note_path}`)
  check('view carries zero absolute paths', !/[A-Za-z]:(\\\\|\\|\/)/.test(JSON.stringify(view)))

  const note = await (await fetch(`${base}/vk/v1/outputs/${view.outputs.note_path}`, { headers })).text()
  check('real note downloadable with substance', note.length > 500, `bytes=${note.length}`)

  // 知识库查询(真 FTS 643 行,零模型调用)
  const answer = await (await fetch(`${base}/vk/v1/query`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '帕鲁' }),
  })).json()
  check('real-corpus query answers with citations', answer.status === 'answered' && (answer.citations ?? []).length > 0, `status=${answer.status} citations=${(answer.citations ?? []).length}`)

  exitCode = checks.every((item) => item.passed) ? 0 : 1
} catch (error) {
  check('verify-vk-real-corpus completed', false, String(error?.message ?? error))
  exitCode = 1
} finally {
  host.kill('SIGTERM')
  await new Promise((resolveExit) => { host.once('exit', resolveExit); setTimeout(resolveExit, 5000) })
  await new Promise((resolveTick) => setTimeout(resolveTick, 800))
  const orphans = pythonPids.filter((pid) => processAlive(pid))
  check('zero orphan python', orphans.length === 0, orphans.join(','))
  if (orphans.length) exitCode = 1
}
console.log(JSON.stringify({ vkRealCorpus: exitCode === 0, checks: checks.length }, null, 2))
process.exit(exitCode)
