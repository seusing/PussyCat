import { act, render, screen } from '@testing-library/react'
import { AppAlert } from './AppAlert'
import { AppNotificationStack } from './AppNotificationStack'

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

    expect(screen.getAllByRole('status')).toHaveLength(6)
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

test('通知超过应用底部可用空间时回调淘汰数量', () => {
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
        <AppNotificationStack onOverflow={onOverflow}>
          {[0, 1, 2].map((index) => <AppAlert key={index} title={`通知 ${index}`} />)}
        </AppNotificationStack>
      </div>,
    )
    act(() => window.dispatchEvent(new Event('resize')))
    expect(onOverflow).toHaveBeenCalledWith(1)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})
