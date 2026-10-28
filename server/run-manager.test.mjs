// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunManager, RunManagerError } from './run-manager.mjs'

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

function setup(options = {}) {
  const child = new FakeChild()
  const calls = []
  const events = []
  const manager = new RunManager({
    opencliEntry: 'C:\\fixture\\opencli\\dist\\src\\main.js',
    nodePath: 'C:\\fixture\\node.exe',
    spawnImpl: (...args) => {
      calls.push(args)
      return child
    },
    emitEvent: (type, event) => events.push({ type, event }),
    ...options,
  })
  return { child, calls, events, manager }
}

const request = {
  runId: 'run-1',
  commandKey: '36kr/news',
  argv: ['36kr', 'news', '-f', 'json'],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RunManager', () => {
  it('spawns the Node entry shell-free, streams monotonic seq, and emits one success result', () => {
    const { child, calls, events, manager } = setup()
    expect(manager.start(request)).toEqual({ runId: 'run-1' })
    expect(calls[0]).toEqual([
      'C:\\fixture\\node.exe',
      ['C:\\fixture\\opencli\\dist\\src\\main.js', '36kr', 'news', '-f', 'json'],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: expect.any(Object) },
    ])

    child.stdout.write('[\n{"rank":1,"title":"A"}\n]\n')
    child.stderr.write('diagnostic\n')
    child.emit('close', 0, null)
    child.emit('close', 0, null)

    const output = events.filter((item) => item.type === 'output').map((item) => item.event)
    expect(output.map((item) => item.seq)).toEqual([0, 1, 2, 3])
    expect(output.map((item) => item.stream)).toEqual(['stdout', 'stdout', 'stdout', 'stderr'])
    const done = events.filter((item) => item.type === 'done')
    expect(done).toHaveLength(1)
    expect(done[0].event).toMatchObject({
      runId: 'run-1',
      outcome: 'success',
      exitCode: 0,
      result: [{ rank: 1, title: 'A' }],
    })
  })

  it('sets CI=1 for the OpenCLI child to skip its update notice, keeping the rest of process.env', () => {
    const previous = process.env.RUN_MANAGER_ENV_SENTINEL
    process.env.RUN_MANAGER_ENV_SENTINEL = 'kept'
    try {
      const ciBefore = process.env.CI
      const { calls, manager } = setup()
      manager.start(request)
      const { env } = calls[0][2]
      expect(env.CI).toBe('1')
      expect(env.RUN_MANAGER_ENV_SENTINEL).toBe('kept')
      expect(process.env.CI).toBe(ciBefore)
    } finally {
      if (previous === undefined) delete process.env.RUN_MANAGER_ENV_SENTINEL
      else process.env.RUN_MANAGER_ENV_SENTINEL = previous
    }
  })

  it('normalizes nonzero exit and invalid JSON to error done events', () => {
    const first = setup()
    first.manager.start(request)
    first.child.stderr.write('network failed')
    first.child.emit('close', 2, null)
    expect(first.events.at(-1)).toMatchObject({
      type: 'done',
      event: {
        outcome: 'error',
        exitCode: 2,
        error: { summary: '命令执行失败', detail: 'OpenCLI exited with code 2\nnetwork failed' },
      },
    })

    const second = setup()
    second.manager.start(request)
    second.child.stdout.write('not json')
    second.child.emit('close', 0, null)
    expect(second.events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'error', exitCode: 0, error: { summary: '命令执行失败' } },
    })
    expect(second.events.at(-1).event.error.detail).toMatch(/^OpenCLI returned invalid JSON\n/)
  })

  it('translates a login failure from the OpenCLI error envelope and keeps the original text in detail', () => {
    const { child, events, manager } = setup()
    manager.start(request)
    child.stderr.write([
      'ok: false',
      'error:',
      '  code: AUTH_REQUIRED',
      '  message: Not logged in to www.xiaohongshu.com',
      '  help: Please open Chrome or Chromium and log in to https://www.xiaohongshu.com',
      '  exitCode: 77',
      '',
    ].join('\n'))
    child.emit('close', 77, null)
    const { error } = events.at(-1).event
    expect(error.summary).toBe('需要先登录 www.xiaohongshu.com：在 Chrome 里登录后重试')
    expect(error.detail).toContain('OpenCLI exited with code 77')
    expect(error.detail).toContain('Not logged in to www.xiaohongshu.com')
  })

  it('preserves UTF-8 characters split across stdout chunks', () => {
    const { child, events, manager } = setup()
    manager.start(request)
    const json = Buffer.from('[{"title":"氪星"}]')
    const splitAt = json.indexOf(Buffer.from('氪')) + 1
    child.stdout.write(json.subarray(0, splitAt))
    child.stdout.write(json.subarray(splitAt))
    child.emit('close', 0, null)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'success', result: [{ title: '氪星' }] },
    })
  })

  it('emits done once when spawn reports error and later closes', () => {
    const { child, events, manager } = setup()
    manager.start(request)
    child.emit('error', new Error('ENOENT'))
    child.emit('close', -2, null)
    expect(events.filter((item) => item.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'error', error: { summary: '命令执行失败', detail: 'OpenCLI process error\nENOENT' } },
    })
  })

  it('cancels with SIGTERM then SIGKILL and is idempotent', async () => {
    vi.useFakeTimers()
    const { child, events, manager } = setup({ cancelGraceMs: 10 })
    manager.start(request)
    manager.cancel('run-1')
    manager.cancel('run-1')
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(10)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    expect(events.at(-1)).toMatchObject({ type: 'done', event: { outcome: 'cancelled' } })
  })

  it('preserves a natural success that wins the cancel race', () => {
    const { child, events, manager } = setup()
    manager.start(request)
    child.stdout.write('[]')
    manager.cancel('run-1')
    child.emit('close', 0, null)
    expect(events.at(-1)).toMatchObject({ type: 'done', event: { outcome: 'success', result: [] } })
  })

  it('times out as an error and applies the termination watchdog', async () => {
    vi.useFakeTimers()
    const { child, events, manager } = setup({ commandTimeoutMs: 10, cancelGraceMs: 5 })
    manager.start(request)
    await vi.advanceTimersByTimeAsync(10)
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(5)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'error', error: { summary: '执行超时：网络较慢或页面卡住，稍后重试' } },
    })
    expect(events.at(-1).event.error.detail).toContain('OpenCLI timed out after 10ms')
  })

  it('uses the per-request time budget when the policy supplies one', async () => {
    vi.useFakeTimers()
    const { child, events, manager } = setup({ commandTimeoutMs: 10, cancelGraceMs: 5 })
    manager.start({ ...request, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(10)
    expect(child.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(40)
    expect(child.kills).toEqual(['SIGTERM'])
    child.emit('close', null, 'SIGTERM')
    expect(events.at(-1).event.error.summary).toBe('执行超时：网络较慢或页面卡住，稍后重试')
    expect(events.at(-1).event.error.detail).toContain('OpenCLI timed out after 50ms')
  })

  it('rejects duplicate ids and excess concurrency', () => {
    // 显式压到 1:并发上限默认已提到 4(登录体检要并行),但这条用例考的是
    // "超出上限必须 429",与上限取值无关,所以把它钉在一个确定的边界上。
    const { manager } = setup({ maxConcurrentRuns: 1 })
    manager.start(request)
    expect(() => manager.start(request)).toThrow(RunManagerError)
    expect(() => manager.start({ ...request, runId: 'run-2' })).toThrow(/Maximum concurrent/)
  })

  it('默认上限为 4 —— 前端用 3 个跑后台体检,留一个给用户手动发起的命令', () => {
    const { manager } = setup()
    for (let i = 1; i <= 4; i += 1) manager.start({ ...request, runId: `run-${i}` })
    expect(() => manager.start({ ...request, runId: 'run-5' })).toThrow(/Maximum concurrent/)
  })

  it('seen 有界:cap 内驱逐最旧,被驱逐 id 可重用(重放保护有界,UUID 下碰撞理论级)', () => {
    const { child, manager } = setup({ maxSeenRunIds: 2 })
    manager.start({ ...request, runId: 'run-1' })
    child.emit('close', 0, null)
    manager.start({ ...request, runId: 'run-2' })
    child.emit('close', 0, null)
    manager.start({ ...request, runId: 'run-3' })
    child.emit('close', 0, null)
    // run-1 已被驱逐出 seen(cap=2,插入序最旧);重启同 id 不应再抛 409
    expect(manager.start({ ...request, runId: 'run-1' })).toEqual({ runId: 'run-1' })
  })

  it('cap 小于并发数:活跃 run 即使被驱逐出 seen 也不能重复启动(active.has 兜底)', () => {
    const { manager } = setup({ maxSeenRunIds: 1, maxConcurrentRuns: 2 })
    manager.start({ ...request, runId: 'run-a' })
    manager.start({ ...request, runId: 'run-b' }) // seen 插入 run-b 后 size(2) > cap(1),驱逐最旧 run-a;run-a 仍在 active(未 close)
    let caught
    try {
      manager.start({ ...request, runId: 'run-a' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RunManagerError)
    expect(caught.statusCode).toBe(409)
    expect(caught.message).toBe('Duplicate runId: run-a')
  })
})

describe('RunManager —— OpenCLI 2.0 输出', () => {
  function finishWith({ stdout = '', stderr = '', exitCode = 0 }) {
    const { child, events, manager } = setup()
    manager.start(request)
    if (stdout) child.stdout.write(stdout)
    if (stderr) child.stderr.write(stderr)
    child.emit('close', exitCode, null)
    return events.at(-1).event
  }

  it('成功外壳 {ok:true,data:[…]} 取 data 当结果行', () => {
    const done = finishWith({ stdout: '{"ok":true,"data":[{"rank":1,"title":"A"},{"rank":2,"title":"B"}]}\n' })
    expect(done).toMatchObject({ outcome: 'success', result: [{ rank: 1, title: 'A' }, { rank: 2, title: 'B' }] })
  })

  it('成功外壳里的 data 是单个对象时也走原有归一化', () => {
    expect(finishWith({ stdout: '{"ok":true,"data":{"name":"x"}}' }).result).toEqual([{ name: 'x' }])
    expect(finishWith({ stdout: '{"ok":true,"data":[]}' }).result).toEqual([])
    expect(finishWith({ stdout: '{"ok":true}' }).result).toEqual([])
  })

  it('stderr 上的警告不影响成功', () => {
    const done = finishWith({ stdout: '{"ok":true,"data":[{"a":1}]}', stderr: 'Extension update available: v1.0.24 → v1.0.26\n' })
    expect(done.outcome).toBe('success')
  })

  it('1.8.8 的数组输出照旧', () => {
    expect(finishWith({ stdout: '[{"rank":1}]' }).result).toEqual([{ rank: 1 }])
  })

  it('失败外壳:按 stdout 里的 code 归类,hint 里的登录域名进 summary,英文原文进 detail', () => {
    const stdout = JSON.stringify({
      ok: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Not logged in to www.xiaohongshu.com',
        exitCode: 77,
        hint: 'Please open Chrome or Chromium and log in to https://www.xiaohongshu.com',
      },
    })
    const done = finishWith({ stdout, stderr: 'Extension update available\n', exitCode: 77 })
    expect(done.outcome).toBe('error')
    expect(done.exitCode).toBe(77)
    expect(done.error.summary).toBe('需要先登录 www.xiaohongshu.com：在 Chrome 里登录后重试')
    expect(done.error.detail).toContain('AUTH_REQUIRED: Not logged in to www.xiaohongshu.com')
  })

  it('失败外壳出现在退出码 0 的 stdout 上:按失败处理,不当成结果行', () => {
    const done = finishWith({ stdout: '{"ok":false,"error":{"code":"TIMEOUT","message":"timed out"}}', exitCode: 0 })
    expect(done.outcome).toBe('error')
    expect(done.error.summary).toBe('执行超时：网络较慢或页面卡住，稍后重试')
    expect(done.error.detail).toContain('OpenCLI reported a failure')
  })

  it('1.8.8 的行数据里带 ok:false 和字符串 error 不会被当成失败外壳', () => {
    const done = finishWith({ stdout: '{"ok":false,"error":"row text"}' })
    expect(done).toMatchObject({ outcome: 'success', result: [{ ok: false, error: 'row text' }] })
  })

  it('入口是 getter 时每次起子进程现取', () => {
    let entry = 'C:\fixture\v1\dist\src\main.js'
    const calls = []
    const manager = new RunManager({
      opencliEntry: () => entry,
      nodePath: 'C:\fixture\node.exe',
      spawnImpl: (...args) => { calls.push(args); return new FakeChild() },
      emitEvent: () => {},
    })
    manager.start({ ...request, runId: 'run-a' })
    entry = 'C:\fixture\v2\dist\src\main.js'
    manager.start({ ...request, runId: 'run-b' })
    expect(calls.map((call) => call[1][0])).toEqual(['C:\fixture\v1\dist\src\main.js', 'C:\fixture\v2\dist\src\main.js'])
  })
})
