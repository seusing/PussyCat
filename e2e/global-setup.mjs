// Playwright 全局启动:LLM stub + 真 Node Host(固定 43199)+ 真 Python sidecar 环境。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pythonPath = process.env.OPENCLI_HOST_VK_PYTHON
  ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\.venv\\Scripts\\python.exe'

const CHAPTER_REPLY = JSON.stringify([{ idx: 0, title: '相对论引言', start_ms: 0, end_ms: 9500, summary: '介绍光速' }])
const CLAIM_REPLY = JSON.stringify([{
  claim_text: '光速约每秒三十万公里', claim_type: 'speaker_claim',
  speaker_stance: '陈述', source_certainty: 'firm', confidence: 0.95,
  evidence: [{ start_ms: 4200, end_ms: 9500, quote: '光速在真空中约为每秒三十万公里' }],
}])

export default async function globalSetup() {
  let calls = 0
  const stub = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      calls += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        model: 'stub-cheap',
        choices: [{ message: { content: calls % 2 === 1 ? CHAPTER_REPLY : CLAIM_REPLY } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }))
    })
  })
  await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen))
  const stubPort = stub.address().port

  const home = mkdtempSync(join(tmpdir(), 'vk-pw-'))
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

  const host = spawn(process.execPath, [join(projectRoot, 'server', 'index.mjs')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCLI_HOST_PORT: '43199',
      OPENCLI_HOST_ALLOWED_ORIGINS: 'http://localhost:5199,http://127.0.0.1:5199',
      OPENCLI_HOST_VK_PYTHON: pythonPath,
      OPENCLI_HOST_VK_ROOT: join(home, 'data'),
      OPENCLI_HOST_VK_CONFIG_DIR: configDir,
      OPENCLI_HOST_VK_STATE_DIR: join(home, 'node-state'),
      VK_STUB_KEY: 'stub-key-not-a-secret',
    },
  })
  let stderr = ''
  host.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`host readiness timeout; ${stderr.slice(-400)}`)), 20_000)
    let buffered = ''
    host.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      if (buffered.includes('opencliHostReady')) { clearTimeout(timer); resolveReady() }
    })
    host.once('exit', (code) => rejectReady(new Error(`host exited early (${code}); ${stderr.slice(-400)}`)))
  })

  globalThis.__VK_E2E__ = { host, stub, home }
  process.env.VK_E2E_HOST = 'http://127.0.0.1:43199'
}
