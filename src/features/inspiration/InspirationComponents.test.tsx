import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActivityWheel } from './ActivityWheel'
import { FisheyeCommandList } from './FisheyeCommandList'
import { SiteCarousel } from './SiteCarousel'
import { InspirationPanel } from './InspirationPanel'
import { InspirationFileCard } from './InspirationLibraryCards'
import type { InspirationItem } from './inspirationLibrary'
import type { SupportedSite } from '../../data/supportedSites'
import type { CommandManifest } from '../../data/types'
import { useAppStore } from '../../store/appStore'
import { RUN_PANE_DEFAULT, RUN_PANE_MAX, RUN_PANE_MIN, loadLayout, saveRunPaneLayout } from '../../data/layout'

const sites: SupportedSite[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
  id,
  keys: [id],
  label: id.toUpperCase(),
  eyebrow: id,
  logo: `/site-logos/${id}.svg`,
  tint: '#8b5cf6',
  description: id,
}))

const commands: CommandManifest[] = ['read', 'write'].map((name) => ({
  command: `site/${name}`,
  site: 'site',
  name,
  description: `${name} one item`,
  access: name === 'write' ? 'write' : 'read',
  browser: true,
  args: [],
}))

// 条带位移取自 motion 写在 strip 上的 transform;离目标不到半张卡(80px)时,卡片才接受点击。
const stripArrived = (index: number) => waitFor(() => {
  const transform = screen.getByTestId('site-carousel').querySelector<HTMLElement>('.site-carousel-strip')!.style.transform
  const offset = transform.startsWith('translateX(') ? parseFloat(transform.slice('translateX('.length)) : 0
  expect(Math.abs(offset + index * 160)).toBeLessThan(80)
}, { timeout: 3000 })

