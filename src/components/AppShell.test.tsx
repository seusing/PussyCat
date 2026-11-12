import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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

test('侧栏模块导航 + 首页固定为灵感来源并显示演示模式', () => {
  render(<App />)
  expect(screen.getByTestId('module-tabs')).toBeInTheDocument()
  expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
  expect(screen.queryByTestId('inspiration-library')).not.toBeInTheDocument()
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
  expect(screen.getByTestId('app-brand-icon')).toHaveAttribute('src', '/app-icon.png')
  expect(screen.getByTestId('app-version')).toHaveTextContent('v1.2.3')
  expect(screen.getByTestId('app-header')).toHaveClass('flex-wrap')
  expect(screen.getByTestId('app-header-actions')).toHaveClass('app-header-actions')
})

test('灵感来源可以打开灵感库并切回', () => {
  render(<App />)
  fireEvent.click(screen.getByTestId('open-inspiration-library'))
  expect(screen.getByTestId('inspiration-library-empty')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('inspiration-sources-tab'))
  expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
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

test('主页面提供唯一且脱离布局流的通知悬浮层,位置由变量控制', () => {
  renderShell()
  const layer = screen.getByTestId('app-notification-layer')
  expect(screen.getAllByTestId('app-notification-layer')).toHaveLength(1)
  expect(layer.parentElement).toHaveClass('app-main')
  expect(indexCss).toMatch(/\.app-main\s*\{[^}]*position:\s*relative;/s)
  const layerRule = indexCss.match(/\.app-notification-layer\s*\{([^}]*)\}/s)![1]
  expect(layerRule).toMatch(/position:\s*absolute;/)
  expect(layerRule).toMatch(/z-index:\s*40;/)
  expect(layerRule).toMatch(/top:\s*var\(--toast-lane-top,\s*10px\);/)
  expect(layerRule).toMatch(/right:\s*var\(--toast-lane-right,\s*12px\);/)
  expect(layerRule).toMatch(/left:\s*var\(--toast-lane-left,\s*12px\);/)
  expect(layerRule).toMatch(/max-height:\s*calc\(100% - var\(--toast-lane-top,\s*10px\) - 10px\);/)
  expect(layerRule).toMatch(/pointer-events:\s*none;/)
  expect(layerRule).not.toMatch(/74px/)
  expect(indexCss).toMatch(/\.app-notification-layer > \*\s*\{\s*width:\s*min\(560px,\s*100%\);/)
  expect(indexCss).toMatch(/\.app-notification-layer \.app-alert\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*0;[^}]*pointer-events:\s*auto;/s)
  // 窄窗口不再有写死的 top:有变量就够了
  expect(indexCss).not.toMatch(/\.app-notification-layer\s*\{\s*top:\s*70px;/)
})

describe('弹窗通道随顶栏测量', () => {
  type Rect = { left: number; right: number; top: number; bottom: number }
  const rectOf = (value: Rect) => ({ ...value, width: value.right - value.left, height: value.bottom - value.top, x: value.left, y: value.top, toJSON: () => ({}) }) as DOMRect
  const MAIN: Rect = { left: 229, right: 1280, top: 0, bottom: 900 }
  const HEADER: Rect = { left: 229, right: 1280, top: 0, bottom: 62 }
  const TITLE: Rect = { left: 331, right: 391, top: 21, bottom: 41 }
  const ACTIONS: Rect = { left: 1110, right: 1258, top: 14, bottom: 48 }
  let rects: Record<string, Rect>

  // jsdom 没有布局:按 data-testid 给几个关键元素喂矩形。
  beforeEach(() => {
    rects = { 'app-main': MAIN, 'app-header': HEADER, 'app-header-title': TITLE, 'app-header-actions': ACTIONS }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rectOf(rects[this.dataset.testid ?? ''] ?? { left: 0, right: 0, top: 0, bottom: 0 })
    })
  })
  afterEach(() => vi.restoreAllMocks())

  const nextFrame = () => act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))) })
  const layer = () => screen.getByTestId('app-notification-layer')

  test('通道够宽:弹窗压在顶栏这一行,距顶 10px,左右各离标题和按钮 12px', () => {
    renderShell()

    expect(layer()).toHaveAttribute('data-placement', 'header')
    expect(layer().style.getPropertyValue('--toast-lane-top')).toBe('10px')
    expect(layer().style.getPropertyValue('--toast-lane-left')).toBe(`${391 - 229 + 12}px`)
    expect(layer().style.getPropertyValue('--toast-lane-right')).toBe(`${1280 - 1110 + 12}px`)
  })

  test('通道不够 320px:退到顶栏下方 8px,左右各 12px', () => {
    rects['app-header-actions'] = { left: 700, right: 1258, top: 14, bottom: 48 }   // 标题右边 391 → 通道 700-391-24 = 285
    renderShell()

    expect(layer()).toHaveAttribute('data-placement', 'below-header')
    expect(layer().style.getPropertyValue('--toast-lane-top')).toBe(`${62 + 8}px`)
    expect(layer().style.getPropertyValue('--toast-lane-left')).toBe('12px')
    expect(layer().style.getPropertyValue('--toast-lane-right')).toBe('12px')
  })

  test('顶栏换行(按钮组掉到标题下面)也退到顶栏下方,按顶栏实际底边算', () => {
    rects['app-header'] = { left: 229, right: 760, top: 0, bottom: 104 }
    rects['app-main'] = { left: 229, right: 760, top: 0, bottom: 900 }
    rects['app-header-actions'] = { left: 241, right: 748, top: 56, bottom: 90 }
    renderShell()

    expect(layer()).toHaveAttribute('data-placement', 'below-header')
    expect(layer().style.getPropertyValue('--toast-lane-top')).toBe(`${104 + 8}px`)
  })

  test('窗口尺寸变化后每帧重算一次', async () => {
    renderShell()
    expect(layer()).toHaveAttribute('data-placement', 'header')

    rects['app-header-actions'] = { left: 700, right: 1258, top: 14, bottom: 48 }
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(layer()).toHaveAttribute('data-placement', 'header')   // 还没到下一帧
    await nextFrame()

    expect(layer()).toHaveAttribute('data-placement', 'below-header')
  })

  test('卸载时取消监听:之后的窗口变化不再写样式', async () => {
    const { unmount } = renderShell()
    const node = layer()
    unmount()
    rects['app-header-actions'] = { left: 700, right: 1258, top: 14, bottom: 48 }
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)))

    expect(node.dataset.placement).toBe('header')
  })
})

