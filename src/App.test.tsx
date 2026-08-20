import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useAppStore } from './store/appStore'
import type { CommandManifest } from './data/types'
import type { HostBridge, RunRequest } from './host/types'
import { liveCatalogSource, type CatalogSource } from './host'
import { createNodeBridgeHost, type EventSourceLike } from './host/nodeBridgeHost'
import { normalizeHostError } from './App'
import { HostRequestError } from './host/errors'
import type { PolicyDecision } from './data/policy'
import { renderWithHost } from './testing/renderWithHost'

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
// P1 Task7:执行准入现在由 Host 判决闸控(I-P1)。既有用例给自己用到的命令补一条最简 ready
// 判决,否则运行按钮会因 decisions 为空而 disabled——语义变更,改写而非删除既有断言(R7)。
const readyDecision = (commandKey: string): PolicyDecision => ({ commandKey, state: 'ready', decisionSource: 'legacy-baseline' })

test('runId 是 UUID（非 run-N 序列），且 host.startCommand 与 store.currentRun 收到同一个值', async () => {
  useAppStore.setState({
    catalogStatus: 'ready', selected: cmd, values: {}, currentRun: undefined,
    decisions: new Map([[cmd.command, readyDecision(cmd.command)]]),
  })
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
  expect(screen.getByTestId('refresh-catalog')).toHaveTextContent('更新命令列表')
  expect(screen.getByTestId('refresh-catalog')).toHaveAttribute('title', expect.stringContaining('OpenCLI'))
  await userEvent.click(screen.getByTestId('refresh-catalog'))
  await waitFor(() => expect(useAppStore.getState().commands[0].command).toBe('c/d'))
  expect(screen.getByTestId('catalog-meta')).toBeInTheDocument()
})

test('登录和视频模块不显示命令列表操作', async () => {
  useAppStore.setState({ activeModule: 'login' })
  render(<App />)
  expect(screen.queryByTestId('refresh-catalog')).not.toBeInTheDocument()
  act(() => useAppStore.setState({ activeModule: 'vk' }))
  expect(screen.queryByTestId('refresh-catalog')).not.toBeInTheDocument()
})

