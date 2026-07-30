import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserBridgeStatus } from './BrowserBridgeStatus'
import { useAppStore } from '../store/appStore'

const BASE = 'http://127.0.0.1:1234'

/** Host 投影后的形状(server/browser-bridge-health.mjs),字段名逐字对齐。 */
function health(over: Record<string, unknown> = {}) {
  return {
    checkedAt: 1, daemon: 'running', daemonVersion: '1.8.6',
    extension: 'connected', extensionVersion: '0.9.1',
    profile: 'ready', profileCount: 1, opencliVersion: '1.8.6',
    retryable: false, reasonCode: 'ok', summary: '浏览器桥接就绪',
    ...over,
  }
}

function stubFetch(body: unknown, { ok = true, status = 200 } = {}) {
  // 形参显式声明:否则 mock 的 calls 元组长度为 0,断言 calls[0][0] 过不了 tsc。
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok, status, json: async () => body }))
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(() => {
  useAppStore.setState({ mode: 'connected' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('就绪时展示 daemon/扩展/profile 三项与版本', async () => {
  stubFetch(health())
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('bridge-label')).toHaveTextContent('浏览器桥接就绪'))
  const detail = screen.getByTestId('bridge-detail')
  expect(detail).toHaveTextContent('daemon 运行中')
  expect(detail).toHaveTextContent('扩展 已连接')
  expect(detail).toHaveTextContent('profile 就绪')
  expect(detail).toHaveTextContent('opencli 1.8.6')
})

test('扩展未连接时展示 Host 给的失败原因,而不是前端自己编一句', async () => {
  stubFetch(health({
    extension: 'disconnected', extensionVersion: undefined, profile: 'unknown',
    reasonCode: 'extension-disconnected', retryable: true,
    summary: 'daemon 在运行,但 Chrome 扩展未连上',
  }))
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  // 文案直接来自 Host 的 summary —— 前端不重写判定,也不重写措辞。
  await waitFor(() => expect(screen.getByTestId('bridge-label')).toHaveTextContent('daemon 在运行,但 Chrome 扩展未连上'))
  expect(screen.getByTestId('bridge-detail')).toHaveTextContent('扩展 未连接')
})

test('daemon 未运行 → 如实展示,不谎报就绪', async () => {
  stubFetch(health({
    daemon: 'stopped', daemonVersion: undefined, extension: 'unknown', profile: 'unknown',
    profileCount: 0, reasonCode: 'daemon-stopped', retryable: true,
    summary: 'daemon 未运行(首次执行浏览器命令时 opencli 会自行拉起)',
  }))
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('bridge-detail')).toHaveTextContent('daemon 未运行'))
  expect(screen.getByTestId('bridge-label')).not.toHaveTextContent('就绪')
})

test('探测本身失败(Host 不可达)与「Host 说没就绪」区分开', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('bridge-label')).toHaveTextContent('桥接状态未知'))
  // 不伪造一个 health:问不到就是问不到。
  expect(screen.getByTestId('bridge-detail')).toHaveTextContent('未能取得诊断结果')
})

test('重新检测按钮真的再打一次 —— 且用的是注入的 baseUrl', async () => {
  const spy = stubFetch(health())
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  expect(spy.mock.calls[0][0]).toBe(`${BASE}/browser-bridge/health`)
  await userEvent.click(screen.getByTestId('bridge-recheck'))
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
})

test('demo 模式不探测、不渲染 —— 没有 Host 就没有桥接可言', async () => {
  useAppStore.setState({ mode: 'demo' })
  const spy = stubFetch(health())
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  expect(screen.queryByTestId('browser-bridge-status')).not.toBeInTheDocument()
  expect(spy).not.toHaveBeenCalled()
})

test('只渲染白名单字段 —— 即便响应里混进敏感值也不上屏', async () => {
  // Host 侧已做投影(server/browser-bridge-health.test.mjs 守着它)。这一条守的是**前端不兜底地
  // 把整包 JSON 倒到界面上**:组件逐字段取值,不 stringify 整个响应。
  stubFetch(health({ contextId: 'ctx-abc123', pid: 4242, port: 19825, cookies: [{ value: 'super-secret' }] }))
  render(<BrowserBridgeStatus baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('bridge-label')).toHaveTextContent('就绪'))
  const rendered = screen.getByTestId('browser-bridge-status')
  expect(rendered.textContent).not.toContain('ctx-abc123')
  expect(rendered.textContent).not.toContain('4242')
  expect(rendered.textContent).not.toContain('19825')
  expect(rendered.textContent).not.toContain('super-secret')
  // title 属性同样不得夹带
  expect(rendered.getAttribute('title')).not.toContain('ctx-abc123')
})
