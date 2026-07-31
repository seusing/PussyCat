import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import App from '../App'
import AppShell from './AppShell'
import type { HostBridge } from '../host/types'
import { useAppStore } from '../store/appStore'
import { LAYOUT_KEY, NAV_DEFAULT, RUNS_DEFAULT, CONFIG_MIN } from '../data/layout'

beforeEach(() => useAppStore.setState({ catalogStatus: 'ready' }))

test('三栏 + 顶部健康 pill 显示演示模式', () => {
  render(<App />)
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(screen.getByTestId('col-runs')).toBeInTheDocument()
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
})

test('真实 Host 注入时显示已连接', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))   // 压掉 vitest.setup 永不落定的默认桩
  const host: HostBridge = {
    startCommand: async ({ runId }) => ({ runId }),
    cancelCommand: async () => {},
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={host} mode="connected" />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('检查中…')   // 新语义初态,顺带回归护栏
  await waitFor(() => expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接'))
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
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ navWidth: 350, runsWidth: 400, navHidden: true, runsHidden: false })

  fireEvent.click(screen.getByTestId('toggle-nav'))   // 再显示:宽度应是隐藏前的 350,不是 NAV_DEFAULT
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(gridTemplate()).toBe(`350px auto minmax(${CONFIG_MIN}px, 1fr) auto 400px`)
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ navWidth: 350, runsWidth: 400, navHidden: false, runsHidden: false })
})
