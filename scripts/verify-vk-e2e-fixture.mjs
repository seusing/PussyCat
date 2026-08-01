// 阶段 6 · 确定性零费 E2E:真 Node Host 代理 + 真 Python 引擎 + 真 DAG,
// 模型面指向本机 LLM stub(openai_completions 形制)——零真实计费、全链路真执行。
//
// 闭环:上传字幕 → 预检(完整 ProcessingRequest)→ 费用上限内提交 → 轮询到 done
// → 产物(笔记/产物 JSON)→ 证据覆盖(capabilities)→ 知识库查询(带引用)
// → 幂等重复提交(同 key 同 job、模型调用 0 增)→ 新 key 重提交 = cache hit
// (模型调用 0 增、cost 0)→ 优雅关停零孤儿。
//
// 用法:node scripts/verify-vk-e2e-fixture.mjs [pythonPath]
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

// —— 本机 LLM stub(chapter → claim 两段脚本化回复;之后任何调用都是异常)——
// end_ms 必须与字幕末帧一致:vk 的 chapterize 校验会拒掉「章节未覆盖到片尾」。
const CHAPTER_REPLY = JSON.stringify([{ idx: 0, title: '相对论引言', start_ms: 0, end_ms: 9500, summary: '介绍光速' }])
const CLAIM_REPLY = JSON.stringify([{
  claim_text: '光速约每秒三十万公里', claim_type: 'speaker_claim',
  speaker_stance: '陈述', source_certainty: 'firm', confidence: 0.95,
  evidence: [{ start_ms: 4200, end_ms: 9500, quote: '光速在真空中约为每秒三十万公里' }],
}])
let modelCalls = 0
const stub = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    modelCalls += 1
    const reply = modelCalls === 1 ? CHAPTER_REPLY : CLAIM_REPLY
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      model: 'stub-cheap',
      choices: [{ message: { content: reply } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }))
  })
})
await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen))
const stubPort = stub.address().port

