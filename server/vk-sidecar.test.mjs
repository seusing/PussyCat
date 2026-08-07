// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkSidecarError, VkSidecarManager, scrubSidecarText } from './vk-sidecar.mjs'

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.kills = []
  }

  kill(signal) {
    this.kills.push(signal)
    return true
  }
}

const META_OK = {
  service: 'video-knowledge',
  api_version: '1.3.0',
  package_version: '0.1.0',
  processing_request_schema_version: '1.1.0',
  shell_mode: true,
  max_workers: 1,
  capabilities: [{ capability: 'query_ready', runtime: 'ready', detail: null }],
  presets: ['quick-summary'],
  status: 'ok',
}

function setup(options = {}) {
  const child = new FakeChild()
  const calls = []
  const fetchCalls = []
  const manager = new VkSidecarManager({
    pythonPath: 'C:\\fixture\\vk-runtime\\python.exe',
    rootDir: 'C:\\fixture\\vk-data',
    configDir: 'C:\\fixture\\vk-config',
    spawnImpl: (...args) => {
      calls.push(args)
      return child
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => META_OK,
      }
    },
    randomToken: () => 'fixture-token-0123456789abcdef0123456789',
    readyTimeoutMs: 5000,
    stopGraceMs: 2000,
    ...options,
  })
  return { child, calls, fetchCalls, manager }
}

