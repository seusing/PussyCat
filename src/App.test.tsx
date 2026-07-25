import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore } from './store/appStore'
import type { CommandManifest } from './data/types'
import type { HostBridge, RunRequest } from './host/types'
import type { CatalogSource } from './host'
import { createNodeBridgeHost, type EventSourceLike } from './host/nodeBridgeHost'

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

import { normalizeHostError } from './App'
import { HostRequestError } from './host/errors'

describe('normalizeHostError 契约(块 C)', () => {
  test('Error → message+stack;空 message 用 context fallback', () => {
    const e = new Error('boom')
    expect(normalizeHostError(e, 'start')).toEqual({ summary: 'boom', detail: e.stack })
    expect(normalizeHostError(new Error(''), 'cancel').summary).toBe('取消请求失败')
  })
  test('结构化 {summary,detail} 透传,不再退化 [object Object]', () => {
    expect(normalizeHostError({ summary: '策略拒绝', detail: 'HTTP 403' }, 'start'))
      .toEqual({ summary: '策略拒绝', detail: 'HTTP 403' })
  })
  test('其余类型 → context fallback + String(e)', () => {
    expect(normalizeHostError(42, 'cancel')).toEqual({ summary: '取消请求失败', detail: '42' })
    expect(normalizeHostError(42, 'start')).toEqual({ summary: '任务启动失败', detail: '42' })
  })
  test('HostRequestError → summary/detail 结构化透传(复审 F2)', () => {
    const e = new HostRequestError('策略拒绝', 'Command is outside policy', 403)
    expect(normalizeHostError(e, 'start')).toEqual({ summary: '策略拒绝', detail: 'Command is outside policy' })
  })
})

describe('键盘层(RE/04 三键,块 C)', () => {
  const CMD_REQ: CommandManifest = {
    command: 'k/run', site: 'k', name: 'run', description: '', access: 'read', browser: false,
    args: [{ name: 'must', type: 'str', required: true }],
  }
  const keydown = (init: KeyboardEventInit) => fireEvent.keyDown(window, init)

  // 注:src/vitest.setup.ts 全局桩 fetch 为永不 settle 的 Promise(见其注释),
  // 故 catalogStatus 必须在 render 前用 store 摆好为 'ready',nav-search(SiteCommandNav)
  // 才会同步出现在首帧——同现有各用例摆状态的惯例一致(不依赖真实 catalog 落地)。
  test('Ctrl+K 聚焦搜索框(ref 路径)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    await screen.findByTestId('nav-search')
    keydown({ key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('nav-search'))
  })

  test('Ctrl+Enter 非法表单 → 显示字段错误(与点运行一致),不静默', async () => {
    useAppStore.setState({ commands: [CMD_REQ], catalogStatus: 'ready' })
    useAppStore.getState().selectCommand(CMD_REQ)
    render(<App />)
    await screen.findByTestId('nav-search')
    keydown({ key: 'Enter', ctrlKey: true })
    expect(await screen.findByText('此字段必填')).toBeInTheDocument()
    expect(useAppStore.getState().currentRun).toBeUndefined()          // 未起跑
  })

  test('Ctrl+Enter 合法表单 → 起跑;活跃 run 期间再按 → 不二次起跑(守卫)', async () => {
    const ok: CommandManifest = { ...CMD_REQ, args: [] }
    useAppStore.setState({ commands: [ok], catalogStatus: 'ready' })
    useAppStore.getState().selectCommand(ok)
    render(<App />)
    await screen.findByTestId('nav-search')
    keydown({ key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(useAppStore.getState().currentRun).toBeDefined())
    const firstId = useAppStore.getState().currentRun!.id
    keydown({ key: 'Enter', ctrlKey: true })                           // running 中
    expect(useAppStore.getState().currentRun!.id).toBe(firstId)        // 无第二个 run
  })

  test('无选中命令时 Ctrl+Enter 安全 no-op(M-2 重构回归护栏)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    await screen.findByTestId('nav-search')
    expect(() => keydown({ key: 'Enter', ctrlKey: true })).not.toThrow()
    expect(useAppStore.getState().currentRun).toBeUndefined()
  })

  test('Esc 链:聚焦→blur;展开→收起;已收起→no-op 不重开(P1-1)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    const search = await screen.findByTestId('nav-search')
    search.focus()
    keydown({ key: 'Escape' })
    expect(document.activeElement).not.toBe(search)                    // ② blur
    const ok: CommandManifest = { command: 'k/r2', site: 'k', name: 'r2', description: '', access: 'read', browser: false, args: [] }
    act(() => { useAppStore.setState({ commands: [ok] }); useAppStore.getState().selectCommand(ok); useAppStore.getState().beginRun('r-esc') })
    expect(useAppStore.getState().runPanelCollapsed).toBe(false)       // beginRun 自动展开
    keydown({ key: 'Escape' })
    expect(useAppStore.getState().runPanelCollapsed).toBe(true)        // ③ 收起
    keydown({ key: 'Escape' })
    expect(useAppStore.getState().runPanelCollapsed).toBe(true)        // ④ no-op,永不重开
  })

  test('IME composing 时 Esc 忽略', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    const search = await screen.findByTestId('nav-search')
    search.focus()
    keydown({ key: 'Escape', isComposing: true })
    expect(document.activeElement).toBe(search)                        // ① 未 blur
  })

  test('keyCode 229(IME 合成键)同样让路(P3 防御)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    const search = await screen.findByTestId('nav-search')
    search.focus()
    keydown({ key: 'Escape', keyCode: 229 })
    expect(document.activeElement).toBe(search)     // 未 blur
  })

  test('IME composing 时 Ctrl+Enter 不起跑(复审 F1)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    await screen.findByTestId('nav-search')
    const ok: CommandManifest = { command: 'k/ime', site: 'k', name: 'ime', description: '', access: 'read', browser: false, args: [] }
    act(() => { useAppStore.setState({ commands: [ok] }); useAppStore.getState().selectCommand(ok) })
    keydown({ key: 'Enter', ctrlKey: true, isComposing: true })
    expect(useAppStore.getState().currentRun).toBeUndefined()
    keydown({ key: 'Enter', ctrlKey: true })                     // 非 composing 仍可起跑(反向护栏)
    await waitFor(() => expect(useAppStore.getState().currentRun).toBeDefined())
  })

  test('活跃 run 期间 Ctrl+Enter 无副作用:不写字段错误、不抢焦点(复审 F3)', async () => {
    useAppStore.setState({ catalogStatus: 'ready' })
    render(<App />)
    await screen.findByTestId('nav-search')
    const req: CommandManifest = {
      command: 'k/req', site: 'k', name: 'req', description: '', access: 'read', browser: false,
      args: [{ name: 'must', type: 'str', required: true }],
    }
    act(() => { useAppStore.setState({ commands: [req] }); useAppStore.getState().selectCommand(req) })
    act(() => { useAppStore.getState().beginRun('r-active') })    // 造活跃 run(starting)
    const before = document.activeElement
    keydown({ key: 'Enter', ctrlKey: true })
    expect(screen.queryByText('此字段必填')).not.toBeInTheDocument()   // 无字段错误
    expect(document.activeElement).toBe(before)                        // 未抢焦点
  })
})