// —— 临时家目录(短路径,MAX_PATH 教训)+ stub provider 配置 ——
const home = mkdtempSync(join(tmpdir(), 'vk-e2e-'))
const configDir = join(home, 'config')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'providers.toml'), `price_snapshot_id = "e2e-stub"

[tiers]
cheap = ["stub:cheap"]
mid = ["stub:cheap"]
high = ["stub:cheap"]

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

// —— 真 Node Host ——
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
  const timer = setTimeout(() => rejectReady(new Error(`host readiness timeout; ${hostStderr.slice(-500)}`)), 20_000)
  let buffered = ''
  host.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    for (const line of buffered.split(/\r?\n/)) {
      if (line.includes('opencliHostReady')) { clearTimeout(timer); resolveReady(line) }
    }
  })
  host.once('exit', (code) => rejectReady(new Error(`host exited early (${code}); ${hostStderr.slice(-500)}`)))
})

let exitCode = 1
let pythonPids = []
try {
  const base = `http://127.0.0.1:${JSON.parse(readyLine).port}`
  const headers = { Origin: ORIGIN }
  const json = { ...headers, 'Content-Type': 'application/json' }
  const posted = async (path, payload) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(payload) })
    const body = await response.json()
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`)
    return body
  }

  // 1. 上传字幕(契约:shell 模式不收绝对路径,本地文件走 uploads)
  const uploadResponse = await fetch(`${base}/vk/v1/uploads?name=lecture.srt`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(SRT, 'utf8'),
  })
  const uploaded = await uploadResponse.json()
  check('upload returns opaque upload_id (no path)', uploadResponse.status === 201 && !!uploaded.upload_id && !('path' in uploaded))

  // 2. 预检:完整 ProcessingRequest,带费用上限与 query_ready
  const preview = await posted('/vk/v1/preview', {
    source: `upload:${uploaded.upload_id}`,
    preset: 'quick-summary',
    capabilities: ['query_ready'],
    max_cost_cny: 5,
  })
  check('preview resolves full request', preview.schema_version === '1.1.0' && preview.max_cost_cny === 5 && preview.requested_capabilities.includes('query_ready'))

  // 3. 提交(幂等键 + client_job_id)
  const idempotencyKey = crypto.randomUUID()
  const created = await posted('/vk/v1/jobs', { request: preview, idempotency_key: idempotencyKey, client_job_id: crypto.randomUUID() })
  check('job created', typeof created.job_id === 'string')
  pythonPids = pythonPidsOf(host.pid)

  // 4. 轮询到终态(真 DAG:acquire→normalize→chapter→claim→qc→note→product→index→query_prepare)
  let view = null
  const startedAt = Date.now()
  for (;;) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 800))
    const response = await fetch(`${base}/vk/v1/jobs/${created.job_id}`, { headers })
    view = await response.json()
    if (!['queued', 'running', 'cancel_requested', 'submitted'].includes(view.status)) break
    if (Date.now() - startedAt > 180_000) throw new Error(`poll timeout at status=${view.status}`)
  }
  check('real DAG completed', view.status === 'done', `status=${view.status} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`)
  if (view.status !== 'done') {
    console.log('[debug] view =', JSON.stringify(view, null, 2))
    const dump = execFileSync(pythonPath, ['-c',
      'import sys, sqlite3, json; conn = sqlite3.connect(sys.argv[1]); print(json.dumps(conn.execute("SELECT stage, status, error_class, error_detail FROM stage_runs ORDER BY started_at").fetchall(), ensure_ascii=False))',
      join(home, 'data', 'vk.db')], { encoding: 'utf8' })
    console.log('[debug] stage_runs =', dump)
  }
  check('actual cost recorded and within cap', typeof view.cost_cny === 'number' && view.cost_cny > 0 && view.cost_cny < 5, `cost=${view.cost_cny}`)
  check('request_fingerprint exposed for the shadow', /^[0-9a-f]{64}$/.test(view.request_fingerprint ?? ''))
  check('model stub called exactly twice (chapter+claim)', modelCalls === 2, `calls=${modelCalls}`)
  const capabilityStates = Object.fromEntries((view.capabilities ?? []).map((item) => [item.capability, item.state]))
  check('evidence coverage: search+query available', capabilityStates.search_document === 'available' && capabilityStates.query_ready === 'available', JSON.stringify(capabilityStates))

  // 5. 产物:opaque id → 字节;零绝对路径
  const raw = JSON.stringify(view)
  check('job view carries zero absolute paths', !/[A-Za-z]:(\\\\|\\|\/)/.test(raw))
  const noteResponse = await fetch(`${base}/vk/v1/outputs/${view.outputs.note_path}`, { headers })
  const note = await noteResponse.text()
  check('markdown note downloadable with claim content', noteResponse.status === 200 && note.includes('光速'), `bytes=${note.length}`)
  const product = view.outputs.product_artifacts[0]
  const productJson = await (await fetch(`${base}/vk/v1/outputs/${product.json}`, { headers })).json()
  check('product artifact downloadable', product.preset === 'quick-summary' && typeof productJson === 'object')

  // 6. 知识库查询(真 FTS 索引,带引用)
  const answer = await posted('/vk/v1/query', { query: '光速' })
  check('query answered with citations', answer.status === 'answered' && (answer.citations ?? []).length > 0, `citations=${(answer.citations ?? []).length}`)

  // 7. 幂等:同 key 重复提交 → 同 job,模型调用零增
  const duplicated = await posted('/vk/v1/jobs', { request: preview, idempotency_key: idempotencyKey, client_job_id: crypto.randomUUID() })
  check('idempotent resubmit returns the same job with zero new model calls', duplicated.job_id === created.job_id && modelCalls === 2)

  // 8. 完整 cache hit:新 key 同请求 → done、cost 0、模型调用零增(下载本就为 0:本地上传源)
  const cacheKey = crypto.randomUUID()
  const cached = await posted('/vk/v1/jobs', { request: preview, idempotency_key: cacheKey, client_job_id: crypto.randomUUID() })
  let cachedView = null
  for (;;) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    const response = await fetch(`${base}/vk/v1/jobs/${cached.job_id}`, { headers })
    cachedView = await response.json()
    if (!['queued', 'running', 'submitted'].includes(cachedView.status)) break
    if (Date.now() - startedAt > 240_000) throw new Error('cache-hit poll timeout')
  }
  check('full cache hit: done with zero cost and zero new model calls', cachedView.status === 'done' && cachedView.cost_cny === 0 && modelCalls === 2, `cost=${cachedView.cost_cny} calls=${modelCalls}`)

  // 9. 任务列表含双任务
  const rows = await (await fetch(`${base}/vk/v1/jobs`, { headers })).json()
  check('jobs listing shows both jobs', rows.filter((row) => [created.job_id, cached.job_id].includes(row.job_id)).length === 2)

  exitCode = checks.every((item) => item.passed) ? 0 : 1
} catch (error) {
  check('verify-vk-e2e-fixture completed', false, String(error?.message ?? error))
  exitCode = 1
} finally {
  host.kill('SIGTERM')
  await new Promise((resolveExit) => { host.once('exit', resolveExit); setTimeout(resolveExit, 5000) })
  const orphans = pythonPids.filter((pid) => processAlive(pid))
  check('graceful shutdown leaves zero orphan python', orphans.length === 0, orphans.join(','))
  if (orphans.length) exitCode = 1
  stub.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(JSON.stringify({ vkFixtureE2E: exitCode === 0, modelCalls, checks: checks.length }, null, 2))
process.exit(exitCode)
