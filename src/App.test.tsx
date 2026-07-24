import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore } from './store/appStore'
import type { CommandManifest } from './data/types'
import type { HostBridge, RunRequest } from './host/types'
import type { CatalogSource } from './host'

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

test('挂载时 hydratePreferences 从 localStorage 载入收藏', () => {
  localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [{ site: 'seeded', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [] }))
  render(<App />)
  expect(useAppStore.getState().preferences.favoriteSites[0].site).toBe('seeded')
})

const SNAP = (over: Partial<{ generatedAt: number; commands: CommandManifest[] }> = {}) => ({
  schemaVersion: 1 as const, generatedAt: over.generatedAt ?? 1000, opencliVersion: 'x', source: 's',
  listSha256: 'a', manifestSha256: 'b',
  commands: over.commands ?? [{ command: 'a/b', site: 'a', name: 'b', description: '', access: 'read' as const, browser: false, args: [] }],
})

function sourceOf(loads: Array<() => Promise<{ snapshot: ReturnType<typeof SNAP>; degraded?: string }>>): CatalogSource {
  let i = 0
  return { kind: 'live', load: () => loads[Math.min(i++, loads.length - 1)]() }
}

test('刷新成功 → 目录更新 + generatedAt 显示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => ({ snapshot: SNAP({ generatedAt: 2000, commands: [{ command: 'c/d', site: 'c', name: 'd', description: '', access: 'read', browser: false, args: [] }] }) }),
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await waitFor(() => expect(useAppStore.getState().commands[0].command).toBe('c/d'))
  expect(screen.getByTestId('catalog-meta')).toBeInTheDocument()
})

test('刷新失败 → 目录保持 ready(不出错误屏),按钮旁提示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => { throw new Error('all down') },
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await screen.findByTestId('refresh-error')
  expect(useAppStore.getState().catalogStatus).toBe('ready')          // 决策④:不打翻现有目录
  expect(screen.queryByTestId('catalog-retry')).not.toBeInTheDocument()  // 无首载错误屏
})

test('刷新降级(degraded) → 目录更新 + 降级提示', async () => {
  const source = sourceOf([
    async () => ({ snapshot: SNAP() }),
    async () => ({ snapshot: SNAP({ generatedAt: 3000 }), degraded: 'Host 不可达' }),
  ])
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await screen.findByTestId('refresh-degraded')
})

test('latest-wins:慢速首载响应不得覆盖已成功的手动刷新(三轮复审 F1)', async () => {
  let resolveFirst!: (v: { snapshot: ReturnType<typeof SNAP>; degraded?: string }) => void
  const firstLoad = new Promise<{ snapshot: ReturnType<typeof SNAP>; degraded?: string }>((r) => { resolveFirst = r })
  const source: CatalogSource = {
    kind: 'live',
    load: vi.fn()
      .mockReturnValueOnce(firstLoad)                          // 首载:悬挂中
      .mockResolvedValueOnce({ snapshot: SNAP({ generatedAt: 2000, commands: [{ command: 'c/d', site: 'c', name: 'd', description: '', access: 'read', browser: false, args: [] }] }) }),
  }
  render(<App catalogSource={source} />)
  await screen.findByTestId('refresh-catalog')                 // header 常驻,首载悬挂时按钮即可用
  await userEvent.click(screen.getByTestId('refresh-catalog'))  // 手动刷新:立即成功 new/live
  await waitFor(() => expect(useAppStore.getState().commands[0]?.command).toBe('c/d'))
  resolveFirst({ snapshot: SNAP({ generatedAt: 1000 }), degraded: 'Host 不可达' })   // 慢首载:旧数据+降级
  await new Promise((r) => setTimeout(r, 50))                  // 给过期响应一个提交窗口
  expect(useAppStore.getState().commands[0]?.command).toBe('c/d')            // 未被覆盖
  expect(screen.queryByTestId('refresh-degraded')).not.toBeInTheDocument()   // 未错误显示降级
})

test('世代接管归位 refreshing:依赖变化顶掉在途刷新后按钮不卡死(评审 P3)', async () => {
  let calls = 0
  const sourceA: CatalogSource = {
    kind: 'live',
    load: () => { calls += 1; return calls === 1 ? Promise.resolve({ snapshot: SNAP() }) : new Promise(() => {}) },
  }
  const { rerender } = render(<App catalogSource={sourceA} />)
  await screen.findByTestId('refresh-catalog')
  await userEvent.click(screen.getByTestId('refresh-catalog'))          // 在途刷新:悬挂
  expect(screen.getByTestId('refresh-catalog')).toBeDisabled()
  const sourceB: CatalogSource = { kind: 'live', load: async () => ({ snapshot: SNAP({ generatedAt: 3000 }) }) }
  rerender(<App catalogSource={sourceB} />)                             // catalogSource 变化 → fetchCatalog 世代顶掉在途刷新
  await waitFor(() => expect(screen.getByTestId('refresh-catalog')).not.toBeDisabled())
})
