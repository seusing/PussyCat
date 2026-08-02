// 阶段 6 · sidecar kill 矩阵(Python 层):运行中强杀 → 类型化诊断 →
// 懒重拉 + 重启 reconcile(interrupted)→ 重启零自动扣费 → 显式重提交完成 →
// SQLite integrity ok → 零孤儿。
//
// 扣费语义锚定(契约 §7):kill/restart 本身零新增模型调用;interrupted 的
// 显式 retry 是新的用户决策(此处新 key 重提交计新调用)。
// 用法:node scripts/verify-vk-kill-matrix.mjs [pythonPath]
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'http://127.0.0.1:5173'
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pythonPath = process.argv[2]
  ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\.venv\\Scripts\\python.exe'

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const CHAPTER_REPLY = JSON.stringify([{ idx: 0, title: '相对论引言', start_ms: 0, end_ms: 9500, summary: '介绍光速' }])
const CLAIM_REPLY = JSON.stringify([{
  claim_text: '光速约每秒三十万公里', claim_type: 'speaker_claim',
  speaker_stance: '陈述', source_certainty: 'firm', confidence: 0.95,
  evidence: [{ start_ms: 4200, end_ms: 9500, quote: '光速在真空中约为每秒三十万公里' }],
}])
let modelCalls = 0
let slowMode = true
let claimReached = null
const claimReachedPromise = new Promise((resolveReached) => { claimReached = resolveReached })
const stub = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    modelCalls += 1
    const isChapter = modelCalls === 1 || (!slowMode && modelCalls === 3)
    const reply = isChapter ? CHAPTER_REPLY : CLAIM_REPLY
    const respond = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        model: 'stub-cheap',
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }))
    }
    if (slowMode && modelCalls === 2) {
      claimReached()
      setTimeout(respond, 60_000).unref() // 卡住 claim,给强杀窗口
      return
    }
    respond()
  })
})
await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen))
const stubPort = stub.address().port

const home = mkdtempSync(join(tmpdir(), 'vk-kill-'))
const configDir = join(home, 'config')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'providers.toml'), `price_snapshot_id = "e2e-stub"

[tiers]
cheap = ["stub:cheap"]

[stage_tiers]
default = "cheap"

[providers.stub]
kind = "openai"
base_url = "http://127.0.0.1:${stubPort}/v1"
api_key_env = "VK_STUB_KEY"
allowed_data_levels = ["L0", "L1", "L2"]

[providers.stub.models.cheap]
model_id = "stub-cheap"
api_style = "openai_completions"
in_cny = 10.0
out_cny = 30.0
cached_in_cny = 1.0
`, 'utf8')

const SRT = `1
00:00:00,000 --> 00:00:04,000
相对论引言,介绍背景。

2
00:00:04,200 --> 00:00:09,500
光速在真空中约为每秒三十万公里。
`

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
    OPENCLI_HOST_VK_ROOT: join(home, 'data'),
    OPENCLI_HOST_VK_CONFIG_DIR: configDir,
    OPENCLI_HOST_VK_STATE_DIR: join(home, 'node-state'),
    VK_STUB_KEY: 'stub-key-not-a-secret',
  },
})
let hostStderr = ''
host.stderr.on('data', (chunk) => { hostStderr += chunk.toString('utf8') })
const readyLine = await new Promise((resolveReady, rejectReady) => {
  const timer = setTimeout(() => rejectReady(new Error(`host readiness timeout; ${hostStderr.slice(-400)}`)), 20_000)
  let buffered = ''
  host.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    for (const line of buffered.split(/\r?\n/)) {
      if (line.includes('opencliHostReady')) { clearTimeout(timer); resolveReady(line) }
    }
  })
  host.once('exit', (code) => rejectReady(new Error(`host exited early (${code})`)))
})

