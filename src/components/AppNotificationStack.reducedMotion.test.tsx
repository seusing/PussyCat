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

test('缩减动效下切换按钮的文字直接替换、不做滑动,箭头只淡入淡出式地换朝向,toggleLabel 照常生效', async () => {
  const user = userEvent.setup()
  render(
    <AppNotificationStack toggleLabel={(count) => `查看所有 ${count} 条`}>
      {Array.from({ length: 3 }, (_, index) => <AppAlert key={index} title={`通知 ${index}`} />)}
    </AppNotificationStack>,
  )
  const toggle = screen.getByRole('button', { name: '查看所有 3 条' })
  expect(toggle.querySelectorAll('.app-notification-stack__toggle-text')).toHaveLength(1)

  await user.click(toggle)
  expect(toggle.getAttribute('aria-label')).toBe('收起')
  // 没有滑动就没有"旧文字退场"的那一拍:按钮里始终只有一份文字
  expect(toggle.querySelectorAll('.app-notification-stack__toggle-text')).toHaveLength(1)
  expect(toggle.querySelector('.app-notification-stack__toggle-text')).toHaveTextContent('收起')
  expect(toggle.querySelector('.app-notification-stack__chevron')).toHaveAttribute('data-expanded', 'true')
})

test('缩减动效下进入的卡片不带位移(initial 关闭),被盖住的卡片仍然隐藏', () => {
  render(<AppNotificationStack>{Array.from({ length: 3 }, (_, index) => <AppAlert key={index} title={`通知 ${index}`} />)}</AppNotificationStack>)

  for (const title of ['通知 0', '通知 1', '通知 2']) {
    const card = screen.getByText(title).closest<HTMLElement>('.app-notification-stack__card')!
    expect(card.style.opacity).toBe('')
  }
  expect(screen.getByText('通知 2').closest('.app-notification-stack__card')).toHaveAttribute('inert')
})
