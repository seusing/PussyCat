import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InfoTip } from './InfoTip'

describe('InfoTip', () => {
  test('默认不显示说明;悬停打开,移开后关闭', async () => {
    render(<InfoTip label="字段说明"><p>默认综合</p></InfoTip>)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: '字段说明' })
    await userEvent.hover(trigger)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('默认综合')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await userEvent.unhover(trigger)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  test('点击后固定,移开不关;Esc 关闭', async () => {
    render(<InfoTip label="字段说明"><p>默认综合</p></InfoTip>)
    const trigger = screen.getByRole('button', { name: '字段说明' })

    await userEvent.click(trigger)
    await userEvent.unhover(trigger)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  test('放在 <label> 里点击不会切换外层的复选框', async () => {
    render(
      <label htmlFor="box">
        开关<InfoTip label="开关说明"><p>说明</p></InfoTip>
        <input id="box" type="checkbox" />
      </label>,
    )
    await userEvent.click(screen.getByRole('button', { name: '开关说明' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
