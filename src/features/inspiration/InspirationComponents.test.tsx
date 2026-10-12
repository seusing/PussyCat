import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it.each([['a', 0], ['e', 4]])('opens the site of a side carousel card (%s) on the first click', (id, index) => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId(`site-row-${id}`))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[index])
  })

  it('opens the site of the centered carousel card on the first click', () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    const center = screen.getByTestId('site-row-c')
    expect(center).toHaveAttribute('data-selected', 'true')
    fireEvent.click(center)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sites[2])
  })

  it('opens the clicked card on the first click right after the arrow or dots reposition the strip', () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    // 条带还在滑动,不等待
    fireEvent.click(screen.getByRole('button', { name: '下一个站点' }))
    fireEvent.click(screen.getByTestId('site-row-d'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith(sites[3])

    fireEvent.click(screen.getByRole('button', { name: '定位到 A' }))
    fireEvent.click(screen.getByTestId('site-row-a'))
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenLastCalledWith(sites[0])

    fireEvent.click(screen.getByTestId('site-row-c'))
    expect(onSelect).toHaveBeenCalledTimes(3)
    expect(onSelect).toHaveBeenLastCalledWith(sites[2])
  })

  it('swallows the second click of a double click that lands on the page after a card opens the site', () => {
    const spy = vi.fn()
    render(
      <>
        <SiteCarousel sites={sites} onSelect={vi.fn()} />
        <button type="button" onClick={spy}>下方按钮</button>
      </>,
    )
    const button = screen.getByRole('button', { name: '下方按钮' })

    fireEvent.click(screen.getByTestId('site-row-a'))
    fireEvent.click(button, { detail: 2 })
    expect(spy).not.toHaveBeenCalled()

    fireEvent.click(button, { detail: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('lets an ordinary click right after a card opens the site through', () => {
    const spy = vi.fn()
    render(
      <>
        <SiteCarousel sites={sites} onSelect={vi.fn()} />
        <button type="button" onClick={spy}>下方按钮</button>
      </>,
    )

    fireEvent.click(screen.getByTestId('site-row-a'))
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
    <InspirationPanel onRun={() => {}} onCancel={() => {}} onRerun={() => {}} />,
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
    <InspirationPanel onRun={() => {}} onCancel={() => {}} onRerun={() => {}} />,
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
