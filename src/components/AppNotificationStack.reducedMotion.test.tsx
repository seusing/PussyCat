import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAlert } from './AppAlert'
import { AppNotificationStack } from './AppNotificationStack'

// motion 的偏好只在首次读取时缓存,所以单独成文件并直接替身 useReducedMotion。
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}))

test('缩减动效下收起、展开、降回 1 条都正常工作', async () => {
  const user = userEvent.setup()
  const alerts = (count: number) => Array.from({ length: count }, (_, index) => <AppAlert key={index} title={`通知 ${index}`} />)
  const { rerender } = render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)

  expect(screen.getByRole('button', { name: '全部 3 条' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('通知 1').closest('.app-notification-stack__card')).toHaveAttribute('aria-hidden', 'true')

  await user.click(screen.getByRole('button', { name: '全部 3 条' }))
  expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByRole('status')).toHaveLength(3)

  rerender(<AppNotificationStack>{alerts(1)}</AppNotificationStack>)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
