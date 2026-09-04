import { act, fireEvent, render, screen } from '@testing-library/react'

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

test('holds the startup layer until input, then restores engine speed after the exit fade', () => {
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
    const splash = screen.getByTestId('startup-splash')
    expect(splash).toHaveAttribute('aria-label', 'Press any key to continue')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(anime.engine.speed).toBe(0.35)
    expect(anime.animate).toHaveBeenCalled()
    expect(anime.scrambleText).toHaveBeenCalledWith({
      text: 'Press any key to continue',
      from: 'center',
      cursor: '_',
      seed: 7,
    })

    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('startup-splash')).toHaveClass('is-leaving')
    act(() => vi.advanceTimersByTime(560))
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument()
    expect(anime.engine.speed).toBe(1)
    expect(anime.revert).toHaveBeenCalledTimes(1)

    unmount()
  } finally {
    vi.useRealTimers()
  }
})
