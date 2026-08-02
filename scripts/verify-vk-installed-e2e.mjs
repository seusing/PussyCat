// v2 阶段3/5 · 安装态真实闭环:用**已安装目录**里的 Host + 捆绑件,
// 独立用户数据目录完成 首启安装 → 提交 fixture → 完成 → 产物 → 查询 →
// 重启 → 历史可看 → 同 key 幂等零执行 → 历史 retry。
//
// 用法:node scripts/verify-vk-installed-e2e.mjs <installDir> <userDataDir>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const installDir = resolve(process.argv[2] ?? 'C:\\Users\\Lauseusing\\AppData\\Local\\Temp\\zz-install')
const home = resolve(process.argv[3] ?? 'C:\\Users\\Lauseusing\\AppData\\Local\\Temp\\zz-data')
const ORIGIN = 'http://127.0.0.1:5173'

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const CHAPTER = JSON.stringify([{ idx: 0, title: '相对论引言', start_ms: 0, end_ms: 9500, summary: '介绍光速' }])
const CLAIM = JSON.stringify([{
  claim_text: '光速约每秒三十万公里', claim_type: 'speaker_claim', speaker_stance: '陈述',
  source_certainty: 'firm', confidence: 0.95,
  evidence: [{ start_ms: 4200, end_ms: 9500, quote: '光速在真空中约为每秒三十万公里' }],
}])
const SRT = `1
00:00:00,000 --> 00:00:04,000
相对论引言,介绍背景。

2
00:00:04,200 --> 00:00:09,500
光速在真空中约为每秒三十万公里。
`

let modelCalls = 0
const stub = createServer((request, response) => {
  request.on('data', () => {})
  request.on('end', () => {
    modelCalls += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      model: 'stub-cheap',
      choices: [{ message: { content: modelCalls % 2 === 1 ? CHAPTER : CLAIM } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }))
  })
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const stubPort = stub.address().port

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, 'config'), { recursive: true })
writeFileSync(join(home, 'config', 'providers.toml'), `price_snapshot_id = "installed-e2e"

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

function startHost() {
  const env = {
    ...process.env,
    OPENCLI_HOST_PORT: '0',
    OPENCLI_HOST_VK_HOME: home,
    OPENCLI_HOST_VK_BUNDLE_DIR: join(installDir, 'vk'),
    OPENCLI_HOST_VK_CONFIG_DIR: join(home, 'config'),
    VK_STUB_KEY: 'stub-key-not-a-secret',
  }
  delete env.OPENCLI_HOST_VK_PYTHON   // 只走 active.json 指针,验证首启安装
  const child = spawn(process.execPath, [join(installDir, 'host', 'server', 'index.mjs')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`host readiness timeout; ${stderr.slice(-400)}`)), 25_000)
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const line = buffered.split(/\r?\n/).find((l) => l.includes('opencliHostReady'))
      if (line) { clearTimeout(timer); resolveReady({ child, base: `http://127.0.0.1:${JSON.parse(line).port}` }) }
    })
    child.once('exit', (code) => rejectReady(new Error(`host exited early (${code}); ${stderr.slice(-400)}`)))
  })
}

async function stopHost(child) {
  child.kill('SIGTERM')
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 6000) })
}

