import { fireEvent, render, screen } from '@testing-library/react'
import { OverflowTooltip } from './OverflowTooltip'

function setSize(element: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
  element.getBoundingClientRect = () => ({
    x: 12, y: 20, left: 12, top: 20, right: 92, bottom: 36, width: 80, height: 16,
    toJSON: () => ({}),
  } as DOMRect)
}

test('shows the custom tooltip only when the label actually overflows', () => {
  render(<OverflowTooltip testId="label" text="a very long model name" />)
  const label = screen.getByTestId('label').querySelector('.overflow-tooltip__label') as HTMLElement

  setSize(label, { scrollWidth: 180, clientWidth: 60 })
  fireEvent.mouseEnter(screen.getByTestId('label'))
  expect(screen.getByRole('tooltip')).toHaveTextContent('a very long model name')

  fireEvent.mouseLeave(screen.getByTestId('label'))
})

test('does not render a tooltip for fitting text', () => {
  render(<OverflowTooltip testId="label" text="short" />)
  const label = screen.getByTestId('label').querySelector('.overflow-tooltip__label') as HTMLElement

  setSize(label, { scrollWidth: 40, clientWidth: 80 })
  fireEvent.mouseEnter(screen.getByTestId('label'))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