test('公众号首次访问后常驻复用 iframe，切走再回来不重新拉状态', async () => {
  const wrssStatusCalls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/vk/v1/integrations/wrss')) {
      wrssStatusCalls.push(String(url))
      return new Response(JSON.stringify({
        state: 'running',
        summary: '公众号界面已就绪',
        reason_code: null,
        progress_log: [],
        version: '1.5.2',
        size_label: '约 356 MB（按需下载）',
        checked_at: '2026-08-11T00:00:00Z',
        ui_url: 'http://127.0.0.1:4567',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  useAppStore.setState({ catalogStatus: 'ready', activeModule: 'login' })
  render(<App catalogSource={sourceOf([async () => ({ snapshot: SNAP() })])} baseUrl="http://127.0.0.1:9999" />)

  expect(screen.queryByTestId('wrss-iframe')).not.toBeInTheDocument()
  expect(wrssStatusCalls).toHaveLength(0)
  await userEvent.click(screen.getByTestId('module-tab-wrss'))
  const frame = await screen.findByTestId('wrss-iframe')
  fireEvent.load(frame)
  await waitFor(() => expect(frame).toHaveClass('is-ready'))
  await waitFor(() => expect(screen.queryByTestId('wrss-skeleton')).not.toBeInTheDocument())
  expect(wrssStatusCalls).toHaveLength(1)

  await userEvent.click(screen.getByTestId('module-tab-login'))
  expect(screen.getByTestId('wrss-iframe')).toBe(frame)
  await userEvent.click(screen.getByTestId('module-tab-wrss'))
  expect(screen.getByTestId('wrss-iframe')).toBe(frame)
  expect(screen.queryByTestId('wrss-skeleton')).not.toBeInTheDocument()
  expect(wrssStatusCalls).toHaveLength(1)
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
    useAppStore.setState({ commands: [ok], catalogStatus: 'ready', decisions: new Map([[ok.command, readyDecision(ok.command)]]) })
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
    act(() => {
      useAppStore.setState({ commands: [ok], decisions: new Map([[ok.command, readyDecision(ok.command)]]) })
      useAppStore.getState().selectCommand(ok)
    })
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
  act(() => {
    useAppStore.setState({ commands: [ok], decisions: new Map([[ok.command, readyDecision(ok.command)]]) })
    useAppStore.getState().selectCommand(ok)
  })
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

// P1 Task7 验收命门:boot 注入的 baseUrl 必须经 props 贯穿 host/catalogSource/HealthPill 全线,
// 而不是 HealthPill 自己另读 env 回落 43117(那正是"目录能加载、顶栏却显示离线"的假离线 bug 根因)。
class RecordingEventSource implements EventSourceLike {
  readyState = 1   // 立即 open:ensureOpen 同步落定(同 nodeBridgeHost.test.ts 既有惯例)
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

test('五端点同端口:注入的 baseUrl 经 props 贯穿到 host/catalogSource/HealthPill,/health /catalog/effective /events /start /cancel 全部同源(P1 Task7 验收命门,不得弱化)', async () => {
  const baseUrl = 'http://127.0.0.1:54321'
  const urls: string[] = []

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    urls.push(url)
    if (url.endsWith('/health')) return Promise.resolve({ ok: true } as Response)
    // commands 含 cmd(x/go):setCommands 内部 reconcileSelection 按新列表核对 selected,
    // 列表不含 x/go 会把 selected 顶成 undefined(appStore.ts reconcileSelection),run-button 消失。
    // P1 Task7:liveCatalogSource 改打 /catalog/effective,envelope 里带 ready 判决——
    // 否则运行按钮会因 decisions 为空而 disabled(I-P1 判决闸)。
    if (url.endsWith('/catalog/effective')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          revision: 'r1',
          snapshot: SNAP({ commands: [cmd] }),
          policy: { schemaVersion: 1, generatedAt: 1, decisions: [readyDecision(cmd.command)] },
        }),
      } as Response)
    }
    if (url.endsWith('/start')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { runId?: string }) : {}
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ runId: body.runId }) } as Response)
    }
    if (url.endsWith('/cancel')) return Promise.resolve({ ok: true, status: 204, json: async () => undefined } as Response)
    return Promise.resolve({ ok: false, status: 404, json: async () => undefined } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)

  const host = createNodeBridgeHost({
    baseUrl,
    eventSourceFactory: (url) => { urls.push(url); return new RecordingEventSource(url) },
  })
  const catalogSource = liveCatalogSource(baseUrl)

  useAppStore.setState({
    catalogStatus: 'ready', selected: cmd, values: {}, currentRun: undefined,
    decisions: new Map([[cmd.command, readyDecision(cmd.command)]]),
  })
  render(<App host={host} catalogSource={catalogSource} mode="connected" baseUrl={baseUrl} />)

  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument())
  await userEvent.click(screen.getByTestId('cancel-button'))

  const endpoints = ['/health', '/catalog/effective', '/events', '/start', '/cancel']
  await waitFor(() => {
    endpoints.forEach((ep) => expect(urls.some((u) => u.startsWith(`${baseUrl}${ep}`))).toBe(true))
  })
  // 命门断言:五端点全部同一 baseUrl,零例外——弱化此断言即放过"假离线"回归
  urls.forEach((u) => expect(u.startsWith(`${baseUrl}/`)).toBe(true))
})

