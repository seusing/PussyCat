import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('./SplashCursor.jsx', () => ({
  default: ({ RAINBOW_MODE }: { RAINBOW_MODE?: boolean }) => (
    <canvas data-testid="splash-cursor" data-rainbow={String(RAINBOW_MODE)} />
  ),
}))

import { StartupSplash } from './StartupSplash'

test('holds the splash until input and then fades it out', () => {
  vi.useFakeTimers()

  try {
    const { unmount } = render(
      <StartupSplash>
        <main data-testid="app-content">app</main>
      </StartupSplash>,
    )

    expect(screen.getByTestId('app-content')).toBeInTheDocument()
    expect(screen.getByTestId('startup-splash')).toHaveAttribute('aria-label', 'Press any key to continue')
    expect(screen.getByTestId('splash-cursor')).toHaveAttribute('data-rainbow', 'true')

    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('startup-splash')).toHaveClass('is-leaving')
    act(() => vi.advanceTimersByTime(560))
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument()

    unmount()
  } finally {
    vi.useRealTimers()
  }
})
