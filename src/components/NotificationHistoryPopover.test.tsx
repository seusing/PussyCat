import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimatePresence } from 'motion/react'
import { recordNotifications, selectUnreadCount, useNotificationHistory, type NotificationInput } from '../store/notificationHistory'
import { formatNotificationTime, NotificationHistoryPopover } from './NotificationHistoryPopover'

function Harness() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>铃铛</button>
      <button type="button">别处</button>
      <AnimatePresence>
        {anchor && <NotificationHistoryPopover key="history" anchor={anchor} onClose={() => setAnchor(null)} />}
      </AnimatePresence>
    </>
  )
}

const entry = (id: string, over: Partial<NotificationInput> = {}): NotificationInput => ({
  id, message: `任务 ${id}`, tone: 'success', createdAt: Date.now(), ...over,
})
const entries = () => useNotificationHistory.getState().entries
const items = () => screen.getAllByTestId('notification-history-item')
const closed = () => waitFor(() => expect(screen.queryByRole('dialog', { name: '通知' })).not.toBeInTheDocument())

async function openPopover() {
  const user = userEvent.setup()
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: '铃铛' })
  await user.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: '通知' })
  return { user, trigger, dialog }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('formatNotificationTime', () => {
  const NOW = new Date(2026, 9, 30, 15, 20, 0).getTime()
  it.each([
    ['刚发生', NOW - 5_000, '刚刚'],
    ['不足一分钟', NOW - 59_000, '刚刚'],
    ['时钟略偏快(未来几秒)', NOW + 3_000, '刚刚'],
    ['一分钟整', NOW - 60_000, '1 分钟前'],
    ['59 分钟', NOW - 59 * 60_000, '59 分钟前'],
    ['一小时前、同一天', new Date(2026, 9, 30, 14, 5).getTime(), '14:05'],
    ['当天凌晨', new Date(2026, 9, 30, 0, 7).getTime(), '00:07'],
    ['昨天', new Date(2026, 9, 29, 23, 59).getTime(), '10月29日 23:59'],
    ['去年', new Date(2025, 0, 3, 9, 8).getTime(), '1月3日 09:08'],
  ])('%s', (_name, createdAt, expected) => {
    expect(formatNotificationTime(createdAt, NOW)).toBe(expected)
  })
})

