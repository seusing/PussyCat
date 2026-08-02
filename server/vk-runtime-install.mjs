// video-knowledge 版本化 runtime 安装核心(v2 阶段3,随 dist-host 发货)。
//
// 契约:
// - uv 路径**显式传入**(bundled),绝不依赖 PATH;
// - 安装前实际计算 wheel/uv 的 SHA-256 与 runtime-manifest.json 比对,
//   不匹配即类型化失败、绝不激活;
// - import → console → API 握手 → DB 迁移四门全绿 + 真实库先备份再迁移,
//   才原子切换 active.json;任何失败旧 runtime/旧 DB 原样可用;
// - 失败按 reasonCode 分类(sha-mismatch/offline/disk/path-too-long/smoke-*…),
//   stderr 尾部脱敏后随状态透出。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, statfsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scrubSidecarText } from './vk-sidecar.mjs'
import { writeActiveRuntime, writeRuntimeReceipt } from './vk-runtime-resolver.mjs'

const MIN_FREE_BYTES = 1 * 1024 ** 3
const HEAVY_FREE_BYTES = 5 * 1024 ** 3

export class VkRuntimeInstallError extends Error {
  constructor(reasonCode, message, detail) {
    super(message)
    this.name = 'VkRuntimeInstallError'
    this.reasonCode = reasonCode
    if (detail) this.detail = detail
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function classifyUvFailure(text) {
  const lowered = text.toLowerCase()
  if (/(error sending request|getaddrinfo|dns error|connection (refused|reset)|network|tls handshake|timed out)/.test(lowered)) {
    return 'offline'
  }
  return 'install-failed'
}

export async function installVkRuntime({
  home,
  bundleDir,
  wheelPath,
  uvPath,
  manifestPath,
  version,
  python = '3.12',
  extras = [],
  log = () => {},
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  const resolvedHome = resolve(home)
  const manifestFile = manifestPath ?? (bundleDir ? join(bundleDir, 'runtime-manifest.json') : undefined)
  if (!manifestFile || !existsSync(manifestFile)) {
    throw new VkRuntimeInstallError('bundle-missing', 'runtime-manifest.json 缺失,无法核验捆绑件')
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    throw new VkRuntimeInstallError('bundle-missing', 'runtime-manifest.json 损坏')
  }
  const wheel = resolve(wheelPath ?? join(bundleDir, manifest?.wheel?.name ?? ''))
  const uv = resolve(uvPath ?? join(bundleDir, manifest?.uv?.name ?? ''))
  if (!existsSync(wheel)) throw new VkRuntimeInstallError('bundle-missing', `wheel 不存在: ${manifest?.wheel?.name}`)
  if (!existsSync(uv)) throw new VkRuntimeInstallError('bundle-missing', `uv 不存在: ${manifest?.uv?.name}`)

  // —— SHA 前置核验(不匹配即停止,绝不激活)——
  const wheelDigest = sha256File(wheel)
  if (manifest?.wheel?.sha256 !== wheelDigest) {
    throw new VkRuntimeInstallError(
      'sha-mismatch',
      'wheel SHA-256 与 manifest 不符,拒绝安装',
      `expected=${manifest?.wheel?.sha256} actual=${wheelDigest}`,
    )
  }
  const uvDigest = sha256File(uv)
  if (manifest?.uv?.sha256 !== uvDigest) {
    throw new VkRuntimeInstallError(
      'sha-mismatch',
      'uv SHA-256 与 manifest 不符,拒绝安装',
      `expected=${manifest?.uv?.sha256} actual=${uvDigest}`,
    )
  }
  log(`manifest 核验通过 wheel=${wheelDigest.slice(0, 12)}… uv=${uvDigest.slice(0, 12)}…`)

  // —— 预检 ——
  if (resolvedHome.length > 100) {
    throw new VkRuntimeInstallError(
      'path-too-long',
      `home 路径过长(${resolvedHome.length} > 100):Windows MAX_PATH 下 runtime 会装完即坏`,
    )
  }
  for (const dir of ['runtime/versions', 'models', 'data', 'cache', 'temp']) {
    mkdirSync(join(resolvedHome, dir), { recursive: true })
  }
  const stats = statfsSync(resolvedHome)
  const freeBytes = stats.bavail * stats.bsize
  const required = extras.includes('media-asr') ? HEAVY_FREE_BYTES : MIN_FREE_BYTES
  log(`磁盘预检 free=${(freeBytes / 1024 ** 3).toFixed(2)}GiB required>=${(required / 1024 ** 3).toFixed(2)}GiB`)
  if (freeBytes < required) {
    throw new VkRuntimeInstallError('disk', '磁盘可用空间不足')
  }

  const versionLabel = version ?? `${(manifest?.wheel?.name ?? 'wheel').replace(/\.whl$/, '')}+${manifest?.wheel?.sha256?.slice(0, 8) ?? 'unknown'}`
  const versionDir = join(resolvedHome, 'runtime', 'versions', versionLabel)
  if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true })

  const runStep = (step, command, argv) => new Promise((resolveStep, rejectStep) => {
    log(`${step}: ${command.split(/[\\/]/).pop()} ${argv.join(' ')}`)
    const child = spawnImpl(command, argv, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(scrubSidecarText(line.trim()))
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(scrubSidecarText(line.trim()))
    })
    child.once('error', (error) => rejectStep(new VkRuntimeInstallError('install-failed', `${step} 无法启动`, String(error?.message ?? error))))
    child.once('close', (code) => {
      if (code === 0) resolveStep(output)
      else rejectStep(new VkRuntimeInstallError(
        step.startsWith('smoke') ? `smoke-${step.slice(6)}` : classifyUvFailure(output),
        `${step} 失败(exit ${code})`,
        scrubSidecarText(output.slice(-800)),
      ))
    })
  })

