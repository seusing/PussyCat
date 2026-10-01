import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('./Prism', () => ({
  default: ({ animationType }: { animationType?: string }) => <canvas data-testid="prism" data-animation={animationType} />,
}))

import { StartupSplash } from './StartupSplash'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('holds the splash until input and then fades it out', () => {
  vi.useFakeTimers()
  const { unmount } = render(
    <StartupSplash>
      <main data-testid="app-content">app</main>
    </StartupSplash>,
  )

  expect(screen.getByTestId('app-content')).toBeInTheDocument()
  const splash = screen.getByTestId('startup-splash')
  expect(splash).toHaveAttribute('aria-label', '按任意键进入爪爪')
  expect(splash).toHaveTextContent('爪爪')
  expect(splash).toHaveTextContent('按任意键进入')
  expect(screen.getByTestId('prism')).toHaveAttribute('data-animation', 'rotate')

  act(() => vi.advanceTimersByTime(3_000))
  expect(screen.getByTestId('startup-splash')).toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'Enter' })
  expect(screen.getByTestId('startup-splash')).toHaveClass('is-leaving')
  act(() => vi.advanceTimersByTime(560))
  expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument()

  unmount()
})

test('a click on the splash also enters the app', () => {
  vi.useFakeTimers()
  render(
    <StartupSplash>
      <main>app</main>
    </StartupSplash>,
  )

  fireEvent.pointerDown(screen.getByTestId('startup-splash'))
  expect(screen.getByTestId('startup-splash')).toHaveClass('is-leaving')
  act(() => vi.advanceTimersByTime(560))
  expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument()
})

test('skips the prism when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }))
  render(
    <StartupSplash>
      <main>app</main>
    </StartupSplash>,
  )

  expect(screen.getByTestId('startup-splash')).toHaveTextContent('按任意键进入')
  expect(screen.queryByTestId('prism')).not.toBeInTheDocument()
})
