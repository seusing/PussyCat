import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAlert } from './AppAlert'
import { AppNotificationStack } from './AppNotificationStack'

const alerts = (count: number) => Array.from({ length: count }, (_, index) => <AppAlert key={index} title={`通知 ${index}`} />)
const cardOf = (title: string) => screen.getByText(title).closest<HTMLElement>('.app-notification-stack__card')!

test('新增前景卡保留所有旧节点及其独立倒计时', () => {
  vi.useFakeTimers()
  try {
    const onFirstExpire = vi.fn()
    const onNewExpire = vi.fn()
    const first = <AppAlert key="first" title="最初通知" durationMs={2000} onExpire={onFirstExpire} />
    const { rerender, unmount } = render(<AppNotificationStack>{[first]}</AppNotificationStack>)
    const firstNode = screen.getByText('最初通知')
    act(() => vi.advanceTimersByTime(1000))

    rerender(<AppNotificationStack>{[
      ...Array.from({ length: 5 }, (_, index) => (
        <AppAlert key={`new-${index}`} title={`新通知 ${index}`} durationMs={2000} onExpire={onNewExpire} />
      )),
      first,
    ]}</AppNotificationStack>)

    // 默认收起:被盖住的卡仍然挂载,只是对读屏隐藏,所以按 hidden 计数
    expect(screen.getAllByRole('status', { hidden: true })).toHaveLength(6)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByText('最初通知')).toBe(firstNode)
    expect(firstNode.closest('[data-front]')).toHaveAttribute('data-front', 'false')
    expect(screen.getByText('新通知 0').closest('[data-front]')).toHaveAttribute('data-front', 'true')
    act(() => vi.advanceTimersByTime(1000))
    expect(onFirstExpire).toHaveBeenCalledTimes(1)
    expect(onNewExpire).not.toHaveBeenCalled()
    unmount()
  } finally {
    vi.useRealTimers()
  }
})

test('通知超过应用底部可用空间时回调淘汰数量', async () => {
  const onOverflow = vi.fn()
  const rect = (height: number, bottom = height) => ({
    top: 0,
    right: 0,
    bottom,
    left: 0,
    width: 0,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('app-main')) return rect(120, 120) as DOMRect
    if (this.classList.contains('app-notification-stack')) return rect(0, 0) as DOMRect
    if (this.classList.contains('app-notification-stack__card')) return rect(50, 50) as DOMRect
    return rect(0, 0) as DOMRect
  }
  try {
    render(
      <div className="app-main">
        <AppNotificationStack onOverflow={onOverflow}>{alerts(3)}</AppNotificationStack>
      </div>,
    )
    act(() => window.dispatchEvent(new Event('resize')))
    expect(onOverflow).not.toHaveBeenCalled()   // 收起时只占一张卡的高度

    await userEvent.click(screen.getByRole('button', { name: '全部 3 条' }))
    act(() => window.dispatchEvent(new Event('resize')))
    expect(onOverflow).toHaveBeenCalledWith(1)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})

test('只有 1 条时和原来一样:没有按钮,也没有任何卡被隐藏', () => {
  render(<AppNotificationStack>{alerts(1)}</AppNotificationStack>)

  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(cardOf('通知 0')).toHaveAttribute('data-covered', 'false')
  expect(cardOf('通知 0')).not.toHaveAttribute('aria-hidden')
  expect(cardOf('通知 0')).not.toHaveAttribute('inert')
})

test('3 条默认收起:胶囊写「全部 3 条」,只有第 1 张可交互', () => {
  render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)

  const toggle = screen.getByRole('button', { name: '全部 3 条' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(cardOf('通知 0')).not.toHaveAttribute('aria-hidden')
  expect(cardOf('通知 0')).not.toHaveAttribute('inert')
  expect(cardOf('通知 0')).toHaveAttribute('data-layer', '0')
  for (const [title, layer] of [['通知 1', '1'], ['通知 2', '2']]) {
    expect(cardOf(title)).toHaveAttribute('aria-hidden', 'true')
    expect(cardOf(title)).toHaveAttribute('inert')
    expect(cardOf(title)).toHaveAttribute('data-layer', layer)
  }
  // 被盖住的卡里的按钮读屏和键盘都够不到,只剩第 1 张的关闭钮和胶囊
  expect(screen.queryAllByRole('button')).toEqual([toggle])
})

test('第 3 张起不再多露一层卡边,仍然挂载且同样隐藏', () => {
  render(<AppNotificationStack>{alerts(5)}</AppNotificationStack>)

  expect(screen.getByRole('button', { name: '全部 5 条' })).toBeInTheDocument()
  for (const title of ['通知 3', '通知 4']) {
    expect(cardOf(title)).toHaveAttribute('data-layer', '2')
    expect(cardOf(title)).toHaveAttribute('aria-hidden', 'true')
    expect(cardOf(title)).toHaveAttribute('inert')
  }
})

test('点胶囊展开:全部可见、按钮变「收起」,再点回到收起', async () => {
  const user = userEvent.setup()
  render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)

  await user.click(screen.getByRole('button', { name: '全部 3 条' }))
  const toggle = screen.getByRole('button', { name: '收起' })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole('button', { name: '全部 3 条' })).not.toBeInTheDocument()
  for (const title of ['通知 0', '通知 1', '通知 2']) {
    expect(cardOf(title)).not.toHaveAttribute('aria-hidden')
    expect(cardOf(title)).not.toHaveAttribute('inert')
    expect(cardOf(title)).toHaveAttribute('data-layer', '0')
  }
  expect(screen.getAllByRole('status')).toHaveLength(3)

  await user.click(toggle)
  expect(screen.getByRole('button', { name: '全部 3 条' })).toHaveAttribute('aria-expanded', 'false')
  expect(cardOf('通知 2')).toHaveAttribute('aria-hidden', 'true')
})

test('展开后条数降到 1 条:按钮消失并重新收起,下次有 2 条时仍默认收起', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)
  await user.click(screen.getByRole('button', { name: '全部 3 条' }))
  expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()

  rerender(<AppNotificationStack>{alerts(1)}</AppNotificationStack>)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(cardOf('通知 0')).not.toHaveAttribute('aria-hidden')

  rerender(<AppNotificationStack>{alerts(2)}</AppNotificationStack>)
  expect(screen.getByRole('button', { name: '全部 2 条' })).toHaveAttribute('aria-expanded', 'false')
  expect(cardOf('通知 1')).toHaveAttribute('aria-hidden', 'true')
})

test('收起状态下被盖住的卡仍按各自的倒计时过期', () => {
  vi.useFakeTimers()
  try {
    const onExpire = vi.fn()
    render(<AppNotificationStack>{[
      <AppAlert key="a" title="前景" />,
      <AppAlert key="b" title="被盖住" durationMs={1500} onExpire={onExpire} />,
    ]}</AppNotificationStack>)

    expect(cardOf('被盖住')).toHaveAttribute('aria-hidden', 'true')
    act(() => vi.advanceTimersByTime(1500))
    expect(onExpire).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