  // —— venv + 安装(显式 uv;uv 输出=真实下载/初始化阶段,逐行透传 log)——
  await runStep('venv', uv, ['venv', '--python', python, versionDir])
  const pythonExe = join(versionDir, 'Scripts', 'python.exe')
  const spec = extras.length
    ? `video-knowledge[${extras.join(',')}] @ file:///${wheel.replace(/\\/g, '/')}`
    : wheel
  await runStep('install', uv, ['pip', 'install', '--link-mode', 'copy', '--python', pythonExe, spec])

  // —— 四门 smoke ——
  await runStep('smoke-import', pythonExe, ['-c', 'import video_knowledge, importlib.metadata as m; print("import ok", m.version("video-knowledge"))'])
  await runStep('smoke-console', pythonExe, ['-m', 'video_knowledge', '-h'])

  const smokeRoot = mkdtempSync(join(tmpdir(), 'vk-rt-smoke-'))
  let smokeMeta = null
  try {
    const token = 'runtime-smoke-token-0123456789abcdef'
    const gui = spawnImpl(pythonExe, ['-m', 'video_knowledge', 'gui', '--root', join(smokeRoot, 'data'), '--config-dir', join(smokeRoot, 'config'), '--port', '0', '--no-browser'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VK_UI_TOKEN: token },
    })
    try {
      const port = await new Promise((resolvePort, rejectPort) => {
        const timer = setTimeout(() => rejectPort(new VkRuntimeInstallError('smoke-api', 'gui ready 超时')), 30_000)
        let buffered = ''
        gui.stdout?.on('data', (chunk) => {
          buffered += chunk.toString('utf8')
          const match = /gui=http:\/\/127\.0\.0\.1:(\d+)/.exec(buffered)
          if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
        })
        gui.once('exit', (code) => rejectPort(new VkRuntimeInstallError('smoke-api', `gui 提前退出(${code})`)))
      })
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/meta`, { headers: { 'X-VK-Token': token } })
      const meta = await response.json()
      if (!response.ok || meta.service !== 'video-knowledge' || meta.shell_mode !== true) {
        throw new VkRuntimeInstallError('smoke-api', `meta 握手异常 status=${response.status}`)
      }
      smokeMeta = meta
      log(`smoke-api: handshake ok api_version=${meta.api_version}`)
    } finally {
      gui.kill('SIGKILL')
    }
    const migrateOut = await runStep('smoke-migrate', pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1]) / "vk.db"); print(json.dumps(migrate(conn, default_migrations_dir())))', join(smokeRoot, 'migrate-smoke')])
    if (!migrateOut.includes('"008"')) {
      throw new VkRuntimeInstallError('smoke-migrate', `迁移清单缺 008: ${migrateOut.trim().slice(-200)}`)
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true })
  }

  // —— 真实 DB:迁移前备份,失败还原(旧 DB 可继续启动)——
  const realDb = join(resolvedHome, 'data', 'vk.db')
  if (existsSync(realDb)) {
    const backup = `${realDb}.backup-${versionLabel.replace(/[^\w.-]/g, '_')}-${Date.now()}`
    copyFileSync(realDb, backup)
    log(`已备份真实库 -> ${backup.split(/[\\/]/).pop()}`)
    const result = spawnSync(pythonExe, ['-c', 'import sys, json; from pathlib import Path; from video_knowledge.adapters.storage.db import connect, migrate, default_migrations_dir; conn = connect(Path(sys.argv[1])); print(json.dumps(migrate(conn, default_migrations_dir())))', realDb], { shell: false, windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) {
      copyFileSync(backup, realDb)
      throw new VkRuntimeInstallError('db-migrate', '真实库迁移失败,已从备份还原', scrubSidecarText(String(result.stderr ?? '').slice(-500)))
    }
    log(`真实库迁移完成 applied=${result.stdout.trim()}`)
  }

  // —— 原子切换 ——
  const receipt = writeRuntimeReceipt(resolvedHome, {
    schema: 'vk-runtime-receipt@1',
    source: 'app-owned',
    version: versionLabel,
    pythonPath: pythonExe,
    wheel: manifest?.wheel?.name,
    wheelSha256: manifest?.wheel?.sha256,
    uvSha256: manifest?.uv?.sha256,
    installedAt: new Date().toISOString(),
    extras,
    apiVersion: smokeMeta?.api_version ?? null,
    schemaVersion: smokeMeta?.processing_request_schema_version ?? null,
    capabilities: Array.isArray(smokeMeta?.capabilities) ? smokeMeta.capabilities : [],
  })
  writeActiveRuntime(resolvedHome, receipt)
  log(`active -> ${versionLabel}`)
  return { version: versionLabel, pythonPath: pythonExe }
}
