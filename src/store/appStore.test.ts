import { redactValues, useAppStore } from './appStore'
import type { CommandManifest } from '../data/types'

const cmd: CommandManifest = {
  command: 'x/login', site: 'x', name: 'login', description: '', access: 'write', browser: true,
  args: [{ name: 'password', type: 'str' }, { name: 'timeout', type: 'int' }],
}

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
