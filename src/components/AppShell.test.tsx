import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import App from '../App'
import AppShell from './AppShell'
import type { HostBridge } from '../host/types'
import { useAppStore } from '../store/appStore'
import {
  defaultLayout,
  LAYOUT_KEY,
  NAV_DEFAULT,
  RUNS_DEFAULT,
  CONFIG_MIN,
  MODULE_SIDEBAR_DEFAULT,
  DETAILS_DEFAULT,
} from '../data/layout'

const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

beforeEach(() => useAppStore.setState({ catalogStatus: 'ready' }))

test('侧栏模块导航 + 灵感来源工作区显示演示模式', () => {
  render(<App />)
  expect(screen.getByTestId('module-tabs')).toBeInTheDocument()
  expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
  expect(screen.getByTestId('app-brand-icon')).toHaveAttribute('src', '/app-icon.png')
  expect(screen.getByTestId('app-header')).toHaveClass('flex-wrap')
  expect(screen.getByTestId('app-header-actions')).toHaveClass('app-header-actions')
})

test('真实 Host 注入时顶栏给出三路合一的总结论', async () => {
  // 顶栏那颗灯不再只代表 Node Host —— 它挂了、浏览器桥没就绪、视频解析异常,任一都得
  // 反映出来,所以桩要按端点分派:统一 { ok:true } 会让桥接那一路取不到 json 而误判。
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/browser-bridge/health')) {
      return { ok: true, json: async () => ({
        checkedAt: 1, daemon: 'running', extension: 'connected', profile: 'ready',
        profileCount: 1, retryable: false, reasonCode: 'ok', summary: '就绪',
      }) }
    }
    if (String(url).includes('/vk/v1/health')) return { ok: true, json: async () => ({ status: 'stopped' }) }
    return { ok: true }
  }))
  const host: HostBridge = {
    startCommand: async ({ runId }) => ({ runId }),
    cancelCommand: async () => {},
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={host} mode="connected" />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('检查中…')   // 新语义初态,顺带回归护栏
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('基础连接正常'))
})

// —— 左右栏显示/隐藏开关:直接渲染 AppShell(不经过 App/store),避免耦合目录加载与 Host 状态 ——
function renderShell() {
  return render(
    <AppShell
      nav={<div>NAV</div>}
      config={<div>CONFIG</div>}
      runs={<div>RUNS</div>}
      catalogStatus="ready"
      onRetryCatalog={() => {}}
    />
  )
}

function gridTemplate(): string {
  return screen.getByTestId('app-grid').style.gridTemplateColumns
}

test('主页面提供唯一且脱离布局流的通知悬浮层', () => {
  renderShell()
  const layer = screen.getByTestId('app-notification-layer')
  expect(screen.getAllByTestId('app-notification-layer')).toHaveLength(1)
  expect(layer.parentElement).toHaveClass('app-main')
  expect(indexCss).toMatch(/\.app-main\s*\{[^}]*position:\s*relative;/s)
  expect(indexCss).toMatch(/\.app-notification-layer\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*40;[^}]*top:\s*74px;[^}]*right:\s*12px;[^}]*left:\s*12px;[^}]*pointer-events:\s*none;/s)
  expect(indexCss).toMatch(/\.app-notification-layer \.app-alert\s*\{[^}]*pointer-events:\s*auto;/s)
  expect(indexCss).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.app-notification-layer\s*\{\s*top:\s*70px;/)
})

test('桌面健康状态浮层不被应用侧栏裁切', () => {
  expect(indexCss).toMatch(/\.app-sidebar-health\s*\{[^}]*overflow:\s*visible;/s)
})

test('默认两栏都显示:grid 列模板含五段,两条分隔条都在,两个开关 aria-pressed=true', () => {
  renderShell()
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(screen.getByTestId('col-runs')).toBeInTheDocument()
  expect(screen.getByTestId('separator-nav')).toBeInTheDocument()
  expect(screen.getByTestId('separator-runs')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`${NAV_DEFAULT}px auto minmax(${CONFIG_MIN}px, 1fr) auto ${RUNS_DEFAULT}px`)
  expect(screen.getByTestId('toggle-nav')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('toggle-runs')).toHaveAttribute('aria-pressed', 'true')
})

test('header shows the active module title without the duplicated brand label', () => {
  useAppStore.setState({ activeModule: 'providers' })
  renderShell()

  const header = screen.getByTestId('app-header')
  expect(within(header).getByText('模型配置')).toBeInTheDocument()
  expect(within(header).queryByText('爪爪')).not.toBeInTheDocument()
  expect(screen.getByTestId('app-sidebar')).toHaveTextContent('爪爪')
})

