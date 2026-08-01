// 真机门:真 Node Host + 真 video-knowledge Python sidecar 的最小闭环。
//
// 与 vitest 套件的关系:单测全部用 fake child/fake fetch(零真进程);本脚本是
// 唯一"两个真进程"的验收面 —— spawn Node Host → /vk/v1/meta 触发真 Python 拉起
// → 版本握手 → preview 全链路 → 优雅关停后 Python 无孤儿。
//
// 用法(需本机有 vk 仓的 uv venv):
//   node scripts/verify-vk-sidecar.mjs [pythonPath]
//   pythonPath 默认 C:\Users\Lauseusing\Developer\video-knowledge-m1-productization\.venv\Scripts\python.exe
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'http://127.0.0.1:5173'
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pythonPath = process.argv[2]
  ?? process.env.OPENCLI_HOST_VK_PYTHON
  ?? 'C:\\Users\\Lauseusing\\Developer\\video-knowledge-m1-productization\\.venv\\Scripts\\python.exe'

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function processAlive(pid) {
  try {
    const out = execFileSync('C:\\Windows\\System32\\tasklist.exe', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

function pythonPidsOf(parentPid) {
  // wmic 已弃用;用 PowerShell CIM 查子进程里的 python。
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

const dataRoot = mkdtempSync(join(tmpdir(), 'vk-smoke-data-'))
const stateDir = mkdtempSync(join(tmpdir(), 'vk-smoke-state-'))

const host = spawn(process.execPath, [join(projectRoot, 'server', 'index.mjs')], {
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OPENCLI_HOST_PORT: '0',
    OPENCLI_HOST_VK_PYTHON: pythonPath,
    OPENCLI_HOST_VK_ROOT: dataRoot,
    OPENCLI_HOST_VK_STATE_DIR: stateDir,
  },
})

let hostStderr = ''
host.stderr.on('data', (chunk) => { hostStderr += chunk.toString('utf8') })

const readyLine = await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error(`host readiness timeout; stderr: ${hostStderr.slice(-800)}`)), 20_000)
  let buffered = ''
  host.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    for (const line of buffered.split(/\r?\n/)) {
      if (line.includes('opencliHostReady')) {
        clearTimeout(timer)
        resolvePromise(line)
      }
    }
  })
  host.once('exit', (code) => rejectPromise(new Error(`host exited early (${code}); stderr: ${hostStderr.slice(-800)}`)))
})

let exitCode = 1
try {
  const ready = JSON.parse(readyLine)
  check('host ready line', ready.opencliHostReady === true, `port=${ready.port}`)
  const base = `http://127.0.0.1:${ready.port}`
  const headers = { Origin: ORIGIN }

  const idleHealth = await (await fetch(`${base}/vk/v1/health`, { headers })).json()
  check('idle health is stopped (lazy spawn)', idleHealth.status === 'stopped', idleHealth.reasonCode)

  const started = Date.now()
  const metaResponse = await fetch(`${base}/vk/v1/meta`, { headers })
  const meta = await metaResponse.json()
  check('meta proxied via real python sidecar', metaResponse.status === 200 && meta.service === 'video-knowledge', `in ${Date.now() - started}ms`)
  check('api version compatible', /^1\.\d+\.\d+$/.test(meta.api_version ?? '') && Number(meta.api_version.split('.')[1]) >= 1, meta.api_version)
  check('sidecar entered shell mode (env token enforced)', meta.shell_mode === true)

  const pythonPids = pythonPidsOf(host.pid)
  check('exactly one python child under host', pythonPids.length === 1, `pids=${pythonPids.join(',')}`)

  const preview = await (await fetch(`${base}/vk/v1/preview`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'https://example.com/v', preset: 'quick-summary', max_cost_cny: 1.5 }),
  })).json()
  check('preview resolves a full ProcessingRequest', preview.schema_version === '1.1.0' && preview.max_cost_cny === 1.5, `preset=${preview.preset}`)

  const health = await (await fetch(`${base}/vk/v1/health`, { headers })).json()
  check('health ok after handshake', health.status === 'ok' && health.apiVersion === meta.api_version)
  const healthText = JSON.stringify(health)
  check('health projection carries no port/pid/paths', !healthText.includes(String(ready.port)) && !/[A-Za-z]:(\\\\|\\|\/)/.test(healthText))

  const denied = await fetch(`${base}/vk/v1/meta`)
  check('origin gate still guards vk routes', denied.status === 403)

  // 优雅关停:SIGTERM → app.close() → sidecar stop;Python 必须一并退出(零孤儿)。
  host.kill('SIGTERM')
  await new Promise((resolvePromise) => host.once('exit', resolvePromise))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  const orphaned = pythonPids.filter((pid) => processAlive(pid))
  check('graceful shutdown leaves zero orphan python', orphaned.length === 0, orphaned.length ? `orphans=${orphaned.join(',')}` : undefined)

  exitCode = checks.every((item) => item.passed) ? 0 : 1
} catch (error) {
  check('verify-vk-sidecar completed', false, String(error?.message ?? error))
  exitCode = 1
} finally {
  if (!host.killed) host.kill('SIGKILL')
  rmSync(dataRoot, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(JSON.stringify({ vkSidecarSmoke: exitCode === 0, checks }, null, 2))
process.exit(exitCode)
