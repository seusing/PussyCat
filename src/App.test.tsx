import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore } from './store/appStore'
import type { CommandManifest } from './data/types'
import type { HostBridge, RunRequest } from './host/types'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })  // true = replace，每个用例前恢复初始态

test('renders app root', () => {
  render(<App />)
  expect(screen.getByTestId('app-root')).toBeInTheDocument()
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '示例', access: 'read', browser: false, args: [],
}

test('runId 是 UUID（非 run-N 序列），且 host.startCommand 与 store.currentRun 收到同一个值', async () => {
  useAppStore.setState({ catalogStatus: 'ready', selected: cmd, values: {}, currentRun: undefined })
  const startCommand = vi.fn((req: RunRequest) => Promise.resolve({ runId: req.runId }))
  const host: HostBridge = {
    startCommand,
    cancelCommand: async () => {},
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={host} mode="connected" />)

  await userEvent.click(screen.getByTestId('run-button'))

  expect(startCommand).toHaveBeenCalledOnce()
  const runId = startCommand.mock.calls[0][0].runId
  expect(runId).toMatch(UUID_RE)
  expect(useAppStore.getState().currentRun?.id).toBe(runId)

  // 结束这次运行后再点一次：新 runId 必须不同，证明生成方式不依赖会在重挂载/刷新后
  // 归零的模块级计数器（P0-B 收尾修复的回归用例：旧实现用 `run-${++runSeq}`，
  // 计数器归零后会撞上 server 的 seen 集合而 409）。
  act(() => { useAppStore.getState().finishRun({ runId, at: Date.now(), outcome: 'success', result: [] }) })
  await userEvent.click(screen.getByTestId('run-button'))

  expect(startCommand).toHaveBeenCalledTimes(2)
  const runId2 = startCommand.mock.calls[1][0].runId
  expect(runId2).toMatch(UUID_RE)
  expect(runId2).not.toBe(runId)
})