// P1 Task7 核心验证:前端不持有任何准入规则,只渲染 Host 下发的判决(I-P1)。
// 两组 fixture 刻意让 manifest 形状与判决"对着来"——manifest 看起来该放行的被 Host 拒,
// manifest 看起来该拦的被 Host 放,证明置灰/启用只认 decision.state,不认 access/strategy/browser。
describe('前端不自行裁决(对抗 fixture)', () => {
  it('A: manifest 看似满足旧派生条件,但 Host 判 denied → 必须置灰且不发 /start', async () => {
    const start = vi.fn()
    renderWithHost({
      commands: [{
        command: 'x/looks-ok', site: 'x', name: 'looks-ok', description: '',
        access: 'read', strategy: 'public', browser: false, args: [], columns: [],
      }],
      decisions: [{
        commandKey: 'x/looks-ok', state: 'denied', decisionSource: 'explicit-deny',
        reasonCode: 'explicit-deny', reason: '演示用拒绝',
      }],
      onStart: start,
    })
    // 导航站点默认收起,先展开再点命令 —— 只是到达路径变了,断言的对抗语义原样保留
    await userEvent.click(await screen.findByTestId('site-row-x'))
    await userEvent.click(await screen.findByText('looks-ok'))
    expect(screen.getByRole('button', { name: /运行任务/ })).toBeDisabled()
    expect(screen.getByText(/演示用拒绝/)).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()

    // 键盘路径(Ctrl+Enter)绕开 DOM disabled 属性,唯一挡住它的是 App.tsx executeSelected 里的
    // 判决闸——纯点击路径已经被 CommandConfig 自己的 disabled 挡住,实测过:摘掉 App.tsx 的判决闸
    // 不会让上面那条 start 断言变红(点击从未到达 executeSelected)。这条才是那道守卫的真变异靶点。
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(start).not.toHaveBeenCalled()
  })

  it('B: manifest 看似不满足旧条件,但 Host 判 ready → 必须启用', async () => {
    const start = vi.fn()
    renderWithHost({
      commands: [{
        command: 'y/looks-bad', site: 'y', name: 'looks-bad', description: '',
        access: 'write', strategy: 'cookie', browser: true, args: [], columns: [],
      }],
      decisions: [{
        commandKey: 'y/looks-bad', state: 'ready', decisionSource: 'tier-evaluation',
        metadata: {
          executionPath: 'browser-bridge', authorities: [], exposure: 'public',
          effects: [], credentialFlow: 'none', residues: [],
        },
      }],
      onStart: start,
    })
    await userEvent.click(await screen.findByTestId('site-row-y'))
    await userEvent.click(await screen.findByText('looks-bad'))
    expect(screen.getByRole('button', { name: /运行任务/ })).toBeEnabled()
  })

  it('decisions 为空(降级/demo) → 全局未连接徽标出现,运行按钮 disabled(不得编造 decision,I-P1)', async () => {
    const start = vi.fn()
    renderWithHost({
      commands: [{
        command: 'z/empty', site: 'z', name: 'empty', description: '',
        access: 'read', strategy: 'public', browser: false, args: [], columns: [],
      }],
      decisions: [],
      onStart: start,
    })
    expect(await screen.findByTestId('policy-disconnected')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('site-row-z'))
    await userEvent.click(await screen.findByText('empty'))
    expect(screen.getByRole('button', { name: /运行任务/ })).toBeDisabled()
    expect(start).not.toHaveBeenCalled()
  })
})

