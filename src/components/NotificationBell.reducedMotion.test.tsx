import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { recordNotifications, useNotificationHistory } from '../store/notificationHistory'
import { NotificationBell } from './NotificationBell'

// motion 的偏好只在首次读取时缓存,所以单独成文件并直接替身 useReducedMotion;animate 包一层记调用。
const animateCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return {
    ...actual,
    useReducedMotion: () => true,
    animate: (...args: unknown[]) => {
      animateCalls.count += 1
      return (actual.animate as (...params: unknown[]) => unknown)(...args)
    },
  }
})

const entry = (id: string) => ({ id, message: `任务 ${id} 已完成`, tone: 'success' as const, createdAt: Date.now() })
const bell = () => screen.getByTestId('notification-bell')

afterEach(() => {
  cleanup()
  animateCalls.count = 0
})

it('缩减动效下未读数增加不摇铃,角标只淡入、不缩放弹入', () => {
  render(<NotificationBell />)

  act(() => recordNotifications([entry('a')]))

  expect(animateCalls.count).toBe(0)
  expect(bell()).toHaveAttribute('data-ring-count', '0')
  const badge = screen.getByTestId('notification-badge')
  expect(badge).toHaveTextContent(/^1$/)
  expect(badge.style.transform).toBe('')
  expect(bell().querySelector<HTMLElement>('.notification-bell__icon')!.style.transform).toBe('')
})

it('缩减动效下面板照常打开、标已读、Esc 关闭并还回焦点', async () => {
  const user = userEvent.setup()
  recordNotifications([entry('a'), entry('b')])
  render(<NotificationBell />)

  await user.click(bell())
  const dialog = await screen.findByRole('dialog', { name: '通知' })
  expect(dialog).toBeInTheDocument()
  await waitFor(() => expect(useNotificationHistory.getState().entries.every((item) => item.read)).toBe(true))

  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '通知' })).not.toBeInTheDocument())
  expect(bell()).toHaveFocus()
})
