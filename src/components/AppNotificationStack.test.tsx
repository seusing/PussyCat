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
