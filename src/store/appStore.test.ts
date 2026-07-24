import { redactValues, useAppStore } from './appStore'
import type { CommandManifest } from '../data/types'

const cmd: CommandManifest = {
  command: 'x/login', site: 'x', name: 'login', description: '', access: 'write', browser: true,
  args: [{ name: 'password', type: 'str' }, { name: 'timeout', type: 'int' }],
}

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })  // true = replace，每个用例前恢复初始态

test('markCancelling→finishRun(cancelled) 取消流程且不带 error', () => {
  useAppStore.getState().selectCommand(cmd)
  useAppStore.getState().beginRun('run-2')
  useAppStore.getState().appendOutput({ runId: 'run-2', seq: 0, at: 1, stream: 'stdout', text: 'x' })
  useAppStore.getState().markCancelling()
  expect(useAppStore.getState().currentRun?.state).toBe('cancelling')
  useAppStore.getState().finishRun({ runId: 'run-2', at: 2, outcome: 'cancelled' })
  expect(useAppStore.getState().currentRun?.state).toBe('cancelled')
  expect(useAppStore.getState().currentRun?.error).toBeUndefined()
})

test('redactValues 脱敏敏感字段', () => {
  const out = redactValues(cmd, { password: 'secret', timeout: 5 })
  expect(out.password).toBe('••••')
  expect(out.timeout).toBe(5)
})

test('selectCommand 重置 values 为默认值', () => {
  const withDefault: CommandManifest = { ...cmd, args: [{ name: 'timeout', type: 'int', default: 300 }] }
  useAppStore.getState().selectCommand(withDefault)
  expect(useAppStore.getState().values).toEqual({ timeout: 300 })
})

test('beginRun→appendOutput→finishRun 驱动状态与日志', () => {
  useAppStore.getState().selectCommand(cmd)
  useAppStore.getState().beginRun('run-1')
  expect(useAppStore.getState().currentRun?.state).toBe('starting')
  useAppStore.getState().appendOutput({ runId: 'run-1', seq: 0, at: 1, stream: 'stdout', text: 'hi' })
  expect(useAppStore.getState().currentRun?.state).toBe('running')
  expect(useAppStore.getState().currentRun?.lines).toHaveLength(1)
  useAppStore.getState().finishRun({ runId: 'run-1', at: 2, outcome: 'success', result: [{ ok: 1 }] })
  expect(useAppStore.getState().currentRun?.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun?.result).toEqual([{ ok: 1 }])
})

test('mode 默认 demo', () => {
  expect(useAppStore.getState().mode).toBe('demo')
})

test('appendOutput：按 seq 去重且乱序插入有序', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  const ev = (seq: number, text: string) => ({ runId: 'r1', seq, at: 1, stream: 'stdout' as const, text })
  useAppStore.getState().appendOutput(ev(1, 'b'))
  useAppStore.getState().appendOutput(ev(0, 'a'))
  useAppStore.getState().appendOutput(ev(1, 'b-dup'))   // 重复 seq → 丢弃
  const lines = useAppStore.getState().currentRun!.lines
  expect(lines.map((l) => l.seq)).toEqual([0, 1])
  expect(lines.map((l) => l.text)).toEqual(['a', 'b'])
})
test('appendOutput：终态后到达的 output 被抑制', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().appendOutput({ runId: 'r1', seq: 0, at: 3, stream: 'stdout', text: 'late' })
  expect(useAppStore.getState().currentRun!.lines).toHaveLength(0)
})
test('finishRun：终态后重复 done 幂等（不覆盖）', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().finishRun({ runId: 'r1', at: 3, outcome: 'error', error: { summary: 'x' } })
  expect(useAppStore.getState().currentRun!.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun!.error).toBeUndefined()
})
test('redactValues：脱真敏感、保留 keyword/key', () => {
  const c: CommandManifest = { ...cmd, args: [{ name: 'password', type: 'str' }, { name: 'keyword', type: 'str' }, { name: 'key', type: 'str' }] }
  const out = redactValues(c, { password: 'p', keyword: '茅台', key: 'PROJ-1' })
  expect(out.password).toBe('••••'); expect(out.keyword).toBe('茅台'); expect(out.key).toBe('PROJ-1')
})
test('catalogStatus 默认 loading，setCatalogStatus 可切', () => {
  expect(useAppStore.getState().catalogStatus).toBe('loading')
  useAppStore.getState().setCatalogStatus('error', '404')
  expect(useAppStore.getState().catalogStatus).toBe('error')
  expect(useAppStore.getState().catalogError).toBe('404')
})

test('setCommands 加载成功须清掉残留 catalogError（Task3 reviewer 发现的修复）', () => {
  useAppStore.getState().setCatalogStatus('error', '404')
  useAppStore.getState().setCommands([])
  expect(useAppStore.getState().catalogStatus).toBe('ready')
  expect(useAppStore.getState().catalogError).toBeUndefined()
})
