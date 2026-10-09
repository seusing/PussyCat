import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GettingStarted } from './GettingStarted'
import { useAppStore } from '../../store/appStore'
import { GETTING_STARTED_DISMISSED_KEY } from '../../data/layout'
import type { BridgeHealth } from '../../host/bridgeClient'

const BASE = 'http://127.0.0.1:9999'
const initialState = useAppStore.getState()

const bridgeOk: BridgeHealth = {
  checkedAt: 1, daemon: 'running', extension: 'connected', profile: 'ready', profileCount: 1,
  retryable: false, reasonCode: 'ok', summary: '就绪',
}
const bridgeNoExtension: BridgeHealth = {
  ...bridgeOk, extension: 'disconnected', profile: 'unknown', retryable: true,
  reasonCode: 'extension-disconnected', summary: '扩展未连上',
}
const runtime = (over: Record<string, unknown> = {}) => ({
  state: 'not-installed', version: null, reasonCode: null, summary: '尚未安装', log: [], checkedAt: 't', ...over,
})
const runtimeReady = runtime({ state: 'installed', version: 'v1', current: true, summary: '已就绪' })

type Route = { status?: number; body: unknown | (() => unknown) }

function stubHost(routes: Record<string, Route>) {
  const calls: { key: string; init?: RequestInit }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    calls.push({ key, init })
    const route = routes[key]
    if (!route) return { ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) }
    const body = typeof route.body === 'function' ? (route.body as () => unknown)() : route.body
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => body }
  })
  vi.stubGlobal('fetch', impl)
  const count = (key: string) => calls.filter((call) => call.key === key).length
  return { calls, count }
}

const connected = () => useAppStore.setState({ mode: 'connected', activeModule: 'commands' })

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(initialState, true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('开始使用清单', () => {
  test('演示模式不显示,也不发任何请求', () => {
    const host = stubHost({})
    render(<GettingStarted baseUrl={BASE} />)
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument()
    expect(host.calls).toHaveLength(0)
  })

  test('三步都没做:各自显示状态和主操作,模型配置因引擎没好而不可点', async () => {
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    const extension = await screen.findByTestId('gs-step-extension')
    await waitFor(() => expect(extension).toHaveTextContent('还没连上扩展'))
    expect(within(extension).getByTestId('gs-install-extension')).toBeEnabled()
    expect(within(extension).getByTestId('gs-repair')).toBeEnabled()
    expect(extension).toHaveTextContent('灵感来源的命令、登录检查、部分小红书视频都需要它')

    const engine = screen.getByTestId('gs-step-engine')
    expect(engine).toHaveTextContent('还没准备')
    expect(within(engine).getByTestId('gs-install-engine')).toHaveTextContent('一键准备')

    const providers = screen.getByTestId('gs-step-providers')
    expect(providers).toHaveTextContent('先完成上一步')
    expect(within(providers).getByTestId('gs-configure')).toBeDisabled()
    // 引擎没好时不碰模型配置接口(它由引擎提供,问了也是 503)
    expect(host.count('GET /vk/v1/providers')).toBe(0)
  })

  test('扩展连上即完成:不再给安装扩展和检测并修复', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeOk },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    const extension = await screen.findByTestId('gs-step-extension')
    await waitFor(() => expect(extension).toHaveTextContent('已连接'))
    expect(extension).toHaveAttribute('data-done', 'true')
    expect(within(extension).queryByTestId('gs-install-extension')).not.toBeInTheDocument()
    expect(within(extension).queryByTestId('gs-repair')).not.toBeInTheDocument()
    expect(within(extension).queryByTestId('gs-offline')).not.toBeInTheDocument()
  })

  test('引擎好了、模型没配:去配置可点,点了跳到模型配置页', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtimeReady },
      'GET /vk/v1/providers': { body: { configured: false, cost_tracking: false, channels: [] } },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    const providers = await screen.findByTestId('gs-step-providers')
    await waitFor(() => expect(providers).toHaveTextContent('还没配置模型'))
    expect(screen.getByTestId('gs-step-engine')).toHaveAttribute('data-done', 'true')
    const configure = within(providers).getByTestId('gs-configure')
    expect(configure).toBeEnabled()

    await userEvent.click(configure)
    expect(useAppStore.getState().activeModule).toBe('providers')
  })

  test('引擎已装但不是当前版本:不算完成,按钮是立即更新', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeOk },
      'GET /vk/v1/runtime/status': { body: runtime({ state: 'installed', version: 'v0', current: false }) },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    const engine = await screen.findByTestId('gs-step-engine')
    await waitFor(() => expect(within(engine).getByTestId('gs-install-engine')).toHaveTextContent('立即更新'))
    expect(engine).toHaveAttribute('data-done', 'false')
    expect(screen.getByTestId('gs-step-providers')).toHaveTextContent('先完成上一步')
  })

  test('三步全部完成:清单收起并记住,不再显示', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeOk },
      'GET /vk/v1/runtime/status': { body: runtimeReady },
      'GET /vk/v1/providers': { body: { configured: true, cost_tracking: false, channels: [] } },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    await waitFor(() => expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument())
    expect(localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe('1')
  })

  test('不再显示:收起并持久化,下次进入不显示也不再请求', async () => {
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    const { unmount } = render(<GettingStarted baseUrl={BASE} />)
    await userEvent.click(await screen.findByTestId('gs-dismiss'))

    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument()
    expect(localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe('1')

    unmount()
    const before = host.calls.length
    render(<GettingStarted baseUrl={BASE} />)
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument()
    expect(host.calls.length).toBe(before)
  })
})

