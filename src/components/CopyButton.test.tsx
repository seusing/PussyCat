import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from './CopyButton'

test('复制成功时更新文案并切换到可访问的完成图标状态', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<CopyButton label="复制命令" getText={() => 'opencli x y'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  expect(button).toHaveAttribute('data-variant', 'copy')
  expect(button).toHaveAttribute('data-state', 'copy')
  expect(button).toHaveAttribute('data-icon', 'copy')
  expect(button).toHaveAttribute('aria-pressed', 'false')

  await userEvent.click(button)
  expect(writeText).toHaveBeenCalledWith('opencli x y')
  await waitFor(() => {
    expect(button).toHaveTextContent('已复制')
    expect(button).toHaveAttribute('data-state', 'check')
    expect(button).toHaveAttribute('data-icon', 'check')
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })
})

test('复制失败时显示失败文案并保留复制图标语义', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as Document & { execCommand?: () => boolean }).execCommand = () => false
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  await userEvent.click(button)
  await waitFor(() => {
    expect(button).toHaveTextContent('复制失败')
    expect(button).toHaveAttribute('data-state', 'copy')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
})

test('1.5 秒后恢复原始文案和图标状态', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<CopyButton label="复制命令" getText={() => 'x'} testid="copy-x" />)

  const button = screen.getByTestId('copy-x')
  await userEvent.click(button)
  await waitFor(() => expect(button).toHaveTextContent('已复制'))
  await waitFor(() => {
    expect(button).toHaveTextContent('复制命令')
    expect(button).toHaveAttribute('data-state', 'copy')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  }, { timeout: 2500 })
})
