import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAlert } from './AppAlert'

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
