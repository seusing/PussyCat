import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DotSuggestTip, type XhsParser } from './DotSuggestTip'

function Harness({ active, onChoose }: { active: boolean; onChoose: (choice: XhsParser) => void }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={anchorRef} data-testid="anchor"><textarea aria-label="链接" /></div>
      <button type="button">别处</button>
      <DotSuggestTip anchorRef={anchorRef} active={active} onChoose={onChoose} />
    </>
  )
}

describe('DotSuggestTip', () => {
  test('有小红书链接时停顿片刻才弹出,不抢输入框焦点;不再需要时收起', async () => {
    const { rerender } = render(<Harness active={false} onChoose={() => {}} />)
    const field = screen.getByRole('textbox', { name: '链接' })
    field.focus()

    rerender(<Harness active onChoose={() => {}} />)
    expect(screen.queryByTestId('vk-dot-tip')).not.toBeInTheDocument()
    const tip = await screen.findByTestId('vk-dot-tip')
    expect(tip).toHaveAttribute('role', 'dialog')
    expect(tip).toHaveAttribute('aria-modal', 'false')
    expect(tip).toHaveTextContent('用点点免费解析小红书链接？')
    expect(document.activeElement).toBe(field)

    rerender(<Harness active={false} onChoose={() => {}} />)
    await waitFor(() => expect(screen.queryByTestId('vk-dot-tip')).not.toBeInTheDocument())
  })

  test('点「用点点」选点点,点「用模型」选模型', async () => {
    const onChoose = vi.fn()
    render(<Harness active onChoose={onChoose} />)

    await userEvent.click(await screen.findByTestId('vk-dot-tip-dot'))
    await userEvent.click(screen.getByTestId('vk-dot-tip-model'))

    expect(onChoose.mock.calls).toEqual([['dot'], ['model']])
  })

  test('选定后贴士退场的那一下,紧接着的点击不会被当成「点在别处」', async () => {
    const onChoose = vi.fn()
    const { rerender } = render(<Harness active onChoose={onChoose} />)
    fireEvent.click(await screen.findByTestId('vk-dot-tip-dot'))
    rerender(<Harness active={false} onChoose={onChoose} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: '别处' }))

    expect(onChoose.mock.calls).toEqual([['dot']])
  })

  test('Esc 和点在别处都等于继续用模型;点回链接框不算', async () => {
    const onChoose = vi.fn()
    render(<Harness active onChoose={onChoose} />)
    await screen.findByTestId('vk-dot-tip')

    fireEvent.pointerDown(screen.getByRole('textbox', { name: '链接' }))
    expect(onChoose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(screen.getByRole('button', { name: '别处' }))
    expect(onChoose.mock.calls).toEqual([['model'], ['model']])
  })
})
