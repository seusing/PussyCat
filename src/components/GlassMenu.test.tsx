import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlassCombobox, GlassMultiSelect, GlassSelect, useGlassMenuSurface, type GlassOption } from './GlassMenu'

const OPTIONS: GlassOption[] = [
  { value: 'one', label: 'One', group: 'Numbers' },
  { value: 'two', label: 'Two', group: 'Numbers', disabled: true },
  { value: 'three', label: 'Three', group: 'More' },
]
const originalInnerWidth = window.innerWidth
const originalInnerHeight = window.innerHeight

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

beforeEach(() => {
  setReducedMotion(false)
  window.Hyalite.supported = vi.fn(() => false)
  window.Hyalite.attach = vi.fn()
  window.Hyalite.detach = vi.fn()
})

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
})

describe('GlassSelect', () => {
  it('renders its listbox in a portal and selects with pointer input', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <div><GlassSelect aria-label="Number" value="one" onChange={onChange} options={OPTIONS} /></div>,
    )

    await user.click(screen.getByRole('combobox', { name: 'Number' }))
    const listbox = screen.getByRole('listbox', { name: 'Number' })
    expect(document.body).toContainElement(listbox)
    expect(container).not.toContainElement(listbox)
    expect(screen.getByRole('option', { name: 'Two' })).toBeDisabled()
    await user.click(screen.getByRole('option', { name: 'Three' }))
    expect(onChange).toHaveBeenCalledWith('three')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('supports keyboard navigation, skips disabled options, and restores trigger focus', async () => {
    const onChange = vi.fn()
    render(<GlassSelect aria-label="Number" value="one" onChange={onChange} options={OPTIONS} />)
    const trigger = screen.getByRole('combobox', { name: 'Number' })

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('option', { name: 'One' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Three' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('three')
    await waitFor(() => expect(trigger).toHaveFocus())

    fireEvent.keyDown(trigger, { key: 'End' })
    await waitFor(() => expect(screen.getByRole('option', { name: 'Three' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes with Escape on the trigger before focus moves into the listbox', () => {
    render(<GlassSelect aria-label="Number" value="one" onChange={vi.fn()} options={OPTIONS} />)
    const trigger = screen.getByRole('combobox', { name: 'Number' })

    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: 'Number' })).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Number' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('closes for outside pointer input and Tab', async () => {
    const user = userEvent.setup()
    render(<><GlassSelect aria-label="Number" value="one" onChange={vi.fn()} options={OPTIONS} /><button>Outside</button></>)
    const trigger = screen.getByRole('combobox', { name: 'Number' })
    await user.click(trigger)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.click(trigger)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('clamps the portal surface into a narrow viewport and opens upward when needed', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 180 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 220 })
    render(<GlassSelect aria-label="Number" value="one" onChange={vi.fn()} options={OPTIONS} />)
    const trigger = screen.getByRole('combobox', { name: 'Number' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 150, y: 185, top: 185, right: 210, bottom: 213, left: 150, width: 60, height: 28, toJSON: () => ({}),
    })
    await user.click(trigger)
    const listbox = screen.getByRole('listbox')
    Object.defineProperties(listbox, { scrollHeight: { configurable: true, value: 120 }, scrollWidth: { configurable: true, value: 220 } })
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(Number.parseFloat(listbox.style.left)).toBeGreaterThanOrEqual(8)
      expect(Number.parseFloat(listbox.style.left) + Number.parseFloat(listbox.style.width)).toBeLessThanOrEqual(172)
      expect(Number.parseFloat(listbox.style.top)).toBeLessThan(185)
    })
  })
})