test('AltGr(Ctrl+Alt) 与 Ctrl+Shift 组合不被热键劫持(终审 M-1)', async () => {
  useAppStore.setState({ catalogStatus: 'ready' })
  render(<App />)
  const search = await screen.findByTestId('nav-search')
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true, altKey: true })
  expect(document.activeElement).not.toBe(search)
  fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
  expect(document.activeElement).not.toBe(search)
})

// 真跨层集成:注入**真实** createNodeBridgeHost(不手工构造 HostRequestError),
// 让 HTTP 错误体走完 responseError → startCommand reject → App.catch → normalizeHostError
// → finishRun → RunPanel 渲染 整条链。二轮复审 P2 教训:测试名叫「跨层」不等于链路真跨层,
// 必须检查被测对象是否实例化了相邻层的真实实现——上一版手写 HostBridge 绕过了半条链。
class FakeES implements EventSourceLike {
  readyState = 1   // 已 open:ensureOpen 立即 resolve
  private readonly listeners = new Map<string, Set<(e: Event) => void>>()
  addEventListener(type: string, listener: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set<(e: Event) => void>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (e: Event) => void) { this.listeners.get(type)?.delete(listener) }
  close() { this.readyState = 2 }
}

test('真跨层集成:真实 NodeBridge 收 403 错误体 → RunPanel summary 常显、detail 按需(非 JS stack)(二轮复审 P2)', async () => {
  // 服务端 /start 错误体的真实形状(host-server.mjs 扁平 {error, detail};
  // policy.mjs 的 RequestPolicyError(403, '...', commandKey) 即产此内容)
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: false,
    status: 403,
    json: async () => ({ error: 'Command is outside the P0-B execution policy', detail: 'x/y' }),
  } as Response)
  const host = createNodeBridgeHost({ eventSourceFactory: () => new FakeES(), fetchImpl })

  useAppStore.setState({ catalogStatus: 'ready' })
  render(<App host={host} />)
  await screen.findByTestId('nav-search')
  const ok: CommandManifest = { command: 'x/y', site: 'x', name: 'y', description: '', access: 'read', browser: false, args: [] }
  act(() => { useAppStore.setState({ commands: [ok] }); useAppStore.getState().selectCommand(ok) })
  await userEvent.click(screen.getByTestId('run-button'))

  // ① store 层:summary/detail 分离(原断言保留)
  await waitFor(() => expect(useAppStore.getState().currentRun?.error).toBeDefined())
  const err = useAppStore.getState().currentRun!.error!
  expect(err.summary).toBe('Command is outside the P0-B execution policy')
  expect(err.detail).toBe('x/y')
  expect(err.detail).not.toContain('at ')                                   // 不是 JS stack

  // ② DOM 层:summary 常显且不含 detail
  const summary = await screen.findByText('Command is outside the P0-B execution policy')
  expect(summary).toBeInTheDocument()
  expect(summary.textContent).not.toContain('x/y')

  // ③ DOM 层:detail 初始隐藏,展开后是服务端 detail(非堆栈)
  expect(screen.queryByTestId('error-detail')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('error-detail-toggle'))
  const detail = screen.getByTestId('error-detail')
  expect(detail).toHaveTextContent('x/y')
  expect(detail.textContent).not.toContain('HostRequestError')              // 不是 JS stack
})
