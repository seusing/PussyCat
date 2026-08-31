// 用户触发的受控 runtime 发现与只读探针。只枚举有限的明确位置，不递归全盘。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { listOwnedRuntimeReceipts, resolveActiveRuntime } from './vk-runtime-resolver.mjs'

function executableAt(root) {
  if (!root) return null
  for (const relative of [['Scripts', 'python.exe'], ['python.exe'], ['bin', 'python']]) {
    const candidate = join(root, ...relative)
    if (existsSync(candidate)) return resolve(candidate)
  }
  return null
}

function directories(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()) } catch { return [] }
}

function addCandidate(map, pythonPath, source, appPath = null) {
  if (!pythonPath || !isAbsolute(pythonPath) || !existsSync(pythonPath)) return
  try { if (!statSync(pythonPath).isFile()) return } catch { return }
  const canonical = (() => { try { return realpathSync(pythonPath) } catch { return resolve(pythonPath) } })()
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  if (!map.has(key)) map.set(key, { pythonPath: canonical, source, appPath })
}

export function discoverVkRuntimePaths({
  home,
  bundleDir,
  env = process.env,
  allowExternalRuntime = false,
} = {}) {
  const found = new Map()
  const active = resolveActiveRuntime({ home, bundleDir })
  if (active?.source === 'app-owned') {
    addCandidate(found, active.pythonPath, 'app-owned', active.appPath ?? null)
  }
  for (const receipt of listOwnedRuntimeReceipts({ home, bundleDir })) {
    addCandidate(found, receipt.pythonPath, 'app-owned', receipt.appPath ?? null)
  }
  if (!allowExternalRuntime) return [...found.values()].slice(0, 64)
  addCandidate(found, executableAt(env.VIRTUAL_ENV), 'virtual-env')
  addCandidate(found, executableAt(env.CONDA_PREFIX), 'conda-prefix')

  const localAppData = env.LOCALAPPDATA
  const pythonRoot = localAppData ? join(localAppData, 'Programs', 'Python') : null
  for (const entry of directories(pythonRoot).filter((item) => /^Python/i.test(item.name)).slice(0, 20)) {
    addCandidate(found, executableAt(join(pythonRoot, entry.name)), 'user-python')
  }

  const developerRoot = env.USERPROFILE ? join(env.USERPROFILE, 'Developer') : null
  for (const project of directories(developerRoot).filter((item) => /^video-knowledge/i.test(item.name)).slice(0, 30)) {
    const projectRoot = join(developerRoot, project.name)
    for (const venv of directories(projectRoot).filter((item) => /^\.venv/i.test(item.name)).slice(0, 10)) {
      addCandidate(found, executableAt(join(projectRoot, venv.name)), 'developer-venv')
    }
  }
  return [...found.values()].slice(0, 64)
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? ''))
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) } : null
}

function meets(value, major, minor) {
  const parsed = parseVersion(value)
  return parsed !== null && parsed.major === major && parsed.minor >= minor
}

function probeEnv(token, root, baseEnv) {
  const keep = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH']
  const env = {}
  for (const key of keep) if (baseEnv[key]) env[key] = baseEnv[key]
  return {
    ...env,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    VK_UI_TOKEN: token,
    VK_RUNTIME_PROBE_ROOT: root,
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe-timeout')), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function probeVkRuntime({
  pythonPath,
  source,
  appPath = null,
  spawnImpl = spawn,
  fetchImpl = fetch,
  baseEnv = process.env,
  timeoutMs = 30_000,
} = {}) {
  const base = {
    pythonPath: typeof pythonPath === 'string' ? pythonPath : '', source: source ?? 'unknown',
    version: null, apiVersion: null, schemaVersion: null, capabilities: [],
    compatible: false, reason: null,
  }
  if (!pythonPath || !isAbsolute(pythonPath) || !existsSync(pythonPath)) {
    return { ...base, reason: 'runtime-missing' }
  }
  const probeRoot = mkdtempSync(join(tmpdir(), 'vk-runtime-probe-'))
  const token = randomBytes(24).toString('base64url')
  let child
  try {
    child = spawnImpl(pythonPath, [
      '-m', 'video_knowledge', 'gui', '--root', join(probeRoot, 'data'),
      '--config-dir', join(probeRoot, 'config'), '--port', '0', '--no-browser', '--max-workers', '1',
    ], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      // 拆层布局的解释器里没有我们的包,应用层得跟着一起传,否则探针只会得出
      // 「这个 runtime 不兼容」这个错误结论。
      env: typeof appPath === 'string'
        ? { ...probeEnv(token, probeRoot, baseEnv), PYTHONPATH: appPath }
        : probeEnv(token, probeRoot, baseEnv),
    })
    // 外部环境的诊断只用于分类，不回显；持续排空避免 pipe 填满后子进程假死。
    child.stderr?.on('data', () => {})
    const port = await new Promise((resolvePort, rejectPort) => {
      const timer = setTimeout(() => rejectPort(new Error('spawn-timeout')), timeoutMs)
      timer.unref?.()
      let buffered = ''
      child.stdout?.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const match = /(?:^|\r?\n)gui=http:\/\/127\.0\.0\.1:(\d+)(?:\r?\n|$)/.exec(buffered)
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
      })
      child.once('error', (error) => { clearTimeout(timer); rejectPort(error) })
      child.once('exit', (code) => { clearTimeout(timer); rejectPort(new Error(`probe-exit-${code}`)) })
    })
    const response = await withTimeout(
      fetchImpl(`http://127.0.0.1:${port}/api/meta`, { headers: { 'X-VK-Token': token } }),
      timeoutMs,
    )
    if (!response.ok) return { ...base, reason: 'probe-http' }
    const meta = await response.json()
    const candidate = {
      ...base,
      version: typeof meta?.package_version === 'string' ? meta.package_version : null,
      apiVersion: typeof meta?.api_version === 'string' ? meta.api_version : null,
      schemaVersion: typeof meta?.processing_request_schema_version === 'string'
        ? meta.processing_request_schema_version : null,
      capabilities: Array.isArray(meta?.capabilities) ? meta.capabilities : [],
    }
    const compatible = meta?.service === 'video-knowledge'
      && meta?.shell_mode === true
      && meets(candidate.apiVersion, 1, 1)
      && meets(candidate.schemaVersion, 1, 1)
      && Array.isArray(meta?.capabilities)
    return { ...candidate, compatible, reason: compatible ? null : 'protocol-mismatch' }
  } catch (error) {
    const reason = String(error?.message ?? error).includes('spawn-timeout') ? 'spawn-timeout' : 'probe-failed'
    return { ...base, reason }
  } finally {
    child?.kill('SIGKILL')
    rmSync(probeRoot, { recursive: true, force: true })
  }
}
