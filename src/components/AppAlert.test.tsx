import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, type ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAlert } from './AppAlert'
import { AppNotificationPortal } from './AppNotificationPortal'
import { NotificationLayerContext, NotificationStackCardContext } from './notificationContext'

test('按 tone 输出 data 属性和默认图标', () => {
  render(<AppAlert tone="success" title="已保存" testId="alert" />)
  const alert = screen.getByTestId('alert')
  expect(alert).toHaveAttribute('data-tone', 'success')
  expect(alert.querySelector('svg')).not.toBeNull()
})

test('渲染标题、描述和 action slot', () => {
  render(
    <AppAlert
      tone="info"
      title="任务已提交"
      description="后台会继续处理"
      action={<button type="button">查看</button>}
    />,
  )
  expect(screen.getByText('任务已提交')).toBeInTheDocument()
  expect(screen.getByText('后台会继续处理')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument()
})

test('关闭按钮语义完整并触发回调', async () => {
  const onClose = vi.fn()
  render(<AppAlert title="可关闭" onClose={onClose} closeLabel="关闭提醒" />)
  await userEvent.click(screen.getByRole('button', { name: '关闭提醒' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('受控进度条带 aria 数值和宽度', () => {
  render(<AppAlert title="进行中" progress={37.4} progressTestId="progress" />)
  const progress = screen.getByRole('progressbar', { name: '通知剩余时间' })
  expect(progress).toBe(screen.getByTestId('progress'))
  expect(progress).toHaveAttribute('role', 'progressbar')
  expect(progress).toHaveAttribute('aria-valuenow', '37')
  expect(progress).toHaveStyle({ width: '37.4%' })
})

test('duration 进度条使用倒计时动画', () => {
  render(<AppAlert title="自动消失" durationMs={3000} progressTestId="progress" />)
  const progress = screen.getByRole('progressbar', { name: '通知剩余时间' })
  expect(progress).toBe(screen.getByTestId('progress'))
  expect(progress).not.toHaveAttribute('aria-valuenow')
  expect(progress).toHaveAttribute('aria-valuetext', '3 秒后自动关闭')
  expect(progress).toHaveClass('is-duration')
  expect(progress).toHaveStyle({ animationDuration: '3000ms' })
})

test('错开出现的通知各自到期，父级更新使用最新回调但不延长计时', () => {
  vi.useFakeTimers()
  try {
    const first = vi.fn()
    const latestFirst = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = render(<AppAlert key="first" title="第一条" durationMs={2000} onExpire={first} />)
    act(() => vi.advanceTimersByTime(1000))
    rerender([
      <AppAlert key="second" title="第二条" durationMs={2000} onExpire={second} />,
      <AppAlert key="first" title="第一条" durationMs={2000} onExpire={latestFirst} />,
    ])
    act(() => vi.advanceTimersByTime(1000))
    expect(first).not.toHaveBeenCalled()
    expect(latestFirst).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1000))
    expect(second).toHaveBeenCalledTimes(1)
    rerender(<AppAlert title="已卸载" durationMs={2000} onExpire={first} />)
    unmount()
    act(() => vi.advanceTimersByTime(2000))
    expect(first).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

describe('ref 转发', () => {
  test('对象 ref 拿到根节点,卸载时清空', () => {
    const ref = createRef<HTMLDivElement>()
    const { unmount } = render(<AppAlert ref={ref} title="可拿 ref" testId="alert" />)
    expect(ref.current).toBe(screen.getByTestId('alert'))
    unmount()
    expect(ref.current).toBeNull()
  })

  test('回调 ref 先收到根节点,卸载时收到 null', () => {
    const ref = vi.fn()
    const { unmount } = render(<AppAlert ref={ref} title="回调 ref" testId="alert" />)
    expect(ref).toHaveBeenLastCalledWith(screen.getByTestId('alert'))
    unmount()
    expect(ref).toHaveBeenLastCalledWith(null)
  })
})

describe('液态玻璃', () => {
  const originalHyalite = { supported: window.Hyalite.supported, attach: window.Hyalite.attach, detach: window.Hyalite.detach }
  beforeEach(() => {
    window.Hyalite.supported = vi.fn(() => true)
    window.Hyalite.attach = vi.fn()
    window.Hyalite.detach = vi.fn()
  })
  afterEach(() => Object.assign(window.Hyalite, originalHyalite))

  const inLayer = (alert: ReactNode, covered?: boolean) => (
    <NotificationLayerContext.Provider value>
      {covered === undefined ? alert : <NotificationStackCardContext.Provider value={{ covered }}>{alert}</NotificationStackCardContext.Provider>}
    </NotificationLayerContext.Provider>
  )

  test('不在弹窗层里:不接玻璃,也没有玻璃样式类', () => {
    render(<AppAlert title="层外" testId="alert" />)
    expect(window.Hyalite.attach).not.toHaveBeenCalled()
    expect(screen.getByTestId('alert')).not.toHaveClass('app-alert--glass')
  })

  test('在弹窗层里:把根节点接到 hyalite,卸载时解除', () => {
    const { unmount } = render(inLayer(<AppAlert title="层内" testId="alert" />))
    const root = screen.getByTestId('alert')

    expect(window.Hyalite.attach).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.Hyalite.attach).mock.calls[0][0]).toBe(root)
    expect(root).toHaveClass('app-alert--glass')
    unmount()
    expect(window.Hyalite.detach).toHaveBeenCalledWith(root)
  })

  test('堆叠里最前面的卡接玻璃,被盖住的不接;盖住与否变化时跟着接上或解除', () => {
    const { rerender } = render(inLayer(<AppAlert title="卡片" testId="alert" />, true))
    expect(window.Hyalite.attach).not.toHaveBeenCalled()
    expect(screen.getByTestId('alert')).not.toHaveClass('app-alert--glass')

    rerender(inLayer(<AppAlert title="卡片" testId="alert" />, false))
    expect(window.Hyalite.attach).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('alert')).toHaveClass('app-alert--glass')

    rerender(inLayer(<AppAlert title="卡片" testId="alert" />, true))
    expect(window.Hyalite.detach).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('alert')).not.toHaveClass('app-alert--glass')
  })

  test('环境不支持 hyalite 时什么都不接,样式类仍在(回落到普通模糊)', () => {
    window.Hyalite.supported = vi.fn(() => false)
    render(inLayer(<AppAlert title="层内" testId="alert" />))

    expect(window.Hyalite.attach).not.toHaveBeenCalled()
    expect(screen.getByTestId('alert')).toHaveClass('app-alert--glass')
  })

  test('经 AppNotificationPortal 渲染到弹窗层的通知接玻璃', async () => {
    render(
      <>
        <div data-testid="app-notification-layer" />
        <AppNotificationPortal><AppAlert title="走门户" testId="alert" /></AppNotificationPortal>
      </>,
    )
    await waitFor(() => expect(screen.getByTestId('app-notification-layer')).toContainElement(screen.getByTestId('alert')))

    expect(window.Hyalite.attach).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('alert')).toHaveClass('app-alert--glass')
  })

  test('玻璃样式写在 AppAlert.css:折射模糊和亮边都回落到普通值', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/AppAlert.css'), 'utf8')
    const rule = css.match(/\.app-alert--glass\s*\{([^}]*)\}/s)![1]

    expect(rule).toMatch(/backdrop-filter:\s*var\(--hyalite,\s*var\(--glass-blur\)\)/)
    expect(rule).toMatch(/box-shadow:\s*var\(--hyalite-edge,\s*var\(--glass-highlight\)\),\s*var\(--glass-menu-shadow\)/)
  })
})
