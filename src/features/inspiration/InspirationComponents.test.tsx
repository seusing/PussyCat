import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActivityWheel } from './ActivityWheel'
import { FisheyeCommandList } from './FisheyeCommandList'
import { SiteCarousel } from './SiteCarousel'
import { InspirationPanel } from './InspirationPanel'
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
  it('requires a second click after a non-center carousel card is centered', () => {
    const onSelect = vi.fn()
    render(<SiteCarousel sites={sites} onSelect={onSelect} />)

    const first = screen.getByTestId('site-row-a')
    fireEvent.click(first)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(first)
    expect(onSelect).toHaveBeenCalledWith(sites[0])
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