describe('NotificationHistoryPopover', () => {
  it('滚动时宽度固定,不会随每次重算越缩越窄', async () => {
    // jsdom 的 scrollWidth 恒为 0;按真实面板模拟:border-box + 1px 边框时 scrollWidth 比内联宽度少 2px
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      const inline = parseFloat(this.style.width)
      return Number.isFinite(inline) ? inline - 2 : 380
    })
    recordNotifications(Array.from({ length: 8 }, (_, i) => entry(`w${i}`)))
    const { dialog } = await openPopover()
    await waitFor(() => expect(dialog.style.width).toBe('380px'))
    for (let i = 0; i < 20; i++) {
      act(() => { window.dispatchEvent(new Event('scroll')) })
      act(() => { items()[0].dispatchEvent(new Event('scroll', { bubbles: true })) })
    }
    expect(dialog.style.width).toBe('380px')
  })

  it('以名为「通知」的 dialog 渲染到 body 下,不再套用玻璃菜单的 Hyalite 材质类', async () => {
    const { dialog } = await openPopover()

    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveClass('notification-popover')
    expect(dialog).not.toHaveClass('glass-menu-effect')
  })

  it('样式:定位、尺寸和滚动区;材质是普通毛玻璃,不依赖 --hyalite', () => {
    const raw = readFileSync(resolve(process.cwd(), 'src/components/NotificationHistoryPopover.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const surface = css.match(/\.notification-popover\s*\{([^}]*)\}/)![1]

    expect(surface).toMatch(/position:\s*fixed;/)
    expect(surface).toMatch(/z-index:\s*70;/)
    expect(surface).toMatch(/width:\s*min\(380px,\s*calc\(100vw - 16px\)\);/)
    expect(surface).toMatch(/border:\s*1px solid var\(--glass-edge\);/)
    expect(surface).toMatch(/border-radius:\s*12px;/)
    expect(surface).toMatch(/background:\s*var\(--glass-menu-fill\);/)
    expect(surface).toMatch(/box-shadow:\s*var\(--glass-highlight\),\s*var\(--glass-menu-shadow\);/)
    expect(surface).toMatch(/(?<!-webkit-)backdrop-filter:\s*var\(--glass-blur\);/)
    expect(css).not.toMatch(/hyalite/i)
    expect(css).not.toMatch(/glass-menu-effect/)
    expect(css).toMatch(/\.notification-popover__body\s*\{[^}]*max-height:\s*min\(440px,\s*calc\(100vh - 120px\)\);[^}]*overflow-y:\s*auto;/s)
    // 注释里写明了为什么不用液态玻璃
    expect(raw).toMatch(/Hyalite[\s\S]*每帧[\s\S]*重算/)
  })

  it('面板里的卡片不做 backdrop-filter,只用半透明底色(作用域限定在历史面板内)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/NotificationHistoryPopover.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const cards = css.match(/\.notification-popover \.app-alert\s*\{([^}]*)\}/)![1]

    expect(cards).toMatch(/(?<!-webkit-)backdrop-filter:\s*none;/)
    expect(cards).toMatch(/-webkit-backdrop-filter:\s*none;/)
    expect(cards).toMatch(/background:\s*rgb\([^)]*\/\s*\d+%\);/)
    // 没有把全局的 .app-alert 改掉:弹窗里的卡片仍然是液态玻璃
    expect(css).not.toMatch(/^\.app-alert\s*\{/m)
  })

  it('没有通知:显示空状态,清空按钮不可用', async () => {
    const { dialog } = await openPopover()

    expect(within(dialog).getByRole('heading', { name: '通知' })).toBeInTheDocument()
    expect(within(dialog).getByTestId('notification-empty')).toHaveTextContent('暂无通知')
    expect(within(dialog).getByTestId('notification-empty')).toHaveTextContent('任务提交、完成、中断或出错时会记在这里')
    expect(within(dialog).getByRole('button', { name: '清空' })).toBeDisabled()
    expect(screen.queryByTestId('notification-history-item')).not.toBeInTheDocument()
  })

  it('最新在前;说明是「原因 · 时间」,没有原因就只有时间;danger 色调映射到错误卡', async () => {
    recordNotifications([
      entry('c', { message: '任务12遇到了些问题', description: '需要登录小红书才能读取这条笔记', tone: 'danger', createdAt: Date.now() - 5 * 60_000 }),
      entry('b', { message: '任务12已提交', tone: 'info', createdAt: Date.now() - 2 * 3_600_000 }),
      entry('a', { message: '任务11已完成', tone: 'success', createdAt: Date.now() - 30_000 }),
    ])
    await openPopover()

    expect(items().map((item) => item.querySelector('.app-alert__title')?.textContent)).toEqual(['任务12遇到了些问题', '任务12已提交', '任务11已完成'])
    expect(items()[0]).toHaveAttribute('data-tone', 'danger')
    expect(items()[0].querySelector('.app-alert__description')).toHaveTextContent('需要登录小红书才能读取这条笔记 · 5 分钟前')
    expect(items()[1].querySelector('.app-alert__description')?.textContent).toMatch(/^\d{2}:\d{2}$|^\d+月\d+日 \d{2}:\d{2}$/)
    expect(items()[2].querySelector('.app-alert__description')).toHaveTextContent(/^刚刚$/)
  })

  it('面板和卡片都不调用 Hyalite.attach,卡片也不会被读屏当成实时通知', async () => {
    const attach = vi.fn()
    const original = { supported: window.Hyalite.supported, attach: window.Hyalite.attach }
    window.Hyalite.supported = vi.fn(() => true)
    window.Hyalite.attach = attach
    try {
      recordNotifications([entry('a'), entry('b')])
      const { user } = await openPopover()
      await user.click(screen.getByRole('button', { name: '查看所有 2 条' }))   // 展开也不接

      expect(attach).not.toHaveBeenCalled()
      for (const item of items()) {
        expect(item).not.toHaveClass('app-alert--glass')
        expect(item).not.toHaveAttribute('aria-live', 'polite')
        expect(item).toHaveAttribute('role', 'presentation')
      }
    } finally {
      Object.assign(window.Hyalite, original)
    }
  })

  it('一条通知时没有切换按钮;两条起收起成堆叠,按钮写「查看所有 N 条」,展开后写「收起」', async () => {
    recordNotifications([entry('a')])
    const first = await openPopover()
    expect(screen.queryByRole('button', { name: /查看所有/ })).not.toBeInTheDocument()
    first.user.keyboard('{Escape}')
    await closed()
    cleanup()

    recordNotifications([entry('b'), entry('c')])
    const { user } = await openPopover()
    const toggle = screen.getByRole('button', { name: '查看所有 3 条' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(items()[1].closest('.app-notification-stack__card')).toHaveAttribute('aria-hidden', 'true')

    await user.click(toggle)
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    expect(items()[1].closest('.app-notification-stack__card')).not.toHaveAttribute('aria-hidden')

    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByRole('button', { name: '查看所有 3 条' })).toBeInTheDocument()
  })

  it('打开时全部标为已读,开着时又来新通知也立刻标成已读', async () => {
    recordNotifications([entry('a'), entry('b')])
    await openPopover()
    await waitFor(() => expect(selectUnreadCount(useNotificationHistory.getState())).toBe(0))

    act(() => recordNotifications([entry('c')]))

    await waitFor(() => expect(selectUnreadCount(useNotificationHistory.getState())).toBe(0))
    expect(items()).toHaveLength(3)
  })

  it('清空:历史清掉、面板不关、改显示空状态且清空按钮变灰', async () => {
    recordNotifications([entry('a'), entry('b')])
    const { user, dialog } = await openPopover()

    await user.click(within(dialog).getByRole('button', { name: '清空' }))

    expect(entries()).toEqual([])
    expect(screen.getByRole('dialog', { name: '通知' })).toBeInTheDocument()
    expect(screen.getByTestId('notification-empty')).toHaveTextContent('暂无通知')
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled()
    expect(screen.queryByTestId('notification-history-item')).not.toBeInTheDocument()
  })

  it('右边对齐铃铛:left = 铃铛右边 - 面板宽,并夹在视口边距内', async () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    try {
      const user = userEvent.setup()
      render(<Harness />)
      const trigger = screen.getByRole('button', { name: '铃铛' })
      trigger.getBoundingClientRect = () => ({
        top: 14, bottom: 48, left: 1190, right: 1224, width: 34, height: 34, x: 1190, y: 14, toJSON: () => ({}),
      })
      await user.click(trigger)
      const dialog = await screen.findByRole('dialog', { name: '通知' })

      // 宽度与 CSS 一致取 380px,不读 jsdom 里为 0 的布局宽度
      expect(dialog.style.width).toBe('380px')
      expect(dialog.style.left).toBe(`${1224 - 380}px`)
      expect(dialog.style.top).toBe('54px')   // 铃铛底边 + 6px
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original })
    }
  })

  it('铃铛贴着视口左边时不超出边距', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '铃铛' })
    trigger.getBoundingClientRect = () => ({
      top: 14, bottom: 48, left: 0, right: 34, width: 34, height: 34, x: 0, y: 14, toJSON: () => ({}),
    })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '通知' })

    expect(dialog.style.left).toBe('8px')
  })

  it('打开后焦点落在面板上;Esc 关闭、焦点回到触发按钮,且不冒泡到全局 Esc', async () => {
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    const { user, trigger, dialog } = await openPopover()
    await waitFor(() => expect(dialog).toHaveFocus())

    await user.keyboard('{Escape}')

    expect(windowKeyDown).not.toHaveBeenCalled()
    await closed()
    expect(trigger).toHaveFocus()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('点外部关闭:空白处焦点回到触发按钮,点别的按钮则让它保留焦点;点面板里不关', async () => {
    const { user, trigger, dialog } = await openPopover()
    await user.click(dialog)
    expect(screen.getByRole('dialog', { name: '通知' })).toBeInTheDocument()

    await user.click(document.body)
    await closed()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await screen.findByRole('dialog', { name: '通知' })
    const other = screen.getByRole('button', { name: '别处' })
    await user.click(other)
    await closed()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(other).toHaveFocus()
  })
})
