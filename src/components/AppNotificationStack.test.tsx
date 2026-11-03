import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useContext } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAlert } from './AppAlert'
import { AppNotificationStack } from './AppNotificationStack'
import { NotificationStackCardContext } from './notificationContext'

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

describe('toggleLabel 与切换按钮', () => {
  test('默认文字「全部 N 条」,可用 toggleLabel 换成别的;展开后统一是「收起」', async () => {
    const user = userEvent.setup()
    render(<AppNotificationStack toggleLabel={(count) => `查看所有 ${count} 条`}>{alerts(4)}</AppNotificationStack>)

    const toggle = screen.getByRole('button', { name: '查看所有 4 条' })
    expect(screen.queryByRole('button', { name: '全部 4 条' })).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByRole('button', { name: '查看所有 4 条' })).toBeInTheDocument()
  })

  test('aria-label 始终等于当前文字,按钮里只有一个箭头,展开时旋转', async () => {
    const user = userEvent.setup()
    render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)
    const toggle = screen.getByRole('button', { name: '全部 3 条' })

    expect(toggle.getAttribute('aria-label')).toBe('全部 3 条')
    expect(toggle.querySelectorAll('svg')).toHaveLength(1)
    expect(toggle.querySelector('.app-notification-stack__chevron')).toHaveAttribute('data-expanded', 'false')

    await user.click(toggle)
    expect(toggle.getAttribute('aria-label')).toBe('收起')
    expect(toggle.querySelectorAll('svg')).toHaveLength(1)
    expect(toggle.querySelector('.app-notification-stack__chevron')).toHaveAttribute('data-expanded', 'true')
  })
})

describe('不做半透明、滤镜和裁剪', () => {
  const layersOf = (container: HTMLElement) => [
    container.querySelector('.app-notification-stack'),
    container.querySelector('.app-notification-stack__cards'),
    ...container.querySelectorAll('.app-notification-stack__card'),
    container.querySelector('.app-notification-stack__toggle-row'),
  ] as HTMLElement[]

  test.each([['收起', false], ['展开', true]])('%s时堆叠的外层没有 opacity、filter、clip-path 的行内样式', async (_name, expand) => {
    const user = userEvent.setup()
    const { container } = render(<AppNotificationStack>{alerts(4)}</AppNotificationStack>)
    if (expand) await user.click(screen.getByRole('button', { name: '全部 4 条' }))

    for (const layer of layersOf(container)) {
      expect(layer.style.opacity).toBe('')
      expect(layer.style.filter).toBe('')
      expect(layer.style.clipPath).toBe('')
    }
  })

  test('样式表里堆叠外层没有 opacity / filter / clip-path;被盖住的卡片是纯色底、没有模糊,只淡化里面的内容', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/AppNotificationStack.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const ruleOf = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
    }

    expect(css).not.toMatch(/clip-path/)
    for (const selector of ['.app-notification-stack', '.app-notification-stack__cards', '.app-notification-stack__card', '.app-notification-stack__toggle-row']) {
      expect(ruleOf(selector), selector).not.toBe('')
      expect(ruleOf(selector), selector).not.toMatch(/opacity|filter/)
    }
    const covered = ruleOf(".app-notification-stack__card[data-covered='true'] > .app-alert")
    expect(covered).toMatch(/background:\s*#[0-9a-f]{6};/i)
    expect(covered).toMatch(/backdrop-filter:\s*none;/)
    expect(ruleOf(".app-notification-stack__card[data-covered='true'] > .app-alert > *")).toMatch(/opacity:\s*0;/)
    expect(css).toMatch(/transition:\s*opacity 140ms/)
    expect(ruleOf(".app-notification-stack__card[data-covered='true']")).toMatch(/height:\s*var\(--stack-front-height/)
  })

  test('切换按钮按下缩到 .93,选择器比全局的 button:active 更具体', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/AppNotificationStack.css'), 'utf8')
    expect(css).toMatch(/\.app-notification-stack__toggle:not\(:disabled\):active\s*\{\s*scale:\s*0\.93;/)
  })
})

describe('向卡片提供堆叠上下文', () => {
  const CoveredProbe = ({ id }: { id: string }) => <span data-testid={id}>{String(useContext(NotificationStackCardContext)?.covered)}</span>
  const covered = () => ['probe-0', 'probe-1', 'probe-2'].map((id) => screen.getByTestId(id).textContent)

  test('收起时只有第 1 张不是被盖住的,展开后都不是', async () => {
    const user = userEvent.setup()
    render(<AppNotificationStack>{[0, 1, 2].map((index) => <CoveredProbe key={index} id={`probe-${index}`} />)}</AppNotificationStack>)

    expect(covered()).toEqual(['false', 'true', 'true'])
    await user.click(screen.getByRole('button', { name: '全部 3 条' }))
    expect(covered()).toEqual(['false', 'false', 'false'])
  })
})

test('--stack-front-height 取最前面那张卡的高度,被盖住的卡据此对齐', () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.getAttribute('data-front') === 'true' ? 64 : 0
    return { top: 0, right: 0, bottom: height, left: 0, width: 0, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  try {
    const { container } = render(<AppNotificationStack>{alerts(3)}</AppNotificationStack>)
    expect(container.querySelector<HTMLElement>('.app-notification-stack')!.style.getPropertyValue('--stack-front-height')).toBe('64px')
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})

test('不传 onOverflow 时无论多挤都不淘汰', async () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.classList.contains('app-notification-stack__card') ? 400 : 0
    return { top: 0, right: 0, bottom: height, left: 0, width: 0, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  try {
    render(<div className="app-main"><AppNotificationStack>{alerts(5)}</AppNotificationStack></div>)
    await userEvent.click(screen.getByRole('button', { name: '全部 5 条' }))
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.getAllByRole('status')).toHaveLength(5)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})
