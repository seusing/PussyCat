import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../App'
import { RunPanel } from './RunPanel'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import type { HostBridge } from '../../host/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '', access: 'read', browser: false, args: [], columns: ['status', 'site'],
}

beforeEach(() => {
  useAppStore.setState({
    commands: [cmd], selected: cmd, values: {}, currentRun: undefined,
    catalogStatus: 'ready', catalogError: undefined,   // 绕开真实 catalog 加载，直接进 ready 三栏
  })
})

test('端到端：运行一条 mock 命令走到成功终态并出表格', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('已完成'), { timeout: 2000 })
  await userEvent.click(screen.getByText('表格结果'))
  expect(screen.getByTestId('results-table')).toBeInTheDocument()
})

test('运行中显示取消执行按钮', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument())
})

test('取消闭环：cancelled 终态显示已取消、不出现 error 框、收起取消按钮', () => {
  useAppStore.setState({
    currentRun: {
      id: 'run-1',
      command: cmd,
      values: {},
      state: 'cancelled',
      startedAt: Date.now(),
      endedAt: Date.now(),
      lines: [],
      error: undefined,
    },
  })
  render(<RunPanel onCancel={() => {}} />)

  expect(screen.getByTestId('run-state')).toHaveTextContent('已取消')
  expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument()
  expect(screen.queryByText('命令执行失败')).not.toBeInTheDocument()
})

// ③ start rejection 不再卡死在 starting：App 注入会 reject 的 host，验证收口到 failed + 展示错误摘要
test('startCommand rejection → 已失败 + 错误摘要', async () => {
  const rejectingHost: HostBridge = {
    startCommand: () => Promise.reject(new Error('host 启动失败')),
    cancelCommand: () => Promise.resolve(),
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={rejectingHost} />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('失败'))
  expect(screen.getByText(/host 启动失败/)).toBeInTheDocument()
})

// 同构补测：cancel rejection 侧同样要收口到 failed，不能卡在 cancelling
test('cancelCommand rejection → 已失败 + 错误摘要', async () => {
  const rejectingCancelHost: HostBridge = {
    startCommand: (req) => Promise.resolve({ runId: req.runId }),
    cancelCommand: () => Promise.reject(new Error('host 取消失败')),
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={rejectingCancelHost} />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument())
  await userEvent.click(screen.getByTestId('cancel-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('失败'))
  expect(screen.getByText(/host 取消失败/)).toBeInTheDocument()
})

// ④ catalog 三态：error 渲染提示与重试按钮（不静默吞错）
test('catalog error 态渲染提示与重试按钮', () => {
  useAppStore.setState({ catalogStatus: 'error', catalogError: '加载失败：404' })
  render(<App />)
  expect(screen.getByText(/加载失败/)).toBeInTheDocument()
  expect(screen.getByTestId('catalog-retry')).toBeInTheDocument()
})

test('catalog loading 态渲染加载提示', () => {
  useAppStore.setState({ catalogStatus: 'loading' })
  render(<App />)
  expect(screen.getByTestId('catalog-loading')).toBeInTheDocument()
})

// Task3 reviewer 发现回归：成功重试后不能残留旧 error banner（catalogStatus 驱动渲染 + catalogError 被清空）
test('点击重试后 catalog 恢复 ready 且错误清除', async () => {
  useAppStore.setState({ catalogStatus: 'error', catalogError: '加载失败：404' })
  render(<App />)
  // 全局默认 fetch 挂起不 resolve（见 vitest.setup.ts），这里单独让重试路径拿到一次真实成功响应
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ schemaVersion: 1, generatedAt: 0, opencliVersion: '', source: '', listSha256: '', manifestSha256: '', commands: [] }),
  })))
  await userEvent.click(screen.getByTestId('catalog-retry'))
  await waitFor(() => expect(useAppStore.getState().catalogStatus).toBe('ready'))
  expect(useAppStore.getState().catalogError).toBeUndefined()
  expect(screen.queryByTestId('catalog-retry')).not.toBeInTheDocument()
})

// ⑦b × 只收起：隐藏面板 body，保留状态条；不调 cancel、不改 run.state
test('× 只收起面板：隐藏日志区、不取消、不改 run.state', async () => {
  const onCancel = vi.fn()
  useAppStore.setState({
    currentRun: {
      id: 'run-1', command: cmd, values: {}, state: 'running',
      startedAt: Date.now(), lines: [{ runId: 'run-1', seq: 0, at: 1, stream: 'stdout' as const, text: 'hello' }],
    },
  })
  render(<RunPanel onCancel={onCancel} />)
  expect(screen.getByText('hello')).toBeInTheDocument()

  await userEvent.click(screen.getByTestId('collapse-panel'))

  expect(screen.queryByText('hello')).not.toBeInTheDocument()
  expect(screen.getByTestId('run-state')).toHaveTextContent('运行中')
  expect(onCancel).not.toHaveBeenCalled()
  expect(useAppStore.getState().currentRun?.state).toBe('running')
})
