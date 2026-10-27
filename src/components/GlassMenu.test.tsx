import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  const MODELS: GlassOption[] = [
    { value: 'a', label: 'Alpha', description: 'gpt-5 · api.alpha.com' },
    { value: 'b', label: 'Beta', description: 'claude-opus · api.beta.com' },
    { value: 'c', label: 'Gamma', description: 'kimi-k2 · api.gamma.com' },
    { value: 'd', label: 'Delta', description: 'qwen-max · api.delta.com' },
    { value: 'e', label: 'Stopped', description: 'old-model · api.stopped.com', disabled: true },
  ]
  const field = () => screen.getByTestId('field')
  const input = () => screen.getByRole('combobox', { name: 'Priority' })
  const tagOf = (name: string) => screen.getByRole('button', { name: `移除 ${name}` }).closest<HTMLElement>('.glass-multi-tag')!
  const renderField = (value: string[], onChange = vi.fn(), options = MODELS) => {
    const view = render(<GlassMultiSelect aria-label="Priority" data-testid="field" value={value} onChange={onChange} options={options} />)
    return { onChange, ...view }
  }

  it('puts testid, className, style and id on the field container and the aria-label on the combobox input', () => {
    render(<GlassMultiSelect aria-label="Priority" data-testid="field" id="route" className="custom text-sm" style={{ color: 'rgb(1, 2, 3)' }} value={[]} onChange={vi.fn()} options={MODELS} />)

    expect(field().tagName).toBe('DIV')
    expect(field()).toHaveAttribute('id', 'route')
    expect(field()).toHaveClass('glass-multi-field', 'custom', 'text-sm')
    expect(field()).toHaveStyle({ color: 'rgb(1, 2, 3)' })
    expect(input().tagName).toBe('INPUT')
    expect(input()).toHaveAttribute('aria-autocomplete', 'list')
    expect(input()).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows selections as numbered tags in priority order and hides the placeholder once something is selected', () => {
    const { rerender } = renderField([])
    expect(input()).toHaveAttribute('placeholder', '— 还没指定 —')

    rerender(<GlassMultiSelect aria-label="Priority" data-testid="field" value={['c', 'a']} onChange={vi.fn()} options={MODELS} />)
    expect(input()).not.toHaveAttribute('placeholder')
    expect(tagOf('Gamma')).toHaveTextContent('1Gamma')
    expect(tagOf('Gamma').querySelector('[data-priority="1"]')).not.toBeNull()
    expect(tagOf('Alpha')).toHaveTextContent('2Alpha')
    expect(field()).not.toHaveTextContent('已选')
  })

  it('folds tags beyond the third into +N and lists the folded names in its title', () => {
    renderField(['a', 'b', 'c', 'd', 'e'])

    expect(screen.getAllByRole('button', { name: /^移除 / })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '移除 Delta' })).not.toBeInTheDocument()
    const more = screen.getByText('+2')
    expect(more).toHaveAttribute('title', 'Delta、Stopped')
  })

  it('shows no +N for three or fewer selections', () => {
    renderField(['a', 'b', 'c'])
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('removes a tag with its × button, renumbers the rest, and does not open the menu', async () => {
    const user = userEvent.setup()
    const { onChange, rerender } = renderField(['a', 'b', 'c'])

    await user.click(screen.getByRole('button', { name: '移除 Alpha' }))
    expect(onChange).toHaveBeenCalledWith(['b', 'c'])
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input()).toHaveFocus()

    rerender(<GlassMultiSelect aria-label="Priority" data-testid="field" value={['b', 'c']} onChange={onChange} options={MODELS} />)
    expect(tagOf('Beta')).toHaveTextContent('1Beta')
    expect(tagOf('Gamma')).toHaveTextContent('2Gamma')
  })

  it('opens and closes by clicking the field and keeps the portal open while toggling', async () => {
    const user = userEvent.setup()
    const { onChange, rerender } = renderField(['a', 'c'])

    await user.click(field())
    const listbox = screen.getByRole('listbox', { name: 'Priority' })
    expect(document.body).toContainElement(listbox)
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true')
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    expect(field()).toHaveAttribute('data-open', 'true')

    await user.click(screen.getByRole('option', { name: /Alpha/ }))
    expect(onChange).toHaveBeenLastCalledWith(['c'])
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    rerender(<GlassMultiSelect aria-label="Priority" data-testid="field" value={['c']} onChange={onChange} options={MODELS} />)
    expect(screen.getByRole('option', { name: /Gamma/ }).querySelector('[data-priority="1"]')).not.toBeNull()
    await user.click(screen.getByRole('option', { name: /Alpha/ }))
    expect(onChange).toHaveBeenLastCalledWith(['c', 'a'])

    await user.click(field())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens when clicking the input, and clicking it again keeps the menu open', async () => {
    const user = userEvent.setup()
    renderField([])

    await user.click(input())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(input())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('shows priority badges only for selected options, with name and description lines', async () => {
    const user = userEvent.setup()
    renderField(['c', 'a'])
    await user.click(field())

    const gamma = screen.getByRole('option', { name: /Gamma/ })
    expect(gamma).toHaveAttribute('aria-selected', 'true')
    expect(gamma.querySelector('[data-priority="1"]')).toHaveTextContent('1')
    expect(gamma.querySelector('.glass-multi-option-label')).toHaveTextContent('Gamma')
    expect(gamma.querySelector('.glass-multi-option-desc')).toHaveTextContent('kimi-k2 · api.gamma.com')
    expect(screen.getByRole('option', { name: /Alpha/ }).querySelector('[data-priority="2"]')).toHaveTextContent('2')
    const beta = screen.getByRole('option', { name: /Beta/ })
    expect(beta).toHaveAttribute('aria-selected', 'false')
    expect(beta.querySelector('.glass-multi-check')).toBeNull()
  })

  it('omits the description line when an option has none', async () => {
    const user = userEvent.setup()
    renderField([], vi.fn(), OPTIONS)
    await user.click(field())

    expect(screen.getByRole('option', { name: /One/ }).querySelector('.glass-multi-option-desc')).toBeNull()
  })

  it('filters options by name or description, case-insensitively, and reports when nothing matches', async () => {
    const user = userEvent.setup()
    renderField([])
    await user.type(input(), 'BET')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Beta')])

    await user.clear(input())
    await user.type(input(), 'KIMI')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Gamma')])

    await user.clear(input())
    await user.type(input(), 'zzz')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的配置')).toBeVisible()
  })

  it('opens the menu as soon as the user types', async () => {
    const user = userEvent.setup()
    renderField([])

    await user.type(input(), 'a')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('removes the last tag on Backspace only while the input is empty', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField(['a', 'b'])

    await user.type(input(), 'x')
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).not.toHaveBeenCalled()

    await user.clear(input())
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['a'])
  })

  it('does nothing on Backspace with an empty input and no selection', () => {
    const { onChange } = renderField([])
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lists stopped options as disabled and never selects them', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField(['a'])
    await user.click(field())

    const stopped = screen.getByRole('option', { name: /Stopped.*（已停用）/ })
    expect(stopped).toBeDisabled()
    await user.click(stopped)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves the active option with arrows, Home and End (skipping stopped options) and toggles with Enter and Space', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField([])
    await user.click(field())
    const activeId = () => input().getAttribute('aria-activedescendant')
    const idOf = (name: RegExp) => screen.getByRole('option', { name }).id

    expect(activeId()).toBe(idOf(/Alpha/))
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(activeId()).toBe(idOf(/Beta/))
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(['b'])
    fireEvent.keyDown(input(), { key: 'End' })
    expect(activeId()).toBe(idOf(/Delta/))
    fireEvent.keyDown(input(), { key: ' ' })
    expect(onChange).toHaveBeenLastCalledWith(['d'])
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(activeId()).toBe(idOf(/Alpha/))
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(activeId()).toBe(idOf(/Delta/))
    fireEvent.keyDown(input(), { key: 'Home' })
    expect(activeId()).toBe(idOf(/Alpha/))
    expect(input()).toHaveFocus()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('starts on the first selected option when opened and opens from the keyboard', () => {
    renderField(['c'])
    input().focus()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(input()).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Gamma/ }).id)
  })

  it('types a space into the filter instead of toggling once a query exists', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField([], vi.fn(), [{ value: 'x', label: 'GPT 5.6 Luna' }, { value: 'y', label: 'Other' }])
    await user.type(input(), 'GPT 5')

    expect(input()).toHaveValue('GPT 5')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('closes with Escape, clears the filter and keeps focus in the input', async () => {
    const user = userEvent.setup()
    renderField([])
    await user.type(input(), 'bet')
    expect(screen.getAllByRole('option')).toHaveLength(1)

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input()).toHaveValue('')
    expect(input()).toHaveFocus()

    await user.click(field())
    expect(screen.getAllByRole('option')).toHaveLength(MODELS.length)
  })

  it('closes for Tab and outside pointer input', async () => {
    const user = userEvent.setup()
    render(<><GlassMultiSelect aria-label="Priority" value={[]} onChange={vi.fn()} options={MODELS} /><button>Outside</button></>)
    await user.type(input(), 'al')
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input()).toHaveValue('')

    await user.click(input())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('stays inert when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GlassMultiSelect aria-label="Priority" data-testid="field" disabled value={['a']} onChange={onChange} options={MODELS} />)
    await user.click(field())

    expect(input()).toBeDisabled()
    expect(screen.getByRole('button', { name: '移除 Alpha' })).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('falls back to the raw value for a selection that is no longer in the options', () => {
    renderField(['gone', 'a'])
    expect(tagOf('gone')).toHaveTextContent('1gone')
  })

  it('draws the focus outline on the whole field, not on the inner input', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'GlassMenu.css'), 'utf8')
    // 全局 input:focus-visible 的特异性高于 .glass-multi-input,必须用 :focus-visible 版本才压得住
    expect(css).toMatch(/\.glass-multi-input:focus-visible\s*\{[^}]*outline:\s*none;/)
    expect(css).toMatch(/\.glass-multi-field:focus-within\s*\{[^}]*border-color:\s*var\(--color-accent/)
    expect(css).toMatch(/\.glass-select-trigger:focus-visible[^{]*\{[^}]*border-color:\s*var\(--color-accent/)

    renderField([])
    expect(input().parentElement).toBe(field())
    expect(input()).toHaveClass('glass-multi-input')
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
      blur: 4.5, dispersion: 0.8, light: -55, materialize: 0, settle: 0,
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
