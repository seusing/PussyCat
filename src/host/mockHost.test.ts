import { createMockHost } from './mockHost'
import type { HostBridge, OutputEvent, DoneEvent } from './types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function collect(host: HostBridge) {
  const outputs: OutputEvent[] = []
  const dones: DoneEvent[] = []
  host.onOutput((e) => outputs.push(e))
  host.onDone((e) => dones.push(e))
  return { outputs, dones }
}

test('成功：先有 output，最后恰好一个 success done', async () => {
  const host = createMockHost()
  const { outputs, dones } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.runAllTimersAsync()
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('success')
  expect(outputs.length).toBeGreaterThan(0)
  expect(outputs.every((o) => o.runId === 'r1')).toBe(true)
})

test('seq 严格单调递增且不重复', async () => {
  const host = createMockHost()
  const { outputs } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.runAllTimersAsync()
  const seqs = outputs.map((o) => o.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(seqs.length)
})

test('cancel 幂等，产生唯一 cancelled done', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.advanceTimersByTimeAsync(35)
  await host.cancelCommand('r1')
  await host.cancelCommand('r1')
  await vi.runAllTimersAsync()
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('cancelled')
})

test('自然结束后迟到的 cancel 保留真实终态（竞态）', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.runAllTimersAsync()
  await host.cancelCommand('r1')
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('success')
})

test('error 场景：error done 带 exitCode 与摘要', async () => {
  const host = createMockHost()
  const { outputs, dones } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'], mockScenario: 'error' })
  await vi.runAllTimersAsync()
  expect(dones).toHaveLength(1)
  expect(dones[0].outcome).toBe('error')
  expect(dones[0].exitCode).toBe(1)
  expect(dones[0].error?.summary).toBeTruthy()
  expect(outputs.some((o) => o.stream === 'stderr')).toBe(true)
})

test('done 之后不再有该 run 的 output（终态抑制 pending output）', async () => {
  const host = createMockHost()
  const { outputs } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.advanceTimersByTimeAsync(35)   // 触发 10/30ms，t=50ms 的 emit 仍 pending
  const before = outputs.length
  await host.cancelCommand('r1')          // finish 的 clearTimeout 应清掉 t=50 pending emit
  await vi.advanceTimersByTimeAsync(2000)
  expect(outputs.length).toBe(before)     // 本应 50ms 出现的 output 被抑制
})

test('cancelled done 不带 error 字段（error 仅 error outcome）', async () => {
  const host = createMockHost()
  const { dones } = collect(host)
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.advanceTimersByTimeAsync(35)
  await host.cancelCommand('r1')
  await vi.runAllTimersAsync()
  expect(dones[0].outcome).toBe('cancelled')
  expect(dones[0].error).toBeUndefined()
})

test('onOutput/onDone 退订函数生效（退订后零增长）', async () => {
  const host = createMockHost()
  const outs: OutputEvent[] = []
  const dns: DoneEvent[] = []
  const offOut = host.onOutput((e) => outs.push(e))
  const offDone = host.onDone((e) => dns.push(e))
  offOut(); offDone()
  await host.startCommand({ runId: 'r1', commandKey: 'x/c', argv: ['x', 'c'] })
  await vi.runAllTimersAsync()
  expect(outs).toHaveLength(0)
  expect(dns).toHaveLength(0)
})
