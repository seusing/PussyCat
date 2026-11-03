import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordNotifications, useNotificationHistory, type NotificationInput } from '../store/notificationHistory'
import { NotificationBell, ringPeak } from './NotificationBell'

// 摇铃走 motion 的 animate;包一层记下每次的参数,原样放行。
const animateCalls = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return {
    ...actual,
    animate: (...args: unknown[]) => {
      animateCalls.calls.push(args)
      return (actual.animate as (...params: unknown[]) => unknown)(...args)
    },
  }
})

const entry = (id: string, over: Partial<NotificationInput> = {}): NotificationInput => ({
  id, message: `任务 ${id} 已完成`, tone: 'success', createdAt: Date.now(), ...over,
})
const bell = () => screen.getByTestId('notification-bell')
const badge = () => screen.queryByTestId('notification-badge')
const unreadCount = () => useNotificationHistory.getState().entries.filter((item) => !item.read).length
const panelGone = () => waitFor(() => expect(screen.queryByRole('dialog', { name: '通知' })).not.toBeInTheDocument())

afterEach(() => {
  cleanup()
  animateCalls.calls.length = 0
})

describe('ringPeak', () => {
  it.each([[1, 18], [2, 22], [3, 26], [4, 30], [5, 30], [20, 30]])('一次来 %i 条:摆幅 %i 度', (added, peak) => {
    expect(ringPeak(added)).toBe(peak)
  })
})

describe('铃铛与角标', () => {
  it('没有未读:标签是「通知」,不显示角标,带弹层语义', () => {
    render(<NotificationBell />)

    expect(bell()).toHaveAccessibleName('通知')
    expect(bell()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(bell()).toHaveAttribute('aria-expanded', 'false')
    expect(bell()).toHaveClass('app-icon-button', 'notification-bell')
    expect(badge()).not.toBeInTheDocument()
  })

  it('有未读:右上角显示数字,标签带上未读数', () => {
    recordNotifications([entry('a'), entry('b'), entry('c')])
    render(<NotificationBell />)

    expect(badge()).toHaveTextContent(/^3$/)
    expect(bell()).toHaveAccessibleName('通知，3 条未读')
  })

  it('未读数超过 99 显示「99+」', () => {
    useNotificationHistory.setState({
      entries: Array.from({ length: 120 }, (_, index) => ({ ...entry(`n-${index}`), read: false })),
    })
    render(<NotificationBell />)

    expect(badge()).toHaveTextContent(/^99\+$/)
    expect(bell()).toHaveAccessibleName('通知，120 条未读')
    act(() => useNotificationHistory.setState({ entries: useNotificationHistory.getState().entries.slice(0, 99) }))
    expect(badge()).toHaveTextContent(/^99$/)
  })

  it('样式:角标 #FF453A、白字、600 字重、等宽数字;按下缩到 .9', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(process.cwd(), 'src/components/NotificationBell.css'), 'utf8')

    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*background:\s*#ff453a;/i)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*color:\s*#fff;/)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*font-weight:\s*600;/)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/)
    expect(css).toMatch(/\.notification-bell:not\(:disabled\):active\s*\{\s*scale:\s*0\.9;/)
  })
})

describe('摇铃', () => {
  it('启动时已持久化的未读不摇', () => {
    recordNotifications([entry('a'), entry('b')])
    render(<NotificationBell />)

    expect(bell()).toHaveAttribute('data-ring-count', '0')
    expect(animateCalls.calls).toHaveLength(0)
  })

  it('面板关着时未读数增加就摇一次;初速度按这次新增的条数算摆幅', () => {
    render(<NotificationBell />)

    act(() => recordNotifications([entry('a')]))
    expect(bell()).toHaveAttribute('data-ring-count', '1')
    act(() => recordNotifications([entry('b'), entry('c')]))
    expect(bell()).toHaveAttribute('data-ring-count', '2')
    act(() => recordNotifications([entry('d'), entry('e'), entry('f'), entry('g'), entry('h'), entry('i')]))
    expect(bell()).toHaveAttribute('data-ring-count', '3')

    const [first, second, third] = animateCalls.calls
    const icon = bell().querySelector('.notification-bell__icon')
    expect(first[0]).toBe(icon)
    expect(first[1]).toEqual({ rotate: 0 })
    expect(first[2]).toMatchObject({ type: 'spring', stiffness: 220, damping: 10 })
    expect((first[2] as { velocity: number }).velocity).toBeCloseTo(-18 / 0.0435, 5)
    expect((second[2] as { velocity: number }).velocity).toBeCloseTo(-22 / 0.0435, 5)
    expect((third[2] as { velocity: number }).velocity).toBeCloseTo(-30 / 0.0435, 5)
  })

  it('重复记同一条、未读数没增加:不摇', () => {
    render(<NotificationBell />)
    act(() => recordNotifications([entry('a')]))
    act(() => recordNotifications([entry('a')]))

    expect(bell()).toHaveAttribute('data-ring-count', '1')
  })

  it('铃铛真的在转:摇铃期间图标带 rotate 变换', async () => {
    render(<NotificationBell />)
    act(() => recordNotifications([entry('a')]))

    const icon = bell().querySelector<HTMLElement>('.notification-bell__icon')!
    await waitFor(() => expect(icon.style.transform).toMatch(/rotate\((?!0deg)/))
  })

  it('面板开着时来新通知:不摇,也不留未读', async () => {
    const user = userEvent.setup()
    render(<NotificationBell />)
    await user.click(bell())
    await screen.findByRole('dialog', { name: '通知' })

    act(() => recordNotifications([entry('a')]))

    expect(bell()).toHaveAttribute('data-ring-count', '0')
    await waitFor(() => expect(unreadCount()).toBe(0))
    expect(badge()).not.toBeInTheDocument()
  })

  it('卸载时停掉还在摇的动画', () => {
    const { unmount } = render(<NotificationBell />)
    act(() => recordNotifications([entry('a')]))

    expect(() => unmount()).not.toThrow()
  })
})

describe('点开历史面板', () => {
  it('打开即全部标为已读,角标消失;再点一次收起并回到原样', async () => {
    const user = userEvent.setup()
    recordNotifications([entry('a'), entry('b')])
    render(<NotificationBell />)
    expect(badge()).toHaveTextContent(/^2$/)

    await user.click(bell())
    const dialog = await screen.findByRole('dialog', { name: '通知' })

    expect(bell()).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).getAllByTestId('notification-history-item')).toHaveLength(2)
    await waitFor(() => expect(badge()).not.toBeInTheDocument())
    expect(bell()).toHaveAccessibleName('通知')
    expect(unreadCount()).toBe(0)

    await user.click(bell())
    expect(bell()).toHaveAttribute('aria-expanded', 'false')
    await panelGone()
  })

  it('Esc 关闭、焦点回到铃铛,且不冒泡到全局 Esc', async () => {
    const user = userEvent.setup()
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    render(<NotificationBell />)
    await user.click(bell())
    await screen.findByRole('dialog', { name: '通知' })

    await user.keyboard('{Escape}')

    expect(windowKeyDown).not.toHaveBeenCalled()
    await panelGone()
    expect(bell()).toHaveFocus()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('点外部关闭:点空白处焦点回到铃铛', async () => {
    const user = userEvent.setup()
    render(<NotificationBell />)
    await user.click(bell())
    await screen.findByRole('dialog', { name: '通知' })

    await user.click(document.body)

    await panelGone()
    await waitFor(() => expect(bell()).toHaveFocus())
  })
})