test('通知铃铛是顶栏按钮组的直接子按钮,排在各模块的按钮之后、运行面板开关之前', () => {
  render(
    <AppShell
      nav={<div>NAV</div>} config={<div>CONFIG</div>} runs={<div>RUNS</div>}
      catalogStatus="ready" onRetryCatalog={() => {}}
      headerActions={<span data-testid="module-action">模块按钮</span>}
    />,
  )
  const actions = screen.getByTestId('app-header-actions')
  const children = Array.from(actions.children)

  expect(screen.getByTestId('notification-bell').parentElement).toBe(actions)
  expect(children.map((child) => child.getAttribute('data-testid'))).toEqual(['module-action', 'notification-bell', 'toggle-runs'])
})

test('headerTrailing 紧跟通知铃铛渲染,在运行面板开关之前', () => {
  render(
    <AppShell
      nav={<div>NAV</div>} config={<div>CONFIG</div>} runs={<div>RUNS</div>}
      catalogStatus="ready" onRetryCatalog={() => {}}
      headerActions={<span data-testid="module-action">模块按钮</span>}
      headerTrailing={<button type="button" data-testid="trailing-action">尾部按钮</button>}
    />,
  )
  const children = Array.from(screen.getByTestId('app-header-actions').children)

  expect(children.map((child) => child.getAttribute('data-testid')))
    .toEqual(['module-action', 'notification-bell', 'trailing-action', 'toggle-runs'])
})

test('桌面健康状态浮层不被应用侧栏裁切', () => {
  expect(indexCss).toMatch(/\.app-sidebar-health\s*\{[^}]*overflow:\s*visible;/s)
})

test('模块侧栏折叠 rail 保留固定图标槽并淡出标签', () => {
  expect(indexCss).toMatch(/\.app-sidebar\[data-sidebar-collapsed='true'\][\s\S]*?padding-inline:\s*7px;/)
  expect(indexCss).toMatch(/\.app-sidebar\[data-sidebar-collapsed='true'\] \.sidebar-label[\s\S]*?opacity:\s*0;/)
  expect(indexCss).toMatch(/transition:\s*width\s+280ms\s+cubic-bezier\(\.16, 1, \.3, 1\)/)
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

test('外壳回写栏宽、折叠时不冲掉登录页刚打开的「定时检查」', () => {
  renderShell()   // 外壳此刻读到的是定时检查还没开的那份
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...defaultLayout(), autoLoginRefresh: true, autoLoginRefreshMinutes: 15 }))   // 登录页随后打开了开关

  fireEvent.keyDown(screen.getByTestId('separator-nav'), { key: 'ArrowRight' })
  fireEvent.click(screen.getByTestId('toggle-runs'))

  const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY)!)
  expect(stored).toMatchObject({ autoLoginRefresh: true, autoLoginRefreshMinutes: 15, runsHidden: true })
  expect(stored.navWidth).toBeGreaterThan(NAV_DEFAULT)
})

test('full-page modules keep a collapsed rail and persist its hidden state', () => {
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
  expect(screen.getByTestId('app-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'true')
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('data-disabled', 'true')
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('tabindex', '-1')
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('aria-hidden', 'true')
  expect(screen.getByTestId('app-shell')).toHaveAttribute('data-sidebar-collapsed', 'true')
  expect(screen.getByTestId('toggle-app-sidebar')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByTestId('toggle-app-sidebar')).toHaveAccessibleName('展开应用导航栏')
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({ moduleSidebarHidden: true })

  fireEvent.click(screen.getByTestId('toggle-app-sidebar'))
  expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
  expect(screen.getByTestId('app-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'false')
  expect(screen.getByTestId('separator-app-sidebar')).not.toHaveAttribute('data-disabled')
  expect(screen.getByTestId('toggle-app-sidebar')).toHaveAccessibleName('折叠应用导航栏')
  expect(screen.getByTestId('separator-app-sidebar')).toHaveAttribute('aria-valuenow', String(MODULE_SIDEBAR_DEFAULT))
})

test('折叠 rail 仍计入详情栏夹取,避免窄窗口挤压状态内容', () => {
  render(
    <AppShell
      nav={<div>NAV</div>}
      config={<div>CONFIG</div>}
      runs={<div>RUNS</div>}
      fullPage={<div>FULL PAGE</div>}
      rightPanel={<div>DETAILS</div>}
      rightPanelOpen
      catalogStatus="ready"
      onRetryCatalog={() => {}}
    />,
  )
  fireEvent.click(screen.getByTestId('toggle-app-sidebar'))
  expect(screen.getByTestId('app-shell').style.gridTemplateColumns)
    .toContain('56px 0px minmax(360px, 1fr) auto 380px')
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