describe('inspiration selectors', () => {
  it('keeps file-card delete confirmation separate from opening and cancels with Escape', async () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn(() => true)
    const item: InspirationItem = {
      id: 'note-1', title: '待整理', content: '', kind: 'note', format: 'md', folderId: null,
      source: '', createdAt: 1, updatedAt: 1,
    }
    render(<InspirationFileCard item={item} selected={false} formattedDate="2026/09/20" onOpen={onOpen} onDelete={onDelete} />)

    const open = screen.getByTestId('inspiration-item-note-1')
    expect(open.tagName).toBe('BUTTON')
    expect(open.parentElement?.tagName).toBe('DIV')
    fireEvent.click(screen.getByRole('button', { name: '删除笔记 待整理' }))
    expect(await screen.findByRole('button', { name: '确认删除 待整理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认删除 待整理' })).not.toHaveTextContent('确认')
    expect(screen.getByRole('button', { name: '取消删除' })).not.toHaveTextContent('取消')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByRole('button', { name: '删除笔记 待整理' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认删除 待整理' })).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('opens the site of the selected carousel card on the first click once the strip has arrived', async () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    const center = screen.getByTestId('site-row-c')
    expect(center).toHaveAttribute('data-selected', 'true')
    await stripArrived(2)
    fireEvent.click(center)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[2])
  })

  it.each([['a', 0], ['e', 4]])('only selects a side carousel card (%s) on click and opens it on the next click', async (id, index) => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)
    await stripArrived(2)

    const card = screen.getByTestId(`site-row-${id}`)
    fireEvent.click(card)
    expect(card).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('site-row-c')).toHaveAttribute('data-selected', 'false')
    expect(onSelect).not.toHaveBeenCalled()

    await stripArrived(index)
    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[index])
  })

  it('ignores card clicks while the strip is still far from its target', async () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    // 刚挂载,条带还在从起点滑向居中位置
    fireEvent.click(screen.getByTestId('site-row-c'))
    fireEvent.click(screen.getByTestId('site-row-a'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByTestId('site-row-c')).toHaveAttribute('data-selected', 'true')

    // 点侧边卡后条带离新目标整整一张卡,继续点任何卡都不生效
    await stripArrived(2)
    fireEvent.click(screen.getByTestId('site-row-b'))
    fireEvent.click(screen.getByTestId('site-row-d'))
    fireEvent.click(screen.getByTestId('site-row-b'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByTestId('site-row-b')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('site-row-d')).toHaveAttribute('data-selected', 'false')

    await stripArrived(1)
    fireEvent.click(screen.getByTestId('site-row-b'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[1])
  })

  it('ignores the repeated clicks of a multi-click on any carousel card', async () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)
    await stripArrived(2)

    fireEvent.click(screen.getByTestId('site-row-a'), { detail: 2 })
    expect(screen.getByTestId('site-row-c')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('site-row-a')).toHaveAttribute('data-selected', 'false')

    fireEvent.click(screen.getByTestId('site-row-c'), { detail: 2 })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens the new selected card on the first click once the strip is within half a card of it after an arrow', async () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)
    await stripArrived(2)

    fireEvent.click(screen.getByRole('button', { name: '下一个站点' }))
    fireEvent.click(screen.getByTestId('site-row-d'))
    expect(onSelect).not.toHaveBeenCalled()

    await stripArrived(3)
    fireEvent.click(screen.getByTestId('site-row-d'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[3])
  })

  it('swallows the second click of a double click that lands on the page after a card opens the site', async () => {
    const spy = vi.fn()
    render(
      <>
        <SiteCarousel sites={sites} onSelect={vi.fn()} />
        <button type="button" onClick={spy}>下方按钮</button>
      </>,
    )
    const button = screen.getByRole('button', { name: '下方按钮' })
    await stripArrived(2)

    fireEvent.click(screen.getByTestId('site-row-c'))
    fireEvent.click(button, { detail: 2 })
    expect(spy).not.toHaveBeenCalled()

    fireEvent.click(button, { detail: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('lets an ordinary click right after a card opens the site through', async () => {
    const spy = vi.fn()
    render(
      <>
        <SiteCarousel sites={sites} onSelect={vi.fn()} />
        <button type="button" onClick={spy}>下方按钮</button>
      </>,
    )
    await stripArrived(2)

    fireEvent.click(screen.getByTestId('site-row-c'))
    fireEvent.click(screen.getByRole('button', { name: '下方按钮' }), { detail: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('lets the arrow and dot controls reposition the carousel without opening anything', () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: '下一个站点' }))
    expect(screen.getByTestId('site-row-d')).toHaveAttribute('data-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '定位到 A' }))
    expect(screen.getByTestId('site-row-a')).toHaveAttribute('data-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders nothing for an empty site list', () => {
    const { container } = render(<SiteCarousel sites={[]} onSelect={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('advances exactly one wheel item for a large wheel delta', () => {
    const onSelect = vi.fn()
    render(<ActivityWheel sites={sites} onSelect={onSelect} />)

    fireEvent.wheel(screen.getByTestId('activity-wheel'), { deltaY: 240 })
    expect(screen.getByTestId('wheel-site-e')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('wheel-site-d')).toHaveAttribute('aria-pressed', 'false')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('centers a non-active wheel logo first, then opens it on the second click', () => {
    const onSelect = vi.fn()
    render(<ActivityWheel sites={sites} onSelect={onSelect} />)

    const first = screen.getByTestId('wheel-site-a')
    fireEvent.click(first)
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(onSelect).not.toHaveBeenCalled()
    const activeBeam = first.querySelector<HTMLElement>('.activity-wheel-beam[data-active]')
    expect(activeBeam?.style.getPropertyValue('--beam-strength')).toBe('1')

    fireEvent.click(first)
    expect(onSelect).toHaveBeenCalledWith(sites[0])
  })

  it('keeps the animated height clip separate from command-detail layout', () => {
    const command: CommandManifest = {
      command: 'site/read',
      site: 'site',
      name: 'read',
      description: 'Read one item',
      access: 'read',
      browser: true,
      args: [],
    }
    const { container } = render(<FisheyeCommandList commands={[command]} onSubmit={vi.fn()} />)

    const clip = container.querySelector('.fisheye-command-detail-clip')
    expect(clip?.firstElementChild).toHaveClass('fisheye-command-detail-shell')
    expect(clip?.firstElementChild?.firstElementChild).toHaveClass('fisheye-command-detail')
    expect(clip).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('button', { name: '运行任务：进入命令详情' })).toHaveTextContent('进入命令详情')
  })

  it('keeps command detail nodes mounted while pointer movement changes the active row', () => {
    render(<FisheyeCommandList commands={commands} onSubmit={vi.fn()} />)

    const rowA = screen.getByTestId('command-row-site/read')
    const rowB = screen.getByTestId('command-row-site/write')
    const headerA = rowA.querySelector('.fisheye-command-header')
    const headerB = rowB.querySelector('.fisheye-command-header')
    const clipA = rowA.querySelector('.fisheye-command-detail-clip')
    const clipB = rowB.querySelector('.fisheye-command-detail-clip')
    const buttonA = screen.getByTestId('open-command-site/read')
    const buttonB = screen.getByTestId('open-command-site/write')

    fireEvent.mouseMove(rowA)
    expect(rowB.querySelector('.fisheye-command-detail-clip')).toBe(clipB)
    fireEvent.mouseMove(rowB)
    expect(rowB.querySelector('.fisheye-command-detail-clip')).toBe(clipB)
    fireEvent.mouseMove(rowA)
    expect(rowB.querySelector('.fisheye-command-detail-clip')).toBe(clipB)
    fireEvent.mouseMove(rowB)

    expect(rowB.querySelector('.fisheye-command-detail-clip')).toBe(clipB)
    expect(headerB).toHaveAttribute('aria-expanded', 'true')
    expect(headerA).toHaveAttribute('aria-expanded', 'false')
    expect(clipB).toHaveAttribute('data-active', 'true')
    expect(clipB).toHaveAttribute('aria-hidden', 'false')
    expect(buttonB).not.toHaveAttribute('tabindex')
    expect(clipA).toHaveAttribute('data-active', 'false')
    expect(clipA).toHaveAttribute('aria-hidden', 'true')
    expect(buttonA).toHaveAttribute('tabindex', '-1')

    fireEvent.mouseEnter(rowA)
    expect(headerB).toHaveAttribute('aria-expanded', 'true')
    expect(headerA).toHaveAttribute('aria-expanded', 'false')

    fireEvent.mouseMove(rowA)
    expect(headerA).toHaveAttribute('aria-expanded', 'true')
    expect(headerB).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('inspiration workspace link', () => {
  const renderPanel = () => render(
    <InspirationPanel onRun={() => {}} onCancel={() => {}} />,
  )

  it('execute 页使用无文字的固定尺寸灵感库图标按钮', () => {
    useAppStore.setState({ commands: [commands[0]], selected: commands[0] })
    renderPanel()

    const button = screen.getByTestId('open-inspiration-library')
    expect(button).toHaveAttribute('aria-label', '打开灵感库')
    expect(button).toHaveAttribute('title', '打开灵感库')
    expect(button.textContent).toBe('')
    expect(button).toHaveClass('inspiration-workspace-link')
  })

  it('commands 页使用同一灵感库图标按钮', () => {
    useAppStore.setState({ commands: [commands[0]], selected: commands[0] })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    const button = screen.getByTestId('open-inspiration-library')
    expect(button).toHaveAttribute('aria-label', '打开灵感库')
    expect(button.textContent).toBe('')
    expect(button).toHaveClass('inspiration-workspace-link')
  })
})

describe('inspiration execute header', () => {
  it('头部没有稍后查看/收藏按钮,保留收进灵感库', () => {
    useAppStore.setState({ commands: [commands[0]], selected: commands[0] })
    render(<InspirationPanel onRun={() => {}} onCancel={() => {}} />)

    expect(screen.queryByTestId('fav-site')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fav-command')).not.toBeInTheDocument()
    expect(screen.getByTestId('save-command-to-inspiration-library')).toBeInTheDocument()
  })

  it('访问标签显示「只读」/「写入」,不出现 read/write 原文,写入带 is-write', () => {
    const readCommand: CommandManifest = { ...commands[0], command: 'site/browse', name: 'browse', description: '示例', browser: false }
    const writeCommand: CommandManifest = { ...readCommand, command: 'site/post', name: 'post', access: 'write' }
    const header = () => within(screen.getByTestId('command-header'))

    useAppStore.setState({ commands: [readCommand, writeCommand], selected: readCommand })
    const { unmount } = render(<InspirationPanel onRun={() => {}} onCancel={() => {}} />)
    expect(header().getByText('只读')).toHaveClass('inspiration-command-tag')
    expect(header().getByText('只读')).not.toHaveClass('is-write')
    expect(header().queryByText('read')).not.toBeInTheDocument()
    expect(header().queryByText('READ')).not.toBeInTheDocument()
    expect(header().queryByText('浏览器')).not.toBeInTheDocument()
    unmount()

    useAppStore.setState({ selected: { ...writeCommand, browser: true } })
    render(<InspirationPanel onRun={() => {}} onCancel={() => {}} />)
    expect(header().getByText('写入')).toHaveClass('inspiration-command-tag', 'is-write')
    expect(header().queryByText('write')).not.toBeInTheDocument()
    expect(header().queryByText('WRITE')).not.toBeInTheDocument()
    expect(header().getByText('浏览器')).toHaveClass('inspiration-command-tag')
    expect(header().getByTestId('save-command-to-inspiration-library')).toBeInTheDocument()
    expect(screen.getByTestId('command-description')).toHaveTextContent('示例')
  })
})

describe('inspiration execute run pane', () => {
  const renderExecute = (props: Partial<Parameters<typeof InspirationPanel>[0]> = {}) => {
    useAppStore.setState({ commands: [commands[0]], selected: commands[0] })
    return render(<InspirationPanel onRun={() => {}} onCancel={() => {}} {...props} />)
  }
  // jsdom 没有 PointerEvent 构造器:手动造 MouseEvent 并改 type,与 ResizableSplit.test.tsx 同款写法。
  const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number) =>
    new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true })

  it('执行页在配置区与运行面板之间渲染分隔条,宽度默认取 RUN_PANE_DEFAULT', () => {
    renderExecute()

    const workspace = screen.getByTestId('col-config').parentElement!
    const separator = screen.getByTestId('separator-run-pane')
    expect(separator).toHaveAttribute('aria-label', '调整运行面板宽度')
    expect(separator).toHaveAttribute('aria-valuenow', String(RUN_PANE_DEFAULT))
    expect(separator).toHaveAttribute('aria-valuemin', String(RUN_PANE_MIN))
    expect(separator).toHaveAttribute('aria-valuemax', String(RUN_PANE_MAX))
    expect(Array.from(workspace.children)).toEqual([
      screen.getByTestId('col-config'), separator, screen.getByTestId('col-runs'),
    ])
    expect(workspace).toHaveAttribute('data-run-pane', 'shown')
    expect(workspace.style.getPropertyValue('--run-pane-width')).toBe(`${RUN_PANE_DEFAULT}px`)
  })

  it('已存的运行面板宽度在挂载时读入', () => {
    saveRunPaneLayout({ runPaneWidth: 700 })
    renderExecute()

    expect(screen.getByTestId('separator-run-pane')).toHaveAttribute('aria-valuenow', '700')
    expect(screen.getByTestId('col-config').parentElement!.style.getPropertyValue('--run-pane-width')).toBe('700px')
  })

  it('runPaneHidden 时没有分隔条和 col-runs,配置区独占整行', () => {
    renderExecute({ runPaneHidden: true })

    expect(screen.queryByTestId('separator-run-pane')).not.toBeInTheDocument()
    expect(screen.queryByTestId('col-runs')).not.toBeInTheDocument()
    expect(screen.getByTestId('col-config')).toBeInTheDocument()
    expect(screen.getByTestId('col-config').parentElement).toHaveAttribute('data-run-pane', 'hidden')
  })

  it('向左拖变宽,并在松手时才落盘', () => {
    renderExecute()
    const separator = screen.getByTestId('separator-run-pane')

    fireEvent(separator, pointer('pointerdown', 500))
    fireEvent(window, pointer('pointermove', 400))
    expect(separator).toHaveAttribute('aria-valuenow', String(RUN_PANE_DEFAULT + 100))
    expect(loadLayout().runPaneWidth).toBe(RUN_PANE_DEFAULT)

    fireEvent(window, pointer('pointerup', 400))
    expect(loadLayout().runPaneWidth).toBe(RUN_PANE_DEFAULT + 100)
  })

  it('宽度夹在 [RUN_PANE_MIN, RUN_PANE_MAX] 内;Home/End 跳到两端,双击恢复默认值', () => {
    renderExecute()
    const separator = screen.getByTestId('separator-run-pane')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', String(RUN_PANE_MAX))
    expect(loadLayout().runPaneWidth).toBe(RUN_PANE_MAX)

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', String(RUN_PANE_MIN))
    expect(loadLayout().runPaneWidth).toBe(RUN_PANE_MIN)

    fireEvent.doubleClick(separator)
    expect(separator).toHaveAttribute('aria-valuenow', String(RUN_PANE_DEFAULT))
    expect(loadLayout().runPaneWidth).toBe(RUN_PANE_DEFAULT)
  })

  it('进入/离开执行页时回报 onExecuteVisibleChange,卸载时回报 false', () => {
    useAppStore.setState({ commands: [commands[0]], selected: undefined })
    const onExecuteVisibleChange = vi.fn()
    const { unmount } = render(
      <InspirationPanel onRun={() => {}} onCancel={() => {}} onExecuteVisibleChange={onExecuteVisibleChange} />,
    )
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(false)

    act(() => { useAppStore.setState({ selected: commands[0] }) })
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    expect(screen.getByTestId('inspiration-commands')).toBeInTheDocument()
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(false)

    act(() => { useAppStore.setState({ selected: commands[1] }) })
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByTestId('open-inspiration-library'))
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByTestId('inspiration-sources-tab'))
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(true)

    unmount()
    expect(onExecuteVisibleChange).toHaveBeenLastCalledWith(false)
  })
})

describe('inspiration command search', () => {
  const likedCommand: CommandManifest = {
    command: 'xiaohongshu/liked',
    site: 'xiaohongshu',
    name: 'liked',
    description: 'Read liked notes',
    aliases: ['hearts'],
    access: 'read',
    browser: true,
    args: [],
  }
  const feedCommand: CommandManifest = {
    command: 'xiaohongshu/feed',
    site: 'xiaohongshu',
    name: 'feed',
    description: 'Browse the home feed',
    access: 'read',
    browser: true,
    args: [],
  }
  const renderPanel = () => render(
    <InspirationPanel onRun={() => {}} onCancel={() => {}} />,
  )

  afterEach(() => { act(() => { useAppStore.setState({ mode: 'demo' }) }) })

  it('shows the display-mode switch and the site carousel under the getting-started checklist', () => {
    useAppStore.setState({ mode: 'connected', commands: [likedCommand, feedCommand], selected: undefined })
    renderPanel()

    expect(screen.getByRole('group', { name: '站点展示方式' })).toContainElement(screen.getByTestId('open-inspiration-library'))
    expect(screen.getByTestId('display-mode-carousel')).toHaveAttribute('aria-pressed', 'true')
    const checklist = screen.getByTestId('getting-started')
    const carousel = screen.getByTestId('site-carousel')
    expect(checklist.compareDocumentPosition(carousel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('removes WeChat sources from the carousel and global command search', () => {
    const weixinCommand: CommandManifest = {
      ...likedCommand,
      command: 'weixin/articles',
      site: 'weixin',
      name: 'articles',
      description: 'Read Weixin articles',
    }
    const channelsCommand: CommandManifest = {
      ...likedCommand,
      command: 'wechat-channels/videos',
      site: 'wechat-channels',
      name: 'videos',
      description: 'Read WeChat Channels videos',
    }
    useAppStore.setState({
      commands: [weixinCommand, channelsCommand, likedCommand],
      selected: undefined,
    })
    renderPanel()

    expect(screen.queryByTestId('site-row-wechat')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-row-xiaohongshu')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('nav-search'), { target: { value: 'weixin' } })
    expect(screen.queryByTestId('command-row-weixin/articles')).not.toBeInTheDocument()
    expect(screen.queryByTestId('command-row-wechat-channels/videos')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: '没有匹配的命令' })).toBeInTheDocument()
  })

  it('filters a site command list by every user-visible command identity', () => {
    useAppStore.setState({ commands: [likedCommand, feedCommand], selected: likedCommand })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    const search = screen.getByTestId('nav-search')
    for (const query of ['liked', '  LiKeD  ', '点赞', 'Read liked', 'xiaohongshu/liked', 'hearts']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getByTestId('command-row-xiaohongshu/liked')).toBeInTheDocument()
      expect(screen.queryByTestId('command-row-xiaohongshu/feed')).not.toBeInTheDocument()
    }

    fireEvent.change(search, { target: { value: '   ' } })
    expect(screen.getByTestId('command-row-xiaohongshu/liked')).toBeInTheDocument()
    expect(screen.getByTestId('command-row-xiaohongshu/feed')).toBeInTheDocument()
  })

  it('shows the empty result state for an unmatched site command query', () => {
    useAppStore.setState({ commands: [likedCommand, feedCommand], selected: likedCommand })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    fireEvent.change(screen.getByTestId('nav-search'), { target: { value: 'not-a-command' } })
    expect(screen.queryByTestId('command-row-xiaohongshu/liked')).not.toBeInTheDocument()
    expect(screen.queryByTestId('command-row-xiaohongshu/feed')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: '没有匹配的命令' })).toHaveClass('empty-state')
    expect(screen.getByRole('status', { name: '没有匹配的命令' }).querySelector('.empty-state-icon')).toBeInTheDocument()
  })

  it('finds a command globally by its displayed Chinese description', () => {
    useAppStore.setState({ commands: [likedCommand, feedCommand], selected: likedCommand })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    fireEvent.click(screen.getByRole('button', { name: '返回站点' }))

    fireEvent.change(screen.getByTestId('nav-search'), { target: { value: '点赞' } })
    expect(screen.getByTestId('command-row-xiaohongshu/liked')).toBeInTheDocument()
    expect(screen.queryByTestId('command-row-xiaohongshu/feed')).not.toBeInTheDocument()
  })
})

describe('inspiration command tabs', () => {
  const tabCommands: CommandManifest[] = ['alpha', 'beta', 'gamma'].map((name) => ({
    command: `site/${name}`, site: 'site', name, description: `${name} cmd`, access: 'read', browser: true, args: [],
  }))
  const [alpha, beta, gamma] = tabCommands
  const resetStore = () => useAppStore.setState({
    commands: tabCommands, selected: undefined, values: {}, currentRun: undefined, backgroundTabs: [], activeTabSlot: 0,
  })
  const renderPanel = () => render(
    <InspirationPanel onRun={() => {}} onCancel={() => {}} onCloseTab={(key) => useAppStore.getState().closeTab(key)} />,
  )
  const openTabs = (...list: CommandManifest[]) => act(() => {
    for (const command of list) useAppStore.getState().selectCommand(command)
  })
  const selectedKey = () => useAppStore.getState().selected?.command

  beforeEach(() => { act(() => { resetStore() }) })
  afterEach(() => { act(() => { resetStore() }) })

  it('sites / commands / execute 三个阶段都显示标签栏,没有标签时不显示,灵感库工作区不显示', () => {
    renderPanel()
    expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    openTabs(alpha, beta)
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByTestId('command-tab-site/beta')).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    expect(screen.getByTestId('inspiration-commands')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2)
    // 不在执行页时没有标签处于选中态
    expect(screen.getByTestId('command-tab-site/beta')).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(screen.getByRole('button', { name: '返回站点' }))
    expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('open-inspiration-library'))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('点标签进入执行页并切换到该标签的命令,标签顺序不变', () => {
    renderPanel()
    openTabs(alpha, beta)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    fireEvent.click(screen.getByTestId('command-tab-site/alpha'))
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(screen.getByTestId('command-title')).toHaveTextContent('alpha')
    expect(selectedKey()).toBe('site/alpha')
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'command-tab-site/alpha', 'command-tab-site/beta',
    ])
    expect(screen.getByTestId('command-tab-site/alpha')).toHaveAttribute('aria-selected', 'true')
  })

  it('点当前标签也能从命令列表回到执行页', () => {
    renderPanel()
    openTabs(alpha)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    fireEvent.click(screen.getByTestId('command-tab-site/alpha'))
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
  })

  it('「+」回到站点页,标签保留', () => {
    renderPanel()
    openTabs(alpha)
    fireEvent.click(screen.getByTestId('new-command-tab'))
    expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
    expect(screen.getByTestId('command-tab-site/alpha')).toBeInTheDocument()
  })

  it('在 commands 阶段关当前标签:邻居顶上来,但不跳页', () => {
    renderPanel()
    openTabs(alpha, beta)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    fireEvent.click(screen.getByTestId('close-tab-site/beta'))
    expect(selectedKey()).toBe('site/alpha')
    expect(screen.getByTestId('inspiration-commands')).toBeInTheDocument()
    expect(screen.queryByTestId('inspiration-execute')).not.toBeInTheDocument()
  })

  it('在 sites 阶段关当前标签:不跳页', () => {
    renderPanel()
    openTabs(alpha, beta)
    fireEvent.click(screen.getByTestId('new-command-tab'))

    fireEvent.click(screen.getByTestId('close-tab-site/beta'))
    expect(selectedKey()).toBe('site/alpha')
    expect(screen.getByTestId('inspiration-sites')).toBeInTheDocument()
    expect(screen.queryByTestId('inspiration-execute')).not.toBeInTheDocument()
  })

  it('在 execute 阶段关当前标签:邻居顶上来并留在执行页', () => {
    renderPanel()
    openTabs(alpha, beta)
    fireEvent.click(screen.getByTestId('close-tab-site/beta'))
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(screen.getByTestId('command-title')).toHaveTextContent('alpha')
  })

  it('关后台标签不换页也不换当前命令', () => {
    renderPanel()
    openTabs(alpha, beta)
    fireEvent.click(screen.getByTestId('close-tab-site/alpha'))
    expect(selectedKey()).toBe('site/beta')
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(screen.queryByTestId('command-tab-site/alpha')).not.toBeInTheDocument()
  })

  it('在 execute 阶段关掉最后一个标签:回到该站点的命令列表', () => {
    renderPanel()
    openTabs(alpha)
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('close-tab-site/alpha'))
    expect(selectedKey()).toBeUndefined()
    expect(screen.getByTestId('inspiration-commands')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'site 命令' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('回到命令列表时清掉之前的搜索词,列表不被旧搜索筛空', () => {
    renderPanel()
    openTabs(alpha)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    fireEvent.change(screen.getByTestId('nav-search'), { target: { value: 'no-such-command' } })
    fireEvent.click(screen.getByTestId('command-tab-site/alpha'))
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('close-tab-site/alpha'))
    expect(screen.getByTestId('nav-search')).toHaveValue('')
    expect(screen.getByTestId('command-row-site/alpha')).toBeInTheDocument()
  })

  it('外部(如登录状态页)选中一条新命令时仍进入执行页', () => {
    renderPanel()
    openTabs(alpha)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))

    openTabs(gamma)
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(screen.getByTestId('command-title')).toHaveTextContent('gamma')
  })

  it('没接 onCloseTab 时关闭按钮不改变选中,之后的选择照常进入执行页', () => {
    render(<InspirationPanel onRun={() => {}} onCancel={() => {}} />)
    openTabs(alpha)
    fireEvent.click(screen.getByRole('button', { name: '返回命令集合' }))
    fireEvent.click(screen.getByTestId('close-tab-site/alpha'))
    expect(selectedKey()).toBe('site/alpha')

    openTabs(beta)
    expect(screen.getByTestId('inspiration-execute')).toBeInTheDocument()
    expect(screen.getByTestId('command-title')).toHaveTextContent('beta')
  })
})