describe('扩展步骤的操作', () => {
  test('安装扩展:向 Host 要求打开应用店,之后刷新一次', async () => {
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
      'POST /browser-bridge/open-extension-page': { body: { ok: true } },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await userEvent.click(await screen.findByTestId('gs-install-extension'))

    await waitFor(() => expect(screen.getByTestId('gs-extension-note')).toHaveTextContent('已在 Chrome 打开应用店'))
    expect(host.count('POST /browser-bridge/open-extension-page')).toBe(1)
    await waitFor(() => expect(host.count('GET /browser-bridge/health')).toBe(2))
  })

  test('找不到 Chrome:提示先安装 Chrome', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
      'POST /browser-bridge/open-extension-page': { body: { ok: false, reasonCode: 'chrome-not-found' } },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await userEvent.click(await screen.findByTestId('gs-install-extension'))

    await waitFor(() => expect(screen.getByTestId('gs-extension-note')).toHaveTextContent('没找到 Chrome，请先安装 Chrome'))
  })

  test('检测并修复:POST repair,没修好时把 Host 给的下一步显示出来', async () => {
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
      'POST /browser-bridge/repair': {
        body: { steps: [], health: bridgeNoExtension, repaired: false, nextStep: '先点「安装扩展」，装好后再检测。' },
      },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await userEvent.click(await screen.findByTestId('gs-repair'))

    await waitFor(() => expect(screen.getByTestId('gs-extension-note')).toHaveTextContent('先点「安装扩展」'))
    expect(host.count('POST /browser-bridge/repair')).toBe(1)
  })

  test('打不开商店:离线安装步骤按 README 写', async () => {
    stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    const offline = await screen.findByTestId('gs-offline')

    expect(offline).toHaveTextContent('打不开商店？')
    await userEvent.click(within(offline).getByText('打不开商店？'))
    expect(offline).toHaveTextContent('GitHub Releases')
    expect(offline).toHaveTextContent('opencli-extension-v{版本号}.zip')
    expect(offline).toHaveTextContent('chrome://extensions')
    expect(offline).toHaveTextContent('开发者模式')
    expect(offline).toHaveTextContent('加载已解压的扩展程序')
  })

  test('多个 profile 需要指定:不给安装扩展,提示去连接状态里选', async () => {
    stubHost({
      'GET /browser-bridge/health': {
        body: { ...bridgeNoExtension, profile: 'required', reasonCode: 'profile-required', profileCount: 2 },
      },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)

    const extension = await screen.findByTestId('gs-step-extension')
    await waitFor(() => expect(extension).toHaveTextContent('请在左侧栏底部的连接状态里选一个'))
    expect(within(extension).queryByTestId('gs-install-extension')).not.toBeInTheDocument()
    expect(within(extension).queryByTestId('gs-offline')).not.toBeInTheDocument()       // 装没装扩展不是这里的问题
    expect(within(extension).getByTestId('gs-repair')).toBeInTheDocument()
  })
})

describe('解析引擎的一键准备与轮询', () => {
  test('一键准备走与视频解析页相同的安装请求,安装中显示进行中', async () => {
    let engineState = runtime()
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeOk },
      'GET /vk/v1/runtime/status': { body: () => engineState },
      'POST /vk/v1/runtime/install': {
        status: 202,
        body: () => { engineState = runtime({ state: 'installing', summary: '正在安装' }); return engineState },
      },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await userEvent.click(await screen.findByTestId('gs-install-engine'))

    const install = host.calls.find((call) => call.key === 'POST /vk/v1/runtime/install')
    expect(JSON.parse(String(install?.init?.body))).toEqual({ rebuild: false })
    const engine = screen.getByTestId('gs-step-engine')
    expect(engine).toHaveTextContent('正在准备')
    expect(within(engine).getByTestId('gs-install-engine')).toBeDisabled()
  })

  test('只在安装中每 4 秒轮询引擎状态;装好后刷新整张清单并停止轮询', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let engineState = runtime({ state: 'installing', summary: '正在安装' })
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeOk },
      'GET /vk/v1/runtime/status': { body: () => engineState },
      'GET /vk/v1/providers': { body: { configured: false, cost_tracking: false, channels: [] } },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('gs-step-engine')).toHaveTextContent('正在准备'))
    const afterMount = host.count('GET /vk/v1/runtime/status')

    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(host.count('GET /vk/v1/runtime/status')).toBe(afterMount + 1)
    expect(host.count('GET /browser-bridge/health')).toBe(1)          // 轮询只问引擎,不重复探浏览器

    engineState = runtimeReady
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    await waitFor(() => expect(screen.getByTestId('gs-step-providers')).toHaveTextContent('还没配置模型'))
    expect(screen.getByTestId('gs-step-engine')).toHaveAttribute('data-done', 'true')

    const settledCalls = host.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(host.calls.length).toBe(settledCalls)                       // 不在安装中,不再轮询
  })

  test('没在安装时完全不轮询', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await screen.findByTestId('gs-step-engine')
    await waitFor(() => expect(host.calls.length).toBe(2))

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(host.calls.length).toBe(2)
  })
})

describe('刷新时机', () => {
  test('切走再切回首页模块各刷新一次;在别的模块时不请求', async () => {
    const host = stubHost({
      'GET /browser-bridge/health': { body: bridgeNoExtension },
      'GET /vk/v1/runtime/status': { body: runtime() },
    })
    connected()
    render(<GettingStarted baseUrl={BASE} />)
    await waitFor(() => expect(host.count('GET /browser-bridge/health')).toBe(1))

    act(() => { useAppStore.getState().setActiveModule('login') })
    expect(host.count('GET /browser-bridge/health')).toBe(1)

    act(() => { useAppStore.getState().setActiveModule('commands') })
    await waitFor(() => expect(host.count('GET /browser-bridge/health')).toBe(2))
  })
})
