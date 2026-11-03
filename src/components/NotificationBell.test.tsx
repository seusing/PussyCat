import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordNotifications, useNotificationHistory, type NotificationInput } from '../store/notificationHistory'
import { NotificationBell, ringPeak, ringVelocity } from './NotificationBell'

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
const velocityOf = (call: unknown[]) => (call[2] as { velocity: number }).velocity

// 窗口前后台:jsdom 的 document.hasFocus() 在没有聚焦元素时是 false,这里统一接管。
const windowState = { visibility: 'visible' as 'visible' | 'hidden', focused: true }
function enterBackground(how: 'hidden' | 'blurred' = 'hidden') {
  windowState.visibility = how === 'hidden' ? 'hidden' : 'visible'
  windowState.focused = how === 'hidden'
}
/** 回到前台,并像浏览器那样触发对应的事件。 */
function returnToForeground(events: Array<'visibilitychange' | 'focus'> = ['visibilitychange', 'focus']) {
  windowState.visibility = 'visible'
  windowState.focused = true
  act(() => {
    for (const event of events) {
      if (event === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'))
      else window.dispatchEvent(new Event('focus'))
    }
  })
}

beforeEach(() => {
  windowState.visibility = 'visible'
  windowState.focused = true
  vi.spyOn(Document.prototype, 'hasFocus').mockImplementation(() => windowState.focused)
  vi.spyOn(Document.prototype, 'visibilityState', 'get').mockImplementation(() => windowState.visibility)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  animateCalls.calls.length = 0
})

describe('ringPeak', () => {
  it.each([[1, 28], [2, 31], [3, 34], [4, 37], [5, 38], [20, 38]])('一次来 %i 条:首个峰值 %i 度', (added, peak) => {
    expect(ringPeak(added)).toBe(peak)
  })

  it('初速度单向向左(负),条数越多越大', () => {
    expect(ringVelocity(1)).toBeLessThan(0)
    expect(ringVelocity(2)).toBeLessThan(ringVelocity(1))
    expect(ringVelocity(5)).toBeLessThan(ringVelocity(4))
    expect(ringVelocity(9)).toBe(ringVelocity(5))
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

  it('样式:角标 #FF453A、白字、600 字重、等宽数字;按下缩到 .9', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/NotificationBell.css'), 'utf8')

    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*background:\s*#ff453a;/i)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*color:\s*#fff;/)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*font-weight:\s*600;/)
    expect(css).toMatch(/\.notification-bell__badge\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/)
    expect(css).toMatch(/\.notification-bell:not\(:disabled\):active\s*\{\s*scale:\s*0\.9;/)
  })
})

describe('摇铃(前台)', () => {
  it('启动时已持久化的未读不摇,即使窗口当时在后台、之后才回到前台', () => {
    recordNotifications([entry('a'), entry('b')])
    enterBackground()
    render(<NotificationBell />)
    returnToForeground()

    expect(bell()).toHaveAttribute('data-ring-count', '0')
    expect(animateCalls.calls).toHaveLength(0)
  })

  it('面板关着时未读数增加就立即摇一次;初速度按这次新增的条数算首个峰值', () => {
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
    expect(first[2]).toMatchObject({ type: 'spring', stiffness: 220, damping: 4.5 })
    expect(velocityOf(first)).toBeCloseTo(ringVelocity(1), 5)
    expect(velocityOf(second)).toBeCloseTo(ringVelocity(2), 5)
    expect(velocityOf(third)).toBeCloseTo(ringVelocity(6), 5)
    expect(velocityOf(third)).toBeCloseTo(ringVelocity(5), 5)   // 封顶
  })

  it('重复记同一条、未读数没增加:不摇', () => {
    render(<NotificationBell />)
    act(() => recordNotifications([entry('a')]))
    act(() => recordNotifications([entry('a')]))

    expect(bell()).toHaveAttribute('data-ring-count', '1')
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

describe('摇铃的幅度和时长(真实采样)', () => {
  // 摇铃期间每 8ms 读一次图标的 rotate,量出第一个方向、峰值和峰值时刻、超过 3 度/1.5 度的摆动持续多久。
  async function sampleRing(addedAtOnce: number) {
    render(<NotificationBell />)
    const icon = bell().querySelector<HTMLElement>('.notification-bell__icon')!
    const start = performance.now()
    act(() => recordNotifications(Array.from({ length: addedAtOnce }, (_, index) => entry(`s-${index}`))))
    const points: Array<{ t: number; angle: number }> = []
    while (performance.now() - start < 2000) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 8)) })
      const match = /rotate\((-?[\d.]+)deg\)/.exec(icon.style.transform)
      points.push({ t: performance.now() - start, angle: match ? Number(match[1]) : 0 })
    }
    const peak = points.reduce((best, point) => (Math.abs(point.angle) > Math.abs(best.angle) ? point : best), points[0])
    const lastAbove = (degrees: number) => [...points].reverse().find((point) => Math.abs(point.angle) > degrees)?.t ?? 0
    return {
      firstDirection: Math.sign(points.find((point) => Math.abs(point.angle) > 0.5)?.angle ?? 0),
      peak: Math.abs(peak.angle), peakAt: peak.t, over3: lastAbove(3), over15: lastAbove(1.5),
    }
  }

  it('一条通知:单向起摆,首个峰值约 28 度、约 0.1 秒到,明显摆动约 1.1 秒,1.5 秒内停稳', async () => {
    const result = await sampleRing(1)

    expect(result.firstDirection).toBe(-1)
    expect(result.peak).toBeGreaterThan(26.5)
    expect(result.peak).toBeLessThan(29.5)
    expect(result.peakAt).toBeLessThan(250)
    expect(result.over3).toBeGreaterThan(900)
    expect(result.over3).toBeLessThan(1500)
    expect(result.over15).toBeLessThan(1800)
  }, 10_000)

  it('一次来很多条:首个峰值约 38 度,仍然逐渐衰减', async () => {
    const result = await sampleRing(8)

    expect(result.firstDirection).toBe(-1)
    expect(result.peak).toBeGreaterThan(36.5)
    expect(result.peak).toBeLessThan(39.5)
    expect(result.over3).toBeGreaterThan(900)
    expect(result.over15).toBeLessThan(1900)
  }, 10_000)
})

describe('窗口在后台或失焦时补摇', () => {
  it.each([
    ['页面不可见', 'hidden' as const],
    ['窗口失焦', 'blurred' as const],
  ])('%s期间新增的未读不立即摇;回到前台时补摇一次,幅度按期间新增的条数', (_name, how) => {
    render(<NotificationBell />)
    enterBackground(how)

    act(() => recordNotifications([entry('a')]))
    act(() => recordNotifications([entry('b'), entry('c')]))
    expect(bell()).toHaveAttribute('data-ring-count', '0')
    expect(animateCalls.calls).toHaveLength(0)
    expect(badge()).toHaveTextContent(/^3$/)   // 角标照常更新

    returnToForeground()

    expect(bell()).toHaveAttribute('data-ring-count', '1')
    expect(animateCalls.calls).toHaveLength(1)
    expect(velocityOf(animateCalls.calls[0])).toBeCloseTo(ringVelocity(3), 5)
  })

  it('页面可见性变化和窗口 focus 都来了也只补摇一次;只收到其中一个事件同样补摇', () => {
    render(<NotificationBell />)
    enterBackground()
    act(() => recordNotifications([entry('a')]))
    returnToForeground(['visibilitychange', 'focus'])
    expect(bell()).toHaveAttribute('data-ring-count', '1')

    enterBackground('blurred')
    act(() => recordNotifications([entry('b')]))
    returnToForeground(['focus'])
    expect(bell()).toHaveAttribute('data-ring-count', '2')

    enterBackground()
    act(() => recordNotifications([entry('c')]))
    returnToForeground(['visibilitychange'])
    expect(bell()).toHaveAttribute('data-ring-count', '3')
  })

  it('事件来了但窗口还看不到(页面仍不可见,或可见却没焦点):继续等', () => {
    render(<NotificationBell />)
    enterBackground('hidden')
    act(() => recordNotifications([entry('a')]))

    act(() => { window.dispatchEvent(new Event('focus')) })   // 仍然 hidden
    expect(bell()).toHaveAttribute('data-ring-count', '0')
    windowState.visibility = 'visible'
    windowState.focused = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })   // 可见了但没焦点
    expect(bell()).toHaveAttribute('data-ring-count', '0')

    returnToForeground(['focus'])
    expect(bell()).toHaveAttribute('data-ring-count', '1')
  })

  it('后台没有新增时回到前台不摇,补过一次后再回前台也不会重复摇', () => {
    render(<NotificationBell />)
    enterBackground()
    returnToForeground()
    expect(bell()).toHaveAttribute('data-ring-count', '0')

    enterBackground()
    act(() => recordNotifications([entry('a')]))
    returnToForeground()
    returnToForeground()
    expect(bell()).toHaveAttribute('data-ring-count', '1')
  })

  it('后台期间未读已被清掉:回到前台不补摇', () => {
    render(<NotificationBell />)
    enterBackground()
    act(() => recordNotifications([entry('a')]))
    act(() => useNotificationHistory.getState().markAllRead())

    returnToForeground()

    expect(bell()).toHaveAttribute('data-ring-count', '0')
    expect(animateCalls.calls).toHaveLength(0)
  })

  it('后台期间面板被打开(标成已读)再回到前台:不补摇', async () => {
    const user = userEvent.setup()
    render(<NotificationBell />)
    enterBackground()
    act(() => recordNotifications([entry('a')]))
    await user.click(bell())
    await screen.findByRole('dialog', { name: '通知' })
    await waitFor(() => expect(unreadCount()).toBe(0))

    returnToForeground()

    expect(bell()).toHaveAttribute('data-ring-count', '0')
  })

  it('回到前台时面板正开着:不补摇', async () => {
    const user = userEvent.setup()
    render(<NotificationBell />)
    enterBackground()
    act(() => recordNotifications([entry('a')]))
    windowState.visibility = 'visible'
    windowState.focused = true
    await user.click(bell())
    await screen.findByRole('dialog', { name: '通知' })

    returnToForeground()

    expect(bell()).toHaveAttribute('data-ring-count', '0')
  })

  it('窗口只是刚好失焦又回来,期间攒下的和回来后新到的合成一次摇', () => {
    render(<NotificationBell />)
    enterBackground('blurred')
    act(() => recordNotifications([entry('a')]))
    windowState.focused = true   // 没来得及收到 focus 事件,下一条通知先到了
    act(() => recordNotifications([entry('b')]))

    expect(bell()).toHaveAttribute('data-ring-count', '1')
    expect(velocityOf(animateCalls.calls[0])).toBeCloseTo(ringVelocity(2), 5)
    returnToForeground()
    expect(bell()).toHaveAttribute('data-ring-count', '1')
  })

  it('卸载后不再响应前后台切换', () => {
    const { unmount } = render(<NotificationBell />)
    enterBackground()
    act(() => recordNotifications([entry('a')]))
    unmount()

    expect(() => returnToForeground()).not.toThrow()
    expect(animateCalls.calls).toHaveLength(0)
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