test('只隐藏左栏:col-nav 与 separator-nav 一并从 DOM 消失,列模板收缩为三段,右栏不受影响', () => {
  renderShell()
  fireEvent.click(screen.getByTestId('toggle-nav'))
  expect(screen.queryByTestId('col-nav')).not.toBeInTheDocument()
  expect(screen.queryByTestId('separator-nav')).not.toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(screen.getByTestId('col-runs')).toBeInTheDocument()
  expect(screen.getByTestId('separator-runs')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`minmax(${CONFIG_MIN}px, 1fr) auto ${RUNS_DEFAULT}px`)
  expect(screen.getByTestId('toggle-nav')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByTestId('toggle-runs')).toHaveAttribute('aria-pressed', 'true')
})

test('只隐藏右栏:col-runs 与 separator-runs 一并从 DOM 消失,列模板收缩为三段,左栏不受影响', () => {
  renderShell()
  fireEvent.click(screen.getByTestId('toggle-runs'))
  expect(screen.queryByTestId('col-runs')).not.toBeInTheDocument()
  expect(screen.queryByTestId('separator-runs')).not.toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(screen.getByTestId('separator-nav')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`${NAV_DEFAULT}px auto minmax(${CONFIG_MIN}px, 1fr)`)
  expect(screen.getByTestId('toggle-runs')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByTestId('toggle-nav')).toHaveAttribute('aria-pressed', 'true')
})

test('两栏都隐藏:列模板只剩中栏一段,两条分隔条都不在,中栏独占', () => {
  renderShell()
  fireEvent.click(screen.getByTestId('toggle-nav'))
  fireEvent.click(screen.getByTestId('toggle-runs'))
  expect(screen.queryByTestId('col-nav')).not.toBeInTheDocument()
  expect(screen.queryByTestId('col-runs')).not.toBeInTheDocument()
  expect(screen.queryByTestId('separator-nav')).not.toBeInTheDocument()
  expect(screen.queryByTestId('separator-runs')).not.toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`minmax(${CONFIG_MIN}px, 1fr)`)
})

test('隐藏→再显示:恢复隐藏前的宽度(不是重置为默认值),折叠状态与宽度写入同一份 localStorage 快照', () => {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ navWidth: 350, runsWidth: 400, navHidden: false, runsHidden: false }))
  renderShell()
  expect(gridTemplate()).toBe(`350px auto minmax(${CONFIG_MIN}px, 1fr) auto 400px`)

  fireEvent.click(screen.getByTestId('toggle-nav'))   // 隐藏左栏
  expect(screen.queryByTestId('col-nav')).not.toBeInTheDocument()
  expect(gridTemplate()).toBe(`minmax(${CONFIG_MIN}px, 1fr) auto 400px`)
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ ...defaultLayout(), navWidth: 350, runsWidth: 400, navHidden: true })

  fireEvent.click(screen.getByTestId('toggle-nav'))   // 再显示:宽度应是隐藏前的 350,不是 NAV_DEFAULT
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`350px auto minmax(${CONFIG_MIN}px, 1fr) auto 400px`)
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ ...defaultLayout(), navWidth: 350, runsWidth: 400 })
})

test('full-page modules keep the global sidebar toggle and persist its hidden state', () => {
  render(
    <AppShell
      nav={<div>NAV</div>}
      config={<div>CONFIG</div>}
      runs={<div>RUNS</div>}
      fullPage={<div>FULL PAGE</div>}
      catalogStatus="ready"
      onRetryCatalog={() => {}}
    />,
  )

  expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('aria-valuenow', String(MODULE_SIDEBAR_DEFAULT))
  fireEvent.click(screen.getByTestId('toggle-app-sidebar'))
  expect(screen.queryByTestId('app-sidebar')).not.toBeInTheDocument()
  expect(screen.queryByTestId('separator-app-sidebar')).not.toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({ moduleSidebarHidden: true })

  fireEvent.click(screen.getByTestId('toggle-app-sidebar'))
  expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('aria-valuenow', String(MODULE_SIDEBAR_DEFAULT))
})

test('the task details panel renders in a resizable right sidebar', () => {
  const onRightPanelOpenChange = vi.fn()
  render(
    <AppShell
      nav={<div>NAV</div>}
      config={<div>CONFIG</div>}
      runs={<div>RUNS</div>}
      fullPage={<div>FULL PAGE</div>}
      rightPanel={<div>DETAILS</div>}
      rightPanelOpen
      onRightPanelOpenChange={onRightPanelOpenChange}
      catalogStatus="ready"
      onRetryCatalog={() => {}}
    />,
  )

  expect(screen.getByTestId('details-sidebar')).toHaveTextContent('DETAILS')
  const separator = screen.getByTestId('separator-details-sidebar')
  expect(separator).toHaveAttribute('aria-valuenow', String(DETAILS_DEFAULT))
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(separator).toHaveAttribute('aria-valuenow', String(DETAILS_DEFAULT + 16))
  fireEvent.click(screen.getByTestId('toggle-details-sidebar'))
  expect(onRightPanelOpenChange).toHaveBeenCalledWith(false)
})