describe('GlassMultiSelect', () => {
  it('keeps the portal open, numbers selections, compacts removal, and appends reselection', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<GlassMultiSelect aria-label="Priority" value={['one', 'three']} onChange={onChange} options={OPTIONS} />)
    const trigger = screen.getByRole('combobox', { name: 'Priority' })
    expect(trigger).toHaveTextContent('已选 2 个')
    await user.click(trigger)
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true')
    const firstOption = screen.getByRole('option', { name: /One/ })
    expect(firstOption.firstElementChild).toHaveClass('glass-multi-check')
    expect(firstOption.lastElementChild).toHaveTextContent('One')
    expect(firstOption.querySelector('[data-priority="1"]')).not.toBeNull()
    await user.click(screen.getByRole('option', { name: /One/ }))
    expect(onChange).toHaveBeenLastCalledWith(['three'])
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    rerender(<GlassMultiSelect aria-label="Priority" value={['three']} onChange={onChange} options={OPTIONS} />)
    expect(screen.getByRole('option', { name: /Three/ }).querySelector('[data-priority="1"]')).not.toBeNull()
    await user.click(screen.getByRole('option', { name: /One/ }))
    expect(onChange).toHaveBeenLastCalledWith(['three', 'one'])
  })

  it('focuses on pointer open, skips disabled options, toggles by keyboard, and closes normally', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<><GlassMultiSelect aria-label="Priority" value={[]} onChange={onChange} options={OPTIONS} /><button>Outside</button></>)
    const trigger = screen.getByRole('combobox', { name: 'Priority' })
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('option', { name: /One/ })).toHaveFocus())
    expect(screen.getByRole('option', { name: /Two/ })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('option', { name: /Three/ })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('listbox'), { key: ' ' })
    expect(onChange).toHaveBeenCalledWith(['three'])
    expect(screen.getByRole('option', { name: /Three/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.click(trigger)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('GlassCombobox', () => {
  it('keeps free input, filters suggestions, and selects by keyboard', async () => {
    const user = userEvent.setup()
    let value = ''
    const onChange = vi.fn((next: string) => { value = next })
    const { rerender } = render(<GlassCombobox aria-label="Model" value={value} onChange={onChange} options={OPTIONS} />)
    const input = screen.getByRole('combobox', { name: 'Model' })
    await user.type(input, 'thr')
    expect(onChange).toHaveBeenLastCalledWith('r')
    value = 'thr'
    rerender(<GlassCombobox aria-label="Model" value={value} onChange={onChange} options={OPTIONS} />)
    expect(screen.getByRole('option', { name: 'Three' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'One' })).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('three')
  })

  it('keeps the portal positioned when a query changes from no matches to matches', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<GlassCombobox aria-label="Model" value="custom-model" onChange={onChange} options={OPTIONS} />)
    const input = screen.getByRole('combobox', { name: 'Model' })
    await user.click(input)
    const listbox = screen.getByRole('listbox')
    expect(screen.getByText('无匹配建议')).toBeVisible()
    expect(input).toHaveValue('custom-model')
    rerender(<GlassCombobox aria-label="Model" value="thr" onChange={onChange} options={OPTIONS} />)
    expect(screen.getByRole('option', { name: 'Three' })).toBeVisible()
    expect(listbox.style.visibility).toBe('visible')
  })
})

describe('useGlassMenuSurface', () => {
  function Surface({ active }: { active: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    useGlassMenuSurface(ref, active)
    return <div ref={ref}>Surface</div>
  }

  it('attaches only while active and detaches immediately', () => {
    window.Hyalite.supported = vi.fn(() => true)
    const { rerender, unmount } = render(<Surface active={false} />)
    expect(window.Hyalite.attach).not.toHaveBeenCalled()
    rerender(<Surface active />)
    const element = screen.getByText('Surface')
    expect(window.Hyalite.attach).toHaveBeenCalledWith(element, expect.objectContaining({
      bevel: 4, thickness: 2, slope: 0.30, shade: 0, edgeW: 0.5, rim: 2,
      blur: 4.5, dispersion: 0.8, light: -55, materialize: 120, settle: 90,
    }))
    unmount()
    expect(window.Hyalite.detach).toHaveBeenCalledWith(element)
  })

  it('uses immediate, non-dispersive settings for reduced motion', () => {
    setReducedMotion(true)
    window.Hyalite.supported = vi.fn(() => true)
    render(<Surface active />)
    expect(window.Hyalite.attach).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      materialize: 0,
      settle: 0,
      dispersion: 0,
    }))
  })

  it('leaves unsupported engines on the CSS fallback', () => {
    render(<Surface active />)
    expect(window.Hyalite.attach).not.toHaveBeenCalled()
  })
})