function emitReady(child, port = 45678) {
  child.stdout.write(`gui=http://127.0.0.1:${port}\n`)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('VkSidecarManager', () => {
  it('spawns the pinned runtime shell-free with env token and frozen gui argv', async () => {
    const { child, calls, manager } = setup()
    const startPromise = manager.ensureStarted()
    emitReady(child)
    await startPromise

    expect(calls).toHaveLength(1)
    const [program, argv, options] = calls[0]
    expect(program).toBe('C:\\fixture\\vk-runtime\\python.exe')
    expect(argv).toEqual([
      '-m', 'video_knowledge', 'gui',
      '--root', 'C:\\fixture\\vk-data',
      '--config-dir', 'C:\\fixture\\vk-config',
      '--port', '0',
      '--no-browser',
      '--max-workers', '1',
    ])
    expect(options.shell).toBe(false)
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(options.env.VK_UI_TOKEN).toBe('fixture-token-0123456789abcdef0123456789')
    expect(options.env.VK_UI_TOKEN.length).toBeGreaterThanOrEqual(16)
  })

  it('handshakes /api/meta with the injected token and reports a leak-free health projection', async () => {
    const { child, fetchCalls, manager } = setup()
    const startPromise = manager.ensureStarted()
    emitReady(child, 46001)
    await startPromise

    expect(fetchCalls[0].url).toBe('http://127.0.0.1:46001/api/meta')
    expect(fetchCalls[0].init.headers['X-VK-Token']).toBe('fixture-token-0123456789abcdef0123456789')

    const health = manager.health()
    expect(health.status).toBe('ok')
    expect(health.reasonCode).toBe('ok')
    expect(health.apiVersion).toBe('1.3.0')
    expect(health.schemaVersion).toBe('1.1.0')
    expect(health.packageVersion).toBe('0.1.0')
    expect(health.capabilities).toHaveLength(1)
    expect(health.retryable).toBe(false)
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain('fixture-token')
    expect(serialized).not.toContain('46001')
    expect(serialized).not.toMatch(/[A-Za-z]:(\\\\|\\|\/)/)
  })

  it('ensureStarted is single-flight: concurrent callers share one spawn', async () => {
    const { child, calls, manager } = setup()
    const first = manager.ensureStarted()
    const second = manager.ensureStarted()
    emitReady(child)
    await Promise.all([first, second])
    expect(calls).toHaveLength(1)
  })

  it('times out the ready handshake with a typed diagnostic and kills the child', async () => {
    vi.useFakeTimers()
    const { child, manager } = setup()
    const startPromise = manager.ensureStarted()
    const failure = startPromise.catch((error) => error)
    await vi.advanceTimersByTimeAsync(5001)
    const error = await failure
    expect(error).toBeInstanceOf(VkSidecarError)
    expect(error.reasonCode).toBe('spawn-timeout')
    expect(error.statusCode).toBe(503)
    expect(child.kills.length).toBeGreaterThan(0)
    expect(manager.health().reasonCode).toBe('spawn-timeout')
  })

  it('rejects an incompatible api major with protocol-mismatch and kills the child', async () => {
    const { child, manager } = setup({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...META_OK, api_version: '2.0.0' }),
      }),
    })
    const failure = manager.ensureStarted().catch((error) => error)
    emitReady(child)
    const error = await failure
    expect(error).toBeInstanceOf(VkSidecarError)
    expect(error.reasonCode).toBe('protocol-mismatch')
    expect(error.detail).toContain('2.0.0')
    expect(child.kills.length).toBeGreaterThan(0)
  })

  it('rejects an incompatible processing_request_schema_version', async () => {
    const { child, manager } = setup({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...META_OK, processing_request_schema_version: '2.0.0' }),
      }),
    })
    const failure = manager.ensureStarted().catch((error) => error)
    emitReady(child)
    const error = await failure
    expect(error).toBeInstanceOf(VkSidecarError)
    expect(error.reasonCode).toBe('protocol-mismatch')
    expect(error.detail).toContain('processing_request_schema_version')
    expect(error.detail).toContain('2.0.0')
    expect(child.kills.length).toBeGreaterThan(0)
  })

  it('rejects a sidecar whose service name is not video-knowledge', async () => {
    const { child, manager } = setup({
      fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ ...META_OK, service: 'something-else' }),
      }),
    })
    const failure = manager.ensureStarted().catch((error) => error)
    emitReady(child)
    const error = await failure
    expect(error.reasonCode).toBe('protocol-mismatch')
    expect(error.detail).toContain('something-else')
  })

  it('rejects a sidecar that did not enter shell mode', async () => {
    const { child, manager } = setup({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...META_OK, shell_mode: false }),
      }),
    })
    const failure = manager.ensureStarted().catch((error) => error)
    emitReady(child)
    const error = await failure
    expect(error.reasonCode).toBe('protocol-mismatch')
    expect(error.detail).toContain('shell_mode')
  })

  it('classifies a crash after readiness with scrubbed stderr tail', async () => {
    const { child, manager } = setup()
    const startPromise = manager.ensureStarted()
    emitReady(child)
    await startPromise

    child.stderr.write('Traceback in C:\\Users\\secret\\vk\\runner.py\n')
    child.stderr.write('token fixture-token-0123456789abcdef0123456789 leaked?\n')
    child.emit('close', 3, null)

    const health = manager.health()
    expect(health.status).toBe('failed')
    expect(health.reasonCode).toBe('sidecar-exited')
    expect(health.summary).toContain('3')
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain('fixture-token-0123456789abcdef0123456789')
    expect(serialized).not.toMatch(/[A-Za-z]:(\\\\|\\|\/)/)
    expect(serialized).toContain('runner.py')
  })

  it('drains carriage-return progress output without blocking the Host event loop', async () => {
    const { child, manager } = setup()
    const startPromise = manager.ensureStarted()
    emitReady(child)
    await startPromise

    child.stderr.write('download 10%\rdownload 20%\rdownload complete\n')
    child.stderr.write('final diagnostic\n')
    child.emit('close', 3, null)

    const health = manager.health()
    expect(health.reasonCode).toBe('sidecar-exited')
    expect(health.detail).toContain('download complete')
    expect(health.detail).toContain('final diagnostic')
  })

  it('reports not-configured without spawning when pythonPath is missing', async () => {
    const calls = []
    const manager = new VkSidecarManager({
      spawnImpl: (...args) => {
        calls.push(args)
        throw new Error('must not spawn')
      },
    })
    const error = await manager.ensureStarted().catch((err) => err)
    expect(error).toBeInstanceOf(VkSidecarError)
    expect(error.reasonCode).toBe('not-configured')
    expect(calls).toHaveLength(0)
    expect(manager.health().status).toBe('not-configured')
    expect(manager.health().retryable).toBe(false)
  })

  it('maps spawn ENOENT to runtime-missing', async () => {
    const child = new FakeChild()
    const manager = new VkSidecarManager({
      pythonPath: 'C:\\missing\\python.exe',
      rootDir: 'C:\\fixture\\vk-data',
      spawnImpl: () => child,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => META_OK }),
    })
    const failure = manager.ensureStarted().catch((error) => error)
    const spawnError = new Error('spawn ENOENT')
    spawnError.code = 'ENOENT'
    child.emit('error', spawnError)
    const error = await failure
    expect(error.reasonCode).toBe('runtime-missing')
    expect(manager.health().reasonCode).toBe('runtime-missing')
  })

  it('stop() terminates with grace then force, and is idempotent', async () => {
    vi.useFakeTimers()
    const { child, manager } = setup()
    const startPromise = manager.ensureStarted()
    emitReady(child)
    await startPromise

    const stopping = manager.stop()
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2001)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    await stopping
    expect(manager.health().status).toBe('stopped')
    await manager.stop() // 幂等
  })

  it('re-resolves the active runtime after stop so adoption needs no Host restart', async () => {
    const children = []
    const calls = []
    let activePython = 'C:\\fixture\\runtime-a\\python.exe'
    const manager = new VkSidecarManager({
      runtimeResolver: () => ({ pythonPath: activePython, source: 'external' }),
      rootDir: 'C:\\fixture\\vk-data',
      configDir: 'C:\\fixture\\vk-config',
      spawnImpl: (...args) => {
        calls.push(args)
        const child = new FakeChild()
        children.push(child)
        return child
      },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => META_OK }),
      randomToken: () => 'fixture-token-0123456789abcdef0123456789',
    })

    const first = manager.ensureStarted()
    emitReady(children[0])
    await first
    const stopped = manager.stop()
    children[0].emit('close', 0, null)
    await stopped

    activePython = 'C:\\fixture\\runtime-b\\python.exe'
    const second = manager.ensureStarted()
    emitReady(children[1])
    await second
    expect(calls.map(([program]) => program)).toEqual([
      'C:\\fixture\\runtime-a\\python.exe',
      'C:\\fixture\\runtime-b\\python.exe',
    ])
  })

  it('keeps the explicit developer Python override ahead of an active receipt', async () => {
    const { child, calls, manager } = setup({
      pythonPath: 'C:\\fixture\\developer\\python.exe',
      runtimeResolver: () => ({ pythonPath: 'C:\\fixture\\owned\\python.exe', source: 'app-owned' }),
    })
    const started = manager.ensureStarted()
    emitReady(child)
    await started
    expect(calls[0][0]).toBe('C:\\fixture\\developer\\python.exe')
  })
})

describe('scrubSidecarText', () => {
  it('folds absolute paths, masks credentials and provided secrets', () => {
    const scrubbed = scrubSidecarText(
      'file C:\\Users\\x\\vk.db and /home/user/a.log token=abc xsec_token=zzz secret-value',
      ['secret-value'],
    )
    expect(scrubbed).not.toMatch(/[A-Za-z]:(\\\\|\\|\/)/)
    expect(scrubbed).toContain('vk.db')
    expect(scrubbed).not.toContain('zzz')
    expect(scrubbed).not.toContain('secret-value')
  })
})
