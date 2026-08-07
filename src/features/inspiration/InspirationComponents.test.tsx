import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActivityWheel } from './ActivityWheel'
import { FisheyeCommandList } from './FisheyeCommandList'
import { SiteCarousel } from './SiteCarousel'
import type { SupportedSite } from '../../data/supportedSites'
import type { CommandManifest } from '../../data/types'

const sites: SupportedSite[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
  id,
  keys: [id],
  label: id.toUpperCase(),
  eyebrow: id,
  logo: `/site-logos/${id}.svg`,
  tint: '#8b5cf6',
  description: id,
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
    expect(clip?.firstElementChild).toHaveClass('fisheye-command-detail')
    expect(screen.getByRole('button', { name: '运行任务：进入命令详情' })).toHaveTextContent('进入命令详情')
  })
})
