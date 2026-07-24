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
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
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

  it('normalizes nonzero exit and invalid JSON to error done events', () => {
    const first = setup()
    first.manager.start(request)
    first.child.stderr.write('network failed')
    first.child.emit('close', 2, null)
    expect(first.events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'error', exitCode: 2, error: { summary: 'OpenCLI exited with code 2' } },
    })

    const second = setup()
    second.manager.start(request)
    second.child.stdout.write('not json')
    second.child.emit('close', 0, null)
    expect(second.events.at(-1)).toMatchObject({
      type: 'done',
      event: { outcome: 'error', exitCode: 0, error: { summary: 'OpenCLI returned invalid JSON' } },
    })
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
      event: { outcome: 'error', error: { summary: 'OpenCLI process error', detail: 'ENOENT' } },
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
      event: { outcome: 'error', error: { summary: 'OpenCLI timed out after 10ms' } },
    })
  })

  it('rejects duplicate ids and excess concurrency', () => {
    const { manager } = setup()
    manager.start(request)
    expect(() => manager.start(request)).toThrow(RunManagerError)
    expect(() => manager.start({ ...request, runId: 'run-2' })).toThrow(/Maximum concurrent/)
  })
})
