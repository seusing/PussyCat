import { act, render, screen } from '@testing-library/react'

const anime = vi.hoisted(() => {
  const engine = { speed: 1 }
  const animate = vi.fn()
  const scrambleText = vi.fn(() => () => 'scrambled')
  const revert = vi.fn()
  const createScope = vi.fn(() => {
    const scope = {
      add(callback: () => void) {
        callback()
        return scope
      },
      revert,
    }
    return scope
  })
  return { animate, createScope, engine, revert, scrambleText }
})

vi.mock('animejs', () => anime)

import { StartupSplash } from './StartupSplash'

test('shows the startup layer, scrambles the tagline, and restores engine speed on exit', () => {
  vi.useFakeTimers()
  anime.engine.speed = 1
  anime.animate.mockClear()
  anime.createScope.mockClear()
  anime.revert.mockClear()
  anime.scrambleText.mockClear()

  try {
    const { unmount } = render(
      <StartupSplash>
        <main data-testid="app-content">app</main>
      </StartupSplash>,
    )

    expect(screen.getByTestId('app-content')).toBeInTheDocument()
    expect(screen.getByTestId('startup-splash')).toHaveAttribute('aria-label', 'Let inspiration spark...')
    expect(anime.engine.speed).toBe(0.35)
    expect(anime.animate).toHaveBeenCalledTimes(4)
    expect(anime.scrambleText).toHaveBeenCalledWith({
      text: 'Let inspiration spark...',
      from: 'center',
      cursor: '_',
      seed: 7,
    })

    act(() => vi.advanceTimersByTime(2_400))
    expect(screen.getByTestId('startup-splash')).toHaveClass('is-leaving')
    act(() => vi.advanceTimersByTime(520))
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument()
    expect(anime.engine.speed).toBe(1)
    expect(anime.revert).toHaveBeenCalledTimes(1)

    unmount()
  } finally {
    vi.useRealTimers()
  }
})