// Task 8:acknowledgement-required 命令的确认闸 + 409/428 分派。
describe('acknowledgement 流程(Task 8)', () => {
  const ackCmd: CommandManifest = {
    command: 'antigravity/recent-paths', site: 'antigravity', name: 'recent-paths', description: '', access: 'read', browser: false, args: [],
  }
  const ackDecision: PolicyDecision = {
    commandKey: ackCmd.command, state: 'acknowledgement-required', decisionSource: 'tier-evaluation',
    fingerprint: 'fp-1',
    metadata: { executionPath: 'direct-node', authorities: ['ambient-local-files'], exposure: 'personal', effects: [], credentialFlow: 'none', residues: [] },
  }
  const hostOf = (startCommand: (req: RunRequest) => Promise<{ runId: string }>): HostBridge => ({
    startCommand, cancelCommand: async () => {}, onOutput: () => () => {}, onDone: () => () => {},
  })

  test('未确认 → 点击运行不发 /start,弹出确认框', async () => {
    const startCommand = vi.fn((req: RunRequest) => Promise.resolve({ runId: req.runId }))
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    render(<App host={hostOf(startCommand)} mode="connected" />)
    await userEvent.click(screen.getByTestId('run-button'))
    expect(startCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('acknowledge-dialog')).toBeInTheDocument()
  })

  test('已确认且 fingerprint 匹配 → 发 /start 且携带 acknowledgement.fingerprint', async () => {
    const startCommand = vi.fn((req: RunRequest) => Promise.resolve({ runId: req.runId }))
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', Date.now())
    render(<App host={hostOf(startCommand)} mode="connected" />)
    await userEvent.click(screen.getByTestId('run-button'))
    expect(startCommand).toHaveBeenCalledOnce()
    expect(startCommand.mock.calls[0][0]).toMatchObject({ commandKey: ackCmd.command, acknowledgement: { fingerprint: 'fp-1' } })
    expect(screen.queryByTestId('acknowledge-dialog')).not.toBeInTheDocument()
  })

  test('指纹不匹配(策略已漂移)→ 视同未确认:不发 /start,弹确认框', async () => {
    const startCommand = vi.fn((req: RunRequest) => Promise.resolve({ runId: req.runId }))
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'stale-fp', Date.now())
    render(<App host={hostOf(startCommand)} mode="connected" />)
    await userEvent.click(screen.getByTestId('run-button'))
    expect(startCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('acknowledge-dialog')).toBeInTheDocument()
  })

  test('确认框点确认 → 写入 preferences 并立即触发运行', async () => {
    const startCommand = vi.fn((req: RunRequest) => Promise.resolve({ runId: req.runId }))
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    render(<App host={hostOf(startCommand)} mode="connected" />)
    await userEvent.click(screen.getByTestId('run-button'))
    await screen.findByTestId('acknowledge-dialog')
    await userEvent.click(screen.getByTestId('ack-confirm'))

    expect(useAppStore.getState().preferences.acknowledgements).toEqual([
      { commandKey: ackCmd.command, fingerprint: 'fp-1', acknowledgedAt: expect.any(Number) },
    ])
    await waitFor(() => expect(startCommand).toHaveBeenCalledOnce())
    expect(startCommand.mock.calls[0][0]).toMatchObject({ acknowledgement: { fingerprint: 'fp-1' } })
    expect(screen.queryByTestId('acknowledge-dialog')).not.toBeInTheDocument()
  })

  test('409(fingerprint-stale)→ 不原样展示,重拉目录 + 作废本地陈旧确认 + 用新 fingerprint 重新弹框', async () => {
    const err409 = new HostRequestError('Acknowledgement fingerprint is stale', '重新拉取 /catalog/effective 后再确认', 409, 'fingerprint-stale')
    const startCommand = vi.fn(() => Promise.reject(err409))
    const freshDecision: PolicyDecision = { ...ackDecision, fingerprint: 'fp-2' }
    // App 挂载时自己也会跑一次 fetchCatalog() 消耗同一个 catalogSource——第一次返回必须与
    // 预置的 store 状态(fp-1)一致,否则挂载阶段就把 fingerprint 顶成 fp-2,
    // 点击时会走"未确认"分支而不是走到本测试要验的 409 分支。第二次(409 触发的重拉)才回 fp-2。
    let loadCount = 0
    const catalogSource: CatalogSource = {
      kind: 'live',
      load: vi.fn(() => {
        loadCount += 1
        return Promise.resolve({ snapshot: SNAP({ commands: [ackCmd] }), decisions: [loadCount === 1 ? ackDecision : freshDecision] })
      }),
    }
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', Date.now())   // 陈旧确认(server 端已判定过期)
    render(<App host={hostOf(startCommand)} catalogSource={catalogSource} mode="connected" />)
    await waitFor(() => expect(catalogSource.load).toHaveBeenCalledTimes(1))   // 等挂载首拉落定,确认仍是 fp-1
    await waitFor(() => expect(useAppStore.getState().decisionFor(ackCmd.command)?.fingerprint).toBe('fp-1'))

    await userEvent.click(screen.getByTestId('run-button'))   // 本地判定已确认(fp-1 匹配)→ 直发请求 → 409

    // 不得把 409 原样当普通错误展示给用户
    await waitFor(() => expect(useAppStore.getState().currentRun?.error).toBeDefined())
    expect(useAppStore.getState().currentRun?.error?.summary).not.toBe('Acknowledgement fingerprint is stale')

    // 本地陈旧确认被作废
    await waitFor(() => expect(useAppStore.getState().preferences.acknowledgements).toEqual([]))
    // 目录已重拉,fingerprint 更新
    await waitFor(() => expect(useAppStore.getState().decisionFor(ackCmd.command)?.fingerprint).toBe('fp-2'))
    // 用新 fingerprint 重新弹出确认框(而非把 409 晾在原地)
    expect(await screen.findByTestId('acknowledge-dialog')).toBeInTheDocument()
  })

  test('428(acknowledgement-required)→ 不原样展示,弹确认框', async () => {
    const err428 = new HostRequestError('Command requires an acknowledgement', ackCmd.command, 428, 'acknowledgement-required')
    const startCommand = vi.fn(() => Promise.reject(err428))
    useAppStore.setState({
      catalogStatus: 'ready', selected: ackCmd, values: {}, currentRun: undefined, commands: [ackCmd],
      decisions: new Map([[ackCmd.command, ackDecision]]),
    })
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', Date.now())
    render(<App host={hostOf(startCommand)} mode="connected" />)
    await userEvent.click(screen.getByTestId('run-button'))

    await waitFor(() => expect(useAppStore.getState().currentRun?.error).toBeDefined())
    expect(useAppStore.getState().currentRun?.error?.summary).not.toBe('Command requires an acknowledgement')
    expect(await screen.findByTestId('acknowledge-dialog')).toBeInTheDocument()
  })
})