let exitCode = 1
let killedPids = []
try {
  const base = `http://127.0.0.1:${JSON.parse(readyLine).port}`
  const headers = { Origin: ORIGIN }
  const json = { ...headers, 'Content-Type': 'application/json' }
  const posted = async (path, payload) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(payload) })
    const body = await response.json()
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body).slice(0, 200)}`)
    return body
  }

  const uploaded = await (await fetch(`${base}/vk/v1/uploads?name=lecture.srt`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(SRT, 'utf8'),
  })).json()
  // 投影提交(1.3.0 正路):幂等指纹基于客户端形态,重启后原 key 原 body 可精确重放
  const idempotencyKey = crypto.randomUUID()
  const projection = {
    source: `upload:${uploaded.upload_id}`,
    preset: 'quick-summary',
    max_cost_cny: 5,
    idempotency_key: idempotencyKey,
    client_job_id: crypto.randomUUID(),
  }
  const created = await posted('/vk/v1/jobs', projection)

  // 等 claim 真正到达 stub(执行中),再强杀 Python
  await Promise.race([claimReachedPromise, new Promise((_r, reject) => setTimeout(() => reject(new Error('claim never reached stub')), 60_000))])
  killedPids = pythonPidsOf(host.pid)
  check('one python child running mid-flight', killedPids.length === 1, `pids=${killedPids.join(',')}`)
  execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(killedPids[0]), '/T', '/F'], { encoding: 'utf8' })
  await new Promise((resolveTick) => setTimeout(resolveTick, 1500))
  const callsAtKill = modelCalls

  // 类型化崩溃诊断;绝不自动重跑
  const health = await (await fetch(`${base}/vk/v1/health`, { headers })).json()
  check('typed crash diagnostic', health.status === 'failed' && health.reasonCode === 'sidecar-exited' && health.retryable === true, `${health.reasonCode}`)
  const survivedView = await fetch(`${base}/vk/v1/jobs/${created.job_id}`, { headers })
  // v2 阶段2:job 真源在 vk.db(shell_jobs)——重启后旧 job id 依然可看,
  // 状态由 reconcile 归为 interrupted(v1 时代是内存态 404,已升级)。
  check('old job id SURVIVES restart from vk.db (v2 persistence)', survivedView.status === 200)
  const rows = await (await fetch(`${base}/vk/v1/jobs`, { headers })).json()
  const interrupted = rows.filter((row) => row.kind === 'run' && row.status === 'interrupted')
  check('restart reconcile marked the orphan run interrupted', interrupted.length === 1, JSON.stringify(rows.map((r) => [r.job_id, r.status])))
  check('restart itself spent zero (no new model calls)', modelCalls === callsAtKill, `calls=${modelCalls}`)

  // v2 阶段2:重启后原 key 原 body 重放 → 同一 job_id、零新增模型调用。
  // 命中路径完全不解析 upload 暂存(公开指纹用客户端形态),故旧 id 不碍事。
  const replay = await posted('/vk/v1/jobs', { ...projection, client_job_id: crypto.randomUUID() })
  check('same idempotency key after restart returns the same job_id', replay.job_id === created.job_id, `job=${replay.job_id}`)
  check('same-key replay spends zero model calls', modelCalls === callsAtKill, `calls=${modelCalls}`)
  const replayView = await (await fetch(`${base}/vk/v1/jobs/${created.job_id}`, { headers })).json()
  check('replayed job is trackable from vk.db with interrupted status', replayView.status === 'interrupted' && replayView.request?.preset === 'quick-summary')

  // 显式重提交 = 新决策;快速模式完成。
  // upload id 是 sidecar 进程生命周期(契约 §6):重启后旧 id 对**新建**失效,重传是正路。
  const staleUpload = await fetch(`${base}/vk/v1/jobs`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ ...projection, idempotency_key: crypto.randomUUID(), client_job_id: crypto.randomUUID() }),
  })
  check('stale upload id is rejected for a NEW key after restart (process-lifetime contract)', staleUpload.status === 404)
  slowMode = false
  const reuploaded = await (await fetch(`${base}/vk/v1/uploads?name=lecture.srt`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(SRT, 'utf8'),
  })).json()
  const freshPreview = await posted('/vk/v1/preview', { source: `upload:${reuploaded.upload_id}`, preset: 'quick-summary', max_cost_cny: 5 })
  const resubmit = await posted('/vk/v1/jobs', { request: freshPreview, idempotency_key: crypto.randomUUID(), client_job_id: crypto.randomUUID() })
  let view = null
  const startedAt = Date.now()
  for (;;) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 800))
    view = await (await fetch(`${base}/vk/v1/jobs/${resubmit.job_id}`, { headers })).json()
    if (!['queued', 'running', 'cancel_requested'].includes(view.status)) break
    if (Date.now() - startedAt > 180_000) throw new Error(`resubmit poll timeout at ${view.status}`)
  }
  check('explicit resubmit completes after crash', view.status === 'done', `status=${view.status}`)
  check('resubmit spend is exactly one fresh run (chapter+claim)', modelCalls === callsAtKill + 2, `calls=${modelCalls}`)

  // SQLite integrity(强杀之后)
  const integrity = execFileSync(pythonPath, ['-c',
    'import sys, sqlite3; conn = sqlite3.connect(sys.argv[1]); print(conn.execute("PRAGMA integrity_check").fetchone()[0])',
    join(home, 'data', 'vk.db')], { encoding: 'utf8' }).trim()
  check('sqlite integrity ok after hard kill', integrity === 'ok', integrity)

  exitCode = checks.every((item) => item.passed) ? 0 : 1
} catch (error) {
  check('verify-vk-kill-matrix completed', false, String(error?.message ?? error))
  exitCode = 1
} finally {
  const survivors = pythonPidsOf(host.pid)
  host.kill('SIGTERM')
  await new Promise((resolveExit) => { host.once('exit', resolveExit); setTimeout(resolveExit, 5000) })
  await new Promise((resolveTick) => setTimeout(resolveTick, 1000))
  const orphans = [...new Set([...killedPids, ...survivors])].filter((pid) => processAlive(pid))
  check('zero orphan python at the end', orphans.length === 0, orphans.join(','))
  if (orphans.length) exitCode = 1
  stub.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(JSON.stringify({ vkKillMatrix: exitCode === 0, modelCalls, checks: checks.length }, null, 2))
process.exit(exitCode)
