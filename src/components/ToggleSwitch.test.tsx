import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToggleSwitch } from './ToggleSwitch'

function Harness({ tone, indicator }: { tone?: 'accent' | 'success'; indicator?: boolean }) {
  const [on, setOn] = useState(false)
  return <ToggleSwitch label="用点点" tone={tone} indicator={indicator} checked={on} onChange={setOn} testId="sw" />
}

describe('ToggleSwitch', () => {
  test('点标签或开关都会切换,读屏看到的是带名字的开关', async () => {
    render(<Harness />)
    const toggle = screen.getByRole('switch', { name: '用点点' })
    expect(toggle).not.toBeChecked()

    await userEvent.click(screen.getByText('用点点'))
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(toggle).not.toBeChecked()
  })

  test('tone 决定打开时的配色,状态小点按需出现', () => {
    const { container, rerender } = render(<Harness tone="success" />)
    expect(container.querySelector('.toggle-switch')).toHaveClass('is-success')
    expect(container.querySelector('.toggle-switch-indicator')).toBeNull()

    rerender(<Harness indicator />)
    expect(container.querySelector('.toggle-switch')).toHaveClass('is-accent')
    expect(container.querySelector('.toggle-switch-indicator')).not.toBeNull()
  })

  test('文字可以是节点,读屏名字用 ariaLabel', async () => {
    render(<ToggleSwitch label={<span>用<b>模型</b></span>} ariaLabel="用模型" checked={false} onChange={() => {}} />)
    expect(screen.getByRole('switch', { name: '用模型' })).not.toBeChecked()
    expect(screen.getByText('模型')).toBeInTheDocument()
  })
})