// ——— 登录检查的两条命门 ————————————————————————————————————————————
// 这两条都是「写错了也没人发现」的地方:分流漏了会悄悄污染用户的运行面板,
// 队列漏了会并发打 Host(maxConcurrentRuns=1,后来的直接 429)。
describe('登录状态检查的接线', () => {
  const whoami = (site: string) => ({
    command: `${site}/whoami`, site, name: 'whoami', description: '', access: 'read' as const,
    strategy: 'cookie', browser: true, args: [], columns: [],
  })
  const ackDecision = (site: string) => ({
    commandKey: `${site}/whoami`, state: 'acknowledgement-required' as const,
    decisionSource: 'tier-evaluation' as const, fingerprint: `fp-${site}`,
    metadata: {
      executionPath: 'browser-bridge' as const, authorities: ['browser-profile'], exposure: 'personal' as const,
      effects: [] as string[], credentialFlow: 'consume' as const, residues: [] as string[],
    },
  })

  /** 渲染 App 并暴露 startCommand 间谍与 onDone 触发器。 */
  it('撞上 Host 并发闸门(429)时退回队列重试,不显示成「检查失败」', async () => {
    // 用户实测撞到的形状:界面上写着「检查失败 Maximum concurrent runs reached」。
    // 那是 Host 满了,不是这个站点有毛病 —— 不该把容量问题甩成站点故障。
    const starts: string[] = []
    let rejectNext = true
    const host = {
      startCommand: vi.fn(async (req: { runId: string; commandKey: string }) => {
        starts.push(req.commandKey)
        if (rejectNext) {
          rejectNext = false
          throw new HostRequestError('Maximum concurrent runs reached', undefined, 429)
        }
        return { runId: req.runId }
      }),
      cancelCommand: async () => {},
      onOutput: () => () => {},
      onDone: () => () => {},
    }
    const commands = [whoami('xiaohongshu')]
    const catalogSource = {
      kind: 'live' as const,
      load: async () => ({
        snapshot: {
          schemaVersion: 1, generatedAt: 1, opencliVersion: 't', source: 't',
          listSha256: 't', manifestSha256: 't', commands,
        },
        decisions: [ackDecision('xiaohongshu')],
      }),
    }
    render(<App host={host as never} catalogSource={catalogSource as never} mode="connected" />)
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(1))
    act(() => {
      useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
      useAppStore.getState().enqueueLoginChecks(['xiaohongshu'])
    })

    await waitFor(() => expect(starts.length).toBe(1))
    // 429 之后**不是** error:退回队列,等有位子了再发一次。
    await waitFor(() => expect(starts.length).toBe(2), { timeout: 3000 })
    expect(useAppStore.getState().loginChecks.xiaohongshu?.state).not.toBe('error')
  })

  it('非 429 的启动失败仍然如实记成检查失败 —— 不把真故障也吞成重试', async () => {
    const host = {
      startCommand: vi.fn(async () => { throw new HostRequestError('命令已被策略拒绝', undefined, 403) }),
      cancelCommand: async () => {},
      onOutput: () => () => {},
      onDone: () => () => {},
    }
    const commands = [whoami('xiaohongshu')]
    const catalogSource = {
      kind: 'live' as const,
      load: async () => ({
        snapshot: {
          schemaVersion: 1, generatedAt: 1, opencliVersion: 't', source: 't',
          listSha256: 't', manifestSha256: 't', commands,
        },
        decisions: [ackDecision('xiaohongshu')],
      }),
    }
    render(<App host={host as never} catalogSource={catalogSource as never} mode="connected" />)
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(1))
    act(() => {
      useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
      useAppStore.getState().enqueueLoginChecks(['xiaohongshu'])
    })

    await waitFor(() => expect(useAppStore.getState().loginChecks.xiaohongshu?.state).toBe('error'))
    expect(useAppStore.getState().loginChecks.xiaohongshu?.detail).toContain('策略')
  })

  function renderApp(sites: string[]) {
    const starts: { runId: string; commandKey: string }[] = []
    let emitDone: ((e: { runId: string; at: number; outcome: 'success' | 'error'; result?: Record<string, unknown>[] }) => void) | undefined
    const host = {
      startCommand: vi.fn(async (req: { runId: string; commandKey: string }) => {
        starts.push({ runId: req.runId, commandKey: req.commandKey })
        return { runId: req.runId }
      }),
      cancelCommand: async () => {},
      onOutput: () => () => {},
      onDone: (cb: typeof emitDone) => { emitDone = cb; return () => {} },
    }
    const commands = sites.map(whoami)
    const catalogSource = {
      kind: 'live' as const,
      load: async () => ({
        snapshot: {
          schemaVersion: 1, generatedAt: 1, opencliVersion: 't', source: 't',
          listSha256: 't', manifestSha256: 't', commands,
        },
        decisions: sites.map(ackDecision),
      }),
    }
    render(<App host={host as never} catalogSource={catalogSource as never} mode="connected" />)
    return { starts, done: (e: Parameters<NonNullable<typeof emitDone>>[0]) => act(() => emitDone!(e)) }
  }

  // 实测更正:这条性质**不是 App 的 runId 分流保证的**,而是 store 的 appendOutput/finishRun
  // 本就按 `currentRun.id !== e.runId` 过滤(appStore.ts:151,154)。摘掉分流后本用例仍然绿,
  // 红的是下面那条串行队列——因为分流的**正向那一半**(把 done 路由给 finishLoginCheck)才是承重的。
  // 如实记在这里,免得后人以为这条用例守着分流。
  it('登录检查的终态不覆盖用户正在看的那次运行(由 store 的 runId 过滤保证)', async () => {
    const { done } = renderApp(['xiaohongshu'])
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(1))
    // 造一个用户自己发起的、仍在运行中的 run
    act(() => { useAppStore.getState().selectCommand(useAppStore.getState().commands[0]); useAppStore.getState().beginRun('user-run-1') })
    expect(useAppStore.getState().currentRun?.state).toBe('starting')

    // 登录检查的 done 到达
    done({ runId: 'login-check:xiaohongshu:n1', at: 2, outcome: 'success', result: [{ logged_in: true }] })

    // 用户那次运行**必须原封不动**
    expect(useAppStore.getState().currentRun?.id).toBe('user-run-1')
    expect(useAppStore.getState().currentRun?.state).toBe('starting')
    expect(useAppStore.getState().currentRun?.result).toBeUndefined()
  })

  it('队列**并发**:两个站点同时发出,不再一个等一个', async () => {
    // 语义变更:65 个站点全是浏览器命令,串行跑完要好几分钟,而时间几乎全花在
    // 等浏览器往返上。这条用例从"只发一个"翻成"两个一起发",是有意的契约改变。
    const { starts } = renderApp(['xiaohongshu', 'bilibili'])
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(2))
    act(() => {
      useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
      useAppStore.getState().acknowledgeCommand('bilibili/whoami', 'fp-bilibili', 1)
      useAppStore.getState().enqueueLoginChecks(['xiaohongshu', 'bilibili'])
    })

    await waitFor(() => expect(starts.length).toBe(2))
    expect(useAppStore.getState().loginInFlights).toHaveLength(2)
    // 两个 runId 必须各不相同 —— 并发之后按 runId 归属结果,串味就会张冠李戴。
    expect(new Set(starts.map((s) => s.runId)).size).toBe(2)
  })

  it('并发有上限:排 5 个站点时最多同时飞 3 个,其余留在队列', async () => {
    const sites = ['xiaohongshu', 'bilibili', 'github', 'zhihu', 'douban']
    const { starts } = renderApp(sites)
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(sites.length))
    act(() => {
      for (const site of sites) useAppStore.getState().acknowledgeCommand(`${site}/whoami`, `fp-${site}`, 1)
      useAppStore.getState().enqueueLoginChecks(sites)
    })

    await waitFor(() => expect(starts.length).toBe(3))
    // 关键是**不会**一口气把 5 个全发出去 —— 那会撞上 Host 的并发上限吃 429。
    await new Promise((r) => setTimeout(r, 20))
    expect(starts.length).toBe(3)
    expect(useAppStore.getState().loginQueue).toHaveLength(2)
  })

  it('用户手动发起的命令占着位子时,后台体检再退让一个', async () => {
    const sites = ['xiaohongshu', 'bilibili', 'github', 'zhihu']
    const { starts } = renderApp(sites)
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(sites.length))
    act(() => {
      // beginRun 需要先有 selected(store 里就是这么写的),否则它直接空转、
      // currentRun 仍是 undefined —— 那样这条用例就测不到"退让"了。
      useAppStore.getState().selectCommand(useAppStore.getState().commands[0])
      useAppStore.getState().beginRun('manual-run-1')   // 用户自己的运行在飞
      for (const site of sites) useAppStore.getState().acknowledgeCommand(`${site}/whoami`, `fp-${site}`, 1)
      useAppStore.getState().enqueueLoginChecks(sites)
    })
    expect(useAppStore.getState().currentRun).toBeTruthy()   // 前置条件成立才谈退让

    // 后台体检只用 2 个位子,把最后一个留给用户 —— 用户的操作永远不排在体检后面。
    await waitFor(() => expect(starts.length).toBe(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(starts.length).toBe(2)
  })

  it('acknowledgement 随请求提交 —— 否则 Host 返 428', async () => {
    const { starts } = renderApp(['xiaohongshu'])
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(1))
    act(() => {
      useAppStore.getState().acknowledgeCommand('xiaohongshu/whoami', 'fp-xiaohongshu', 1)
      useAppStore.getState().enqueueLoginChecks(['xiaohongshu'])
    })
    await waitFor(() => expect(starts.length).toBe(1))
    expect(starts[0].commandKey).toBe('xiaohongshu/whoami')
    expect(starts[0].runId.startsWith('login-check:')).toBe(true)
  })

  it('未确认的站点**不发请求**,如实落成需先确认', async () => {
    const { starts } = renderApp(['xiaohongshu'])
    await waitFor(() => expect(useAppStore.getState().commands.length).toBe(1))
    act(() => { useAppStore.getState().enqueueLoginChecks(['xiaohongshu']) })
    await waitFor(() => expect(useAppStore.getState().loginChecks.xiaohongshu?.state).toBe('needs-ack'))
    expect(starts.length).toBe(0)
  })
})