let exitCode = 1
let host = null
try {
  const headers = { Origin: ORIGIN }
  const json = { ...headers, 'Content-Type': 'application/json' }
  host = await startHost()
  const postJson = async (path, payload) => {
    const response = await fetch(`${host.base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(payload) })
    const body = await response.json()
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body).slice(0, 200)}`)
    return body
  }

  // 1) 首启:未安装 → 安装编排 → installed
  const before = await (await fetch(`${host.base}/vk/v1/runtime/status`, { headers })).json()
  check('first run reports not-installed', before.state === 'not-installed', before.summary)
  await fetch(`${host.base}/vk/v1/runtime/install`, { method: 'POST', headers: json, body: '{}' })
  let runtime = before
  const installStarted = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    runtime = await (await fetch(`${host.base}/vk/v1/runtime/status`, { headers })).json()
    if (runtime.state !== 'installing' && runtime.state !== 'not-installed') break
    if (Date.now() - installStarted > 300_000) break
  }
  check('runtime installed from bundled wheel+uv', runtime.state === 'installed', `version=${runtime.version} in ${Math.round((Date.now() - installStarted) / 1000)}s`)
  check('install log carries real steps', runtime.log.some((line) => line.includes('manifest')) && runtime.log.some((line) => line.includes('smoke-api')), `${runtime.log.length} lines`)

  // 2) 提交 fixture → 完成
  const uploaded = await (await fetch(`${host.base}/vk/v1/uploads?name=lecture.srt`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(SRT, 'utf8'),
  })).json()
  const idempotencyKey = crypto.randomUUID()
  const projection = {
    source: `upload:${uploaded.upload_id}`, preset: 'quick-summary', max_cost_cny: 5,
    capabilities: ['query_ready'], idempotency_key: idempotencyKey, client_job_id: crypto.randomUUID(),
  }
  const created = await postJson('/vk/v1/jobs', projection)
  let view = null
  const runStarted = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    view = await (await fetch(`${host.base}/vk/v1/jobs/${created.job_id}`, { headers })).json()
    if (!['queued', 'running', 'submitted'].includes(view.status)) break
    if (Date.now() - runStarted > 180_000) throw new Error(`poll timeout at ${view.status}`)
  }
  check('installed app completes a real DAG', view.status === 'done', `status=${view.status} cost=${view.cost_cny}`)
  check('progress projects real stages and cost', Array.isArray(view.progress?.completed_stages) && view.progress.completed_stages.length > 0 && view.progress.incurred_cost_cny > 0, JSON.stringify(view.progress?.completed_stages ?? []))

  const note = await (await fetch(`${host.base}/vk/v1/outputs/${view.outputs.note_path}`, { headers })).text()
  check('note artifact downloadable', note.includes('光速'), `bytes=${note.length}`)
  const answer = await postJson('/vk/v1/query', { query: '光速' })
  check('knowledge query answers with citations', answer.status === 'answered' && (answer.citations ?? []).length > 0, `citations=${(answer.citations ?? []).length}`)

  // 3) 重启 Node + Python:历史可看 + 同 key 幂等零执行
  const callsBeforeRestart = modelCalls
  await stopHost(host.child)
  host = await startHost()
  const historyRows = await (await fetch(`${host.base}/vk/v1/jobs`, { headers })).json()
  check('history survives restart', historyRows.some((row) => row.job_id === created.job_id), `${historyRows.length} rows`)
  const replay = await postJson('/vk/v1/jobs', { ...projection, client_job_id: crypto.randomUUID() })
  check('same idempotency key returns the same job_id after restart', replay.job_id === created.job_id)
  check('restart + replay adds zero model calls', modelCalls === callsBeforeRestart, `calls=${modelCalls}`)

  // 4) 历史 retry(从公开请求重建;upload 源不含凭据 → 允许)
  const retried = await postJson(`/vk/v1/jobs/${created.job_id}/retry`, {})
  check('history retry keeps parent', retried.parent_job_id === created.job_id, `child=${retried.job_id}`)
  let retryView = null
  const retryStarted = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    retryView = await (await fetch(`${host.base}/vk/v1/jobs/${retried.job_id}`, { headers })).json()
    if (!['queued', 'running', 'submitted'].includes(retryView.status)) break
    if (Date.now() - retryStarted > 120_000) break
  }
  check('history retry completes as a cache hit with zero new model calls', retryView.status === 'done' && modelCalls === callsBeforeRestart, `status=${retryView.status} calls=${modelCalls}`)

  exitCode = checks.every((item) => item.passed) ? 0 : 1
} catch (error) {
  check('verify-vk-installed-e2e completed', false, String(error?.message ?? error))
  exitCode = 1
} finally {
  if (host) await stopHost(host.child)
  stub.close()
}
console.log(JSON.stringify({ vkInstalledE2E: exitCode === 0, modelCalls, checks: checks.length }, null, 2))
process.exit(exitCode)
